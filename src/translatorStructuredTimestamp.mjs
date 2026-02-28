import { PassThrough } from "stream";
import { z } from "zod";
import { JSONParser } from "@streamparser/json-node";
import log from "loglevel"

import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.mjs";
import { timestampToMilliseconds, millisecondsToTimestamp } from "./subtitle.mjs";

const timestampEntriesSchema = z.array(z.object({
    start: z.int(),
    end: z.int(),
    text: z.string()
})).describe("Subtitle entries with start and end as milliseconds")

/**
 * @typedef {{ start: string, end: string, text: string }} TimestampEntry
 * @typedef {z.infer<typeof timestampEntriesSchema>[number]} MsEntry
 */

/** @param {TimestampEntry} e @returns {MsEntry} */
const toMsEntry = (e) => ({ start: timestampToMilliseconds(e.start), end: timestampToMilliseconds(e.end), text: e.text })

/** @param {MsEntry} e @returns {TimestampEntry} */
const fromMsEntry = (e) => ({ start: millisecondsToTimestamp(e.start), end: millisecondsToTimestamp(e.end), text: e.text })

const singleTimestampSchema = z.object({
    outputs: timestampEntriesSchema
})

const batchTimestampSchema = z.object({
    outputs: timestampEntriesSchema,
    mergedRemarks: z.string().describe("MUST be empty if no merges! Otherwise: briefly explain why entries were merged.")
})

/**
 * @typedef {{ outputs: TimestampEntry[], mergedRemarks: string }} BatchTimestampOutput
 */

/**
 * @extends {TranslatorStructuredBase<TimestampEntry[]>}
 */
export class TranslatorStructuredTimestamp extends TranslatorStructuredBase {
    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options) {
        options.lineMatching = false
        super(language, services, options)

        /** @type {{ input: TimestampEntry, output: TimestampEntry, completionTokens: number }[]} */
        this.entryHistory = []
    }

    /**
     * @override
     * @param {TimestampEntry[]} entries
     * @param {import('zod').ZodTypeAny} [schema]
     * @returns {Promise<TranslationOutput>}
     */
    async translatePrompt(entries, schema = batchTimestampSchema) {
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        const userMessage = { role: "user", content: JSON.stringify({ inputs: entries.map(toMsEntry) }) }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const systemMessage = this.systemInstruction ? [{ role: "system", content: `${this.systemInstruction}` }] : []
        const messages = [...systemMessage, ...this.options.initialPrompts, ...this.promptContext, userMessage]
        const max_tokens = this.getMaxToken(entries.map(e => e.text))

        try {
            let startTime = 0, endTime = 0
            startTime = Date.now()

            this.currentBatchEntries = entries

            await this.services.cooler?.cool()

            const output = await this.streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens
            }, {
                structure: schema,
                name: "translation_timestamp"
            }, true)

            endTime = Date.now()

            const translationCandidate = output.choices[0].message

            const parsedRaw = translationCandidate.refusal ? null : translationCandidate.parsed
            const parsed = parsedRaw ? { ...parsedRaw, outputs: parsedRaw.outputs?.map(fromMsEntry) ?? [] } : null

            const translationOutput = new TranslationOutput(
                /** @type {any} */(parsed),
                output.usage?.prompt_tokens,
                output.usage?.completion_tokens,
                output.usage?.prompt_tokens_details?.cached_tokens,
                output.usage?.total_tokens,
                translationCandidate.refusal
            )

            this.promptTokensUsed += translationOutput.promptTokens
            this.completionTokensUsed += translationOutput.completionTokens
            this.cachedTokens += translationOutput.cachedTokens
            this.contextPromptTokens = translationOutput.promptTokens
            this.contextCompletionTokens = translationOutput.completionTokens
            this.tokensProcessTimeMs += (endTime - startTime)

            return translationOutput
        } catch (error) {
            log.error("[TranslatorStructuredTimestamp]", `Error ${error?.constructor?.name}`, error?.message)
            return this.handleTranslateError(error, entries.length)
        }
    }

    buildTimestampContext() {
        if (this.entryHistory.length === 0) return

        const maxTokens = this.options.useFullContext
        let sliced

        if (maxTokens > 0) {
            let tokenCount = 0
            let startIndex = this.entryHistory.length
            for (let i = this.entryHistory.length - 1; i >= 0; i--) {
                tokenCount += (this.entryHistory[i].completionTokens ?? 0) * 2
                startIndex = i
                if (tokenCount > maxTokens) break
            }
            sliced = this.entryHistory.slice(startIndex)
            const logMsg = sliced.length < this.entryHistory.length
                ? `sliced ${this.entryHistory.length - sliced.length} entries (${sliced.length}/${this.entryHistory.length} kept, ~${Math.round(tokenCount)} tokens)`
                : `all (${sliced.length} entries, ~${Math.round(tokenCount)} tokens)`
            log.debug("[TranslatorStructuredTimestamp]", "Context:", logMsg)
        } else {
            sliced = this.entryHistory.slice(-this.currentBatchSize)
        }

        const chunkSize = this.currentBatchSize
        this.promptContext = []
        for (let i = 0; i < sliced.length; i += chunkSize) {
            const chunk = sliced.slice(i, i + chunkSize)
            const seenStarts = new Set()
            const outputs = chunk.reduce((acc, e) => {
                if (!seenStarts.has(e.output.start)) {
                    seenStarts.add(e.output.start)
                    acc.push(e.output)
                }
                return acc
            }, [])
            this.promptContext.push({ role: "user", content: JSON.stringify({ inputs: chunk.map(e => toMsEntry(e.input)) }) })
            this.promptContext.push({ role: "assistant", content: JSON.stringify({ outputs: outputs.map(toMsEntry) }) })
        }
    }

    /**
     * @param {TimestampEntry[]} entries
     */
    async * translateSingleSrt(entries) {
        log.debug("[TranslatorStructuredTimestamp]", "Single entry mode")
        for (const entry of entries) {
            this.buildTimestampContext()
            const output = await this.translatePrompt([entry], singleTimestampSchema)
            /** @type {TimestampEntry[]} */
            const outputEntries = /** @type {any} */ (output.content)?.outputs ?? []
            const resultEntry = outputEntries?.[0] ?? entry

            if (!outputEntries?.[0]) {
                log.warn("[TranslatorStructuredTimestamp]", "Empty output for single entry, using original:", entry.text)
            }

            this.entryHistory.push({ input: entry, output: resultEntry, completionTokens: output.completionTokens })

            yield resultEntry
        }
    }

    /**
     * @param {TimestampEntry[]} batch
     * @param {TimestampEntry[]} outputEntries
     * @param {string} mergedRemarks
     * @returns {boolean}
     */
    evaluateBatchOutput(batch, outputEntries, mergedRemarks) {
        const firstInputStart = batch[0].start
        const firstOutputStart = outputEntries[0]?.start
        const lastInputEnd = batch.at(-1).end
        const lastOutputEnd = outputEntries.at(-1)?.end
        const isMismatch = outputEntries.length === 0 || firstOutputStart !== firstInputStart || lastOutputEnd !== lastInputEnd
        const actuallyMerged = outputEntries.length !== batch.length

        this.logMergeStatus(batch, outputEntries, mergedRemarks, isMismatch, actuallyMerged, lastInputEnd)

        if (isMismatch) {
            log.debug("[TranslatorStructuredTimestamp]",
                "Timestamp boundary mismatch",
                "expected start:", firstInputStart, "got:", firstOutputStart,
                "expected end:", lastInputEnd, "got:", lastOutputEnd,
                `(input: ${batch.length}, output: ${outputEntries.length})`
            )
        }

        return isMismatch
    }

    /**
     * @param {TimestampEntry[]} batch
     * @param {TimestampEntry[]} outputEntries
     * @param {string} mergedRemarks
     * @param {boolean} isMismatch
     * @param {boolean} actuallyMerged
     * @param {string} lastInputEnd
     */
    logMergeStatus(batch, outputEntries, mergedRemarks, isMismatch, actuallyMerged, lastInputEnd) {
        const declaredMerged = mergedRemarks !== ""
        if (!isMismatch && declaredMerged !== actuallyMerged) {
            log.warn("[TranslatorStructuredTimestamp]",
                `Merge mergedRemarks mismatch: model ${declaredMerged ? `declared merging ("${mergedRemarks}")` : "provided no remarks"} but output count ${outputEntries.length} vs input ${batch.length}`)
        }

        if (!isMismatch && actuallyMerged) {
            const mergeIdx = outputEntries.findIndex((o, i) => batch[i] && o.start !== batch[i].start)
            const mergeStart = mergeIdx === -1 ? outputEntries.length : mergeIdx
            const rangeStart = (batch[mergeStart] ?? batch.at(-1)).start

            const outputStartSet = new Set(outputEntries.map(e => e.start))
            const inputStartSet = new Set(batch.map(e => e.start))
            // First timestamp >= rangeStart that appears in both = reconciliation point
            const reconcileAt = [...outputStartSet]
                .filter(s => inputStartSet.has(s) && s >= rangeStart)
                .sort()[0] ?? lastInputEnd

            const fmtEntry = (/** @type {TimestampEntry} */ e) => `\n  ${e.start}: "${e.text}"`
            const inputStartIdx = Math.max(0, mergeStart - 1)
            const inputToLog = batch.slice(inputStartIdx).filter(e => e.start <= reconcileAt)
            const outputToLog = outputEntries.filter(e => e.end >= rangeStart && e.start <= reconcileAt)
            log.debug("[TranslatorStructuredTimestamp]",
                "Merging detected",
                `(input: ${batch.length}, output: ${outputEntries.length})`,
                `\n input:${inputToLog.map(fmtEntry).join("")}`,
                `\n output:${outputToLog.map(fmtEntry).join("")}`,
                mergedRemarks ? `\n remarks: ${mergedRemarks}` : ""
            )
        }
    }

    /**
     * @param {TimestampEntry[]} entries
     */
    async * translateSrtLines(entries) {
        log.debug("[TranslatorStructuredTimestamp]", "System Instruction:", this.systemInstruction)
        this.aborted = false

        for (let index = 0, reducedBatchSessions = 0; index < entries.length; index += this.currentBatchSize) {
            const batch = entries.slice(index, index + this.currentBatchSize)

            this.buildTimestampContext()
            const output = await this.translatePrompt(batch)

            if (this.aborted) {
                log.debug("[TranslatorStructuredTimestamp]", "Aborted")
                return
            }

            const parsed = /** @type {BatchTimestampOutput} */ (/** @type {unknown} */ (output.content ?? {}))
            const outputEntries = parsed.outputs ?? []

            const isMismatch = this.evaluateBatchOutput(batch, outputEntries, parsed.mergedRemarks ?? "")

            if (isMismatch || (batch.length > 1 && output.refusal)) {
                this.promptTokensWasted += output.promptTokens
                this.completionTokensWasted += output.completionTokens

                if (output.refusal) {
                    log.debug("[TranslatorStructuredTimestamp]", "Refusal:", output.refusal)
                }

                if (this.changeBatchSize("decrease")) {
                    index -= this.currentBatchSize
                } else {
                    yield* this.translateSingleSrt(batch)
                }
            } else {
                const completionTokensPerEntry = output.completionTokens / batch.length
                for (const input of batch) {
                    const matchedOutput = outputEntries.find(o => o.start <= input.start && o.end >= input.end)
                        ?? outputEntries.at(-1)
                    this.entryHistory.push({ input, output: matchedOutput, completionTokens: completionTokensPerEntry })
                }

                yield* outputEntries

                if (this.batchSizeThreshold && reducedBatchSessions++ >= this.batchSizeThreshold) {
                    reducedBatchSessions = 0
                    const old = this.currentBatchSize
                    this.changeBatchSize("increase")
                    index -= (this.currentBatchSize - old)
                }
            }

            this.printUsage()
        }
    }

    /**
     * @override
     * @template T
     * @param {import('openai/lib/ChatCompletionStream').ChatCompletionStream<T>} runner
     */
    jsonStreamParse(runner) {
        const passThroughStream = new PassThrough()

        runner.on("content.delta", (e) => {
            passThroughStream.write(e.delta)
        })

        runner.on("content.done", () => {
            passThroughStream.end()
        })

        const prevLen = { start: 0, end: 0, text: 0 }
        let textDone = true
        let expectedIdx = -1
        const currentBatchEntries = /** @type {TimestampEntry[]} */ (this.currentBatchEntries ?? [])

        /**
         * @param {"start"|"end"|"text"} fieldKey
         * @param {string} separator
         * @param {string} value
         * @param {boolean} partial
         * @param {() => void} [onComplete]
         */
        const emitField = (fieldKey, separator, value, partial, onComplete) => {
            if (!value) {
                return
            }
            const delta = value.slice(prevLen[fieldKey])
            if (delta) {
                this.services.onStreamChunk?.(delta)
            }
            prevLen[fieldKey] = value.length
            if (!partial) {
                this.services.onStreamChunk?.(separator)
                onComplete?.()
            }
        }

        const pipeline = passThroughStream
            .pipe(new JSONParser({ paths: ['$.outputs.*.start', '$.outputs.*.end', '$.outputs.*.text'], keepStack: false, emitPartialTokens: true, emitPartialValues: true }))

        pipeline.on("data", (/** @type {{ value: string | number, key: string, partial: boolean }} */ { value, key, partial }) => {
            try {
                if (key === "start") {
                    if (textDone) {
                        prevLen.start = prevLen.end = prevLen.text = 0
                        textDone = false
                        expectedIdx++
                    }
                    if (!partial) {
                        const expectedStart = currentBatchEntries[expectedIdx]?.start
                        if (expectedStart && /** @type {number} */(value) !== timestampToMilliseconds(expectedStart)) {
                            this.services.onStreamChunk?.(">>> ")
                        }
                        emitField("start", " -> ", millisecondsToTimestamp(/** @type {number} */(value)), partial)
                    }
                } else if (key === "end") {
                    if (!partial) emitField("end", "  ", millisecondsToTimestamp(/** @type {number} */(value)), partial)
                } else if (key === "text") {
                    emitField("text", "\n", /** @type {string} */(value), partial, () => { textDone = true })
                }
            } catch (err) {
                log.error("[TranslatorStructuredTimestamp]", "Parsing error:", err)
            }
        })

        pipeline.on("error", (/** @type {Error} */ err) => {
            log.error("[TranslatorStructuredTimestamp]", "stream-json parsing error:", err)
        })
    }

    /**
     * @override
     * @param {string[]} lines
     * @param {"user" | "assistant"} role
     */
    getContextLines(lines, role) {
        // Not used in timestamp mode; context is built by buildTimestampContext()
        return JSON.stringify(role === "user" ? { inputs: lines } : { outputs: lines })
    }
}
