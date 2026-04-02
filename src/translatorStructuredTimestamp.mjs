import { PassThrough } from "stream";
import { z } from "zod";
import { JSONParser } from "@streamparser/json-node";
import log from "loglevel"
import { countTokens } from "gpt-tokenizer"
import { detectRepetition } from "llm-summary";

import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.mjs";
import { AUTO_BATCH_MIN, AUTO_BATCH_REDUCTION, DYNAMIC_BATCH_BUDGET_FRACTION } from "./translator.mjs";
import { streamParse } from "./openai.mjs";
import { timestampToMilliseconds, millisecondsToTimestamp } from "./subtitle.mjs";
import { encode as encodeToon } from "@toon-format/toon";

const timestampEntriesSchema = z.array(z.object({
    start: z.int(),
    end: z.int(),
    text: z.string()
}))

/**
 * @typedef {{ start: string, end: string, text: string }} TimestampEntry
 * @typedef {z.infer<typeof timestampEntriesSchema>[number]} MsEntry
 */

/** @param {TimestampEntry} e @returns {MsEntry} */
export const toMsEntry = (e) => ({
    start: timestampToMilliseconds(e.start),
    end: timestampToMilliseconds(e.end),
    text: e.text
})

/** @param {MsEntry} e @returns {TimestampEntry} */
const fromMsEntry = (e) => ({
    start: millisecondsToTimestamp(e.start),
    end: millisecondsToTimestamp(e.end),
    text: e.text
})

const singleTimestampSchema = z.object({
    outputs: timestampEntriesSchema
})

const batchTimestampSchema = z.object({
    outputs: timestampEntriesSchema,
    remarksIfContainedMergers: z.string()
})

const schemaDescriptions = {
    single: [
        "outputs: Subtitle entries with start and end as milliseconds",
    ].join("\n"),
    batch: [
        "outputs: Subtitle entries with start and end as milliseconds",
        "remarksIfContainedMergers: MUST be empty if no merges! Otherwise: briefly explain why entries were merged in 1 short sentence. Only merge if the combined text remains readable as a subtitle (prefer keeping entries separate if the merged text would exceed ~42 characters).",
    ].join("\n"),
}

/**
 * @typedef {{ outputs: TimestampEntry[], remarksIfContainedMergers: string }} BatchTimestampOutput
 */

/**
 * @extends {TranslatorStructuredBase<TimestampEntry>}
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
     * @returns {Promise<TranslationOutput>}
     */
    async doTranslatePrompt(entries) {
        const isSingle = entries.length === 1
        const schema = isSingle ? singleTimestampSchema : batchTimestampSchema
        const schemaAppendix = isSingle ? schemaDescriptions.single : schemaDescriptions.batch
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        const userMessage = { role: "user", content: encodeToon({ inputs: entries.map(toMsEntry) }) }
        const systemContent = this.systemInstruction ? `${this.systemInstruction}\n\n# Output Schema\n${schemaAppendix}` : undefined
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const systemMessage = systemContent ? [{ role: "system", content: systemContent }] : []
        const messages = [...systemMessage, ...this.options.initialPrompts, ...this.promptContext, userMessage]
        const max_tokens = this.getMaxToken(entries)

        try {
            this.currentBatchEntries = entries

            await this.services.cooler?.cool()

            const output = await streamParse(this.services, {
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens
            }, {
                structure: schema,
                name: "translation_timestamp"
            }, {
                jsonStream: true,
                onJsonStream: (runner) => this.jsonStreamParse(runner),
                onController: (c) => { this.streamController = c },
            })

            const translationCandidate = output.choices[0].message

            const parsedRaw = translationCandidate.refusal ? null : translationCandidate.parsed
            const parsed = parsedRaw ? { ...parsedRaw, outputs: parsedRaw.outputs?.map(fromMsEntry) ?? [] } : null

            return TranslationOutput.fromCompletion(/** @type {any} */(parsed), output)
        } catch (error) {
            if (!this._repetitionDetected) {
                log.error("[TranslatorStructuredTimestamp]", `Error ${error?.constructor?.name}`, error?.message)
            }
            return this.handleTranslateError(error, entries.length)
        }
    }

    buildTimestampContext() {
        if (this.entryHistory.length === 0) return

        const chunkSize = this.options.batchSizes?.[this.options.batchSizes.length - 1] ?? this.currentBatchSize

        // Precompute all chunks with their serialized message content
        const allChunks = []
        for (let i = 0; i < this.entryHistory.length; i += chunkSize) {
            const chunk = this.entryHistory.slice(i, i + chunkSize)
            const userContent = encodeToon({ inputs: chunk.map(e => toMsEntry(e.input)) })
            const seenStarts = new Set()
            const outputs = chunk.reduce((acc, e) => {
                if (!seenStarts.has(e.output.start)) {
                    seenStarts.add(e.output.start)
                    acc.push(e.output)
                }
                return acc
            }, [])
            const assistantContent = JSON.stringify({ outputs: outputs.map(toMsEntry) })
            allChunks.push({ userContent, assistantContent, size: chunk.length })
        }

        const { includedChunks, tokenCount } = this.selectContextChunks(allChunks,
            ({ userContent, assistantContent }) => countTokens(userContent) + countTokens(assistantContent)
        )

        if (this.options.useFullContext > 0) {
            const totalEntries = this.entryHistory.length
            const includedEntries = includedChunks.reduce((sum, c) => sum + c.size, 0)
            const logMsg = includedEntries < totalEntries
                ? `sliced ${totalEntries - includedEntries} entries (${includedEntries}/${totalEntries} kept, ${tokenCount} tokens)`
                : `all (${includedEntries} entries, ${tokenCount} tokens)`
            log.debug("[TranslatorStructuredTimestamp]", "Context:", logMsg)
        }

        this.promptContext = /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */ (
            includedChunks.flatMap(({ userContent, assistantContent }) => [
                { role: "user", content: userContent },
                { role: "assistant", content: assistantContent }
            ])
        )
    }

    /**
     * @param {TimestampEntry[]} entries
     */
    async * translateSingleSrt(entries) {
        log.debug("[TranslatorStructuredTimestamp]", "Single entry mode")
        for (const entry of entries) {
            this.buildTimestampContext()
            const output = await this.translatePrompt([entry])
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
     * @param {string} [remarksIfContainedMergers]
     * @returns {boolean}
     */
    evaluateBatchOutput(batch, outputEntries, remarksIfContainedMergers = "") {
        const firstInputStart = batch[0].start
        const firstOutputStart = outputEntries[0]?.start
        const lastInputEnd = batch.at(-1).end
        const lastOutputEnd = outputEntries.at(-1)?.end
        const isMismatch = outputEntries.length === 0 || firstOutputStart !== firstInputStart || lastOutputEnd !== lastInputEnd
        const actuallyMerged = outputEntries.length !== batch.length

        this.logMergeStatus(batch, outputEntries, remarksIfContainedMergers, isMismatch, actuallyMerged, lastInputEnd)

        if (isMismatch) {
            log.debug("[TranslatorStructuredTimestamp]",
                "Timestamp boundary mismatch",
                "expected start:", firstInputStart, "got:", firstOutputStart,
                "expected end:", lastInputEnd, "got:", lastOutputEnd,
                `(input: ${batch.length}, output: ${outputEntries.length})`,
                ...(remarksIfContainedMergers ? [`remarks: "${remarksIfContainedMergers}"`] : [])
            )
        }

        return isMismatch
    }

    /**
     * @param {TimestampEntry[]} batch
     * @param {TimestampEntry[]} outputEntries
     * @param {string} remarksIfContainedMergers
     * @param {boolean} isMismatch
     * @param {boolean} actuallyMerged
     * @param {string} lastInputEnd
     */
    logMergeStatus(batch, outputEntries, remarksIfContainedMergers, isMismatch, actuallyMerged, lastInputEnd) {
        const declaredMerged = remarksIfContainedMergers !== ""
        if (!isMismatch && declaredMerged !== actuallyMerged) {
            log.warn("[TranslatorStructuredTimestamp]",
                `Merge remarksIfContainedMergers mismatch: model ${declaredMerged ? `declared merging ("${remarksIfContainedMergers}")` : "provided no remarks"} but output count ${outputEntries.length} vs input ${batch.length}`)
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
                remarksIfContainedMergers ? `\n remarks: ${remarksIfContainedMergers}` : ""
            )
        }
    }

    /**
     * Computes how many timestamp entries starting at startIndex fit within the dynamic batch budget fraction of the context token budget.
     * Returns at least AUTO_BATCH_MIN.
     * @param {TimestampEntry[]} entries
     * @param {number} startIndex
     * @returns {number}
     */
    computeDynamicBatchSizeTimestamp(entries, startIndex) {
        const useFullContext = this.options.useFullContext
        if (!useFullContext) {
            return entries.length - startIndex
        }
        const budget = Math.floor(useFullContext * DYNAMIC_BATCH_BUDGET_FRACTION)
        let tokensSoFar = 0
        let count = 0
        for (let i = startIndex; i < entries.length; i++) {
            const lineTokens = countTokens(entries[i].text)
            if (count > 0 && tokensSoFar + lineTokens > budget) break
            tokensSoFar += lineTokens
            count++
        }
        return Math.max(AUTO_BATCH_MIN, count)
    }

    /**
     * @param {TimestampEntry[]} entries
     */
    async * translateSrtLines(entries) {
        log.debug("[TranslatorStructuredTimestamp]", "System Instruction:", this.systemInstruction)
        this.aborted = false

        for (let index = 0, reducedBatchSessions = 0; index < entries.length; index += this.currentBatchSize) {
            if (this.isDynamicBatch) {
                const computed = this.computeDynamicBatchSizeTimestamp(entries, index)
                this.currentBatchSize = Math.max(AUTO_BATCH_MIN, Math.floor(computed / this.dynamicReductionFactor))
                log.debug("[TranslatorStructuredTimestamp]", "Dynamic batch size:", this.currentBatchSize,
                    this.dynamicReductionFactor > 1 ? `(reduction x${this.dynamicReductionFactor})` : `(budget: ${Math.floor(this.options.useFullContext * DYNAMIC_BATCH_BUDGET_FRACTION)} tokens)`)
            }

            const batch = entries.slice(index, index + this.currentBatchSize)

            this.buildTimestampContext()
            const output = await this.translatePrompt(batch)

            if (this.aborted) {
                log.debug("[TranslatorStructuredTimestamp]", "Aborted")
                return
            }

            const parsed = /** @type {BatchTimestampOutput} */ (/** @type {unknown} */ (output.content ?? {}))
            const outputEntries = parsed.outputs ?? []

            const isMismatch = this.evaluateBatchOutput(batch, outputEntries, parsed.remarksIfContainedMergers ?? "")

            if (isMismatch || (batch.length > 1 && output.refusal)) {
                this.promptTokensWasted += output.promptTokens
                this.completionTokensWasted += output.completionTokens

                if (output.refusal) {
                    log.debug("[TranslatorStructuredTimestamp]", "Refusal:", output.refusal)
                }

                if (this.isDynamicBatch) {
                    if (this.currentBatchSize <= AUTO_BATCH_MIN) {
                        yield* this.translateSingleSrt(batch)
                        this.dynamicReductionFactor = 1
                    } else {
                        this.dynamicReductionFactor *= AUTO_BATCH_REDUCTION
                        index -= this.currentBatchSize
                    }
                } else {
                    if (this.changeBatchSize("decrease")) {
                        index -= this.currentBatchSize
                    } else {
                        yield* this.translateSingleSrt(batch)
                    }
                }
            } else {
                const completionTokensPerEntry = output.completionTokens / batch.length
                for (const input of batch) {
                    const matchedOutput = outputEntries.find(o => o.start <= input.start && o.end >= input.end)
                        ?? outputEntries.at(-1)
                    this.entryHistory.push({ input, output: matchedOutput, completionTokens: completionTokensPerEntry })
                }

                yield* outputEntries

                if (this.isDynamicBatch) {
                    this.dynamicReductionFactor = 1
                } else {
                    if (this.batchSizeThreshold && reducedBatchSessions++ >= this.batchSizeThreshold) {
                        reducedBatchSessions = 0
                        const old = this.currentBatchSize
                        this.changeBatchSize("increase")
                        index -= (this.currentBatchSize - old)
                    }
                }
            }

            this.printUsage()
        }
    }

    /**
     * @override
     * @param {Error} error
     * @param {number} lineCount
     * @returns {TranslationOutput | undefined}
     */
    handleTranslateError(error, lineCount) {
        if (this._repetitionDetected) {
            this._repetitionDetected = false
            log.warn("[TranslatorStructuredTimestamp]", "Retrying after repetition abort")
            return new TranslationOutput([], 0, 0, 0, 0)
        }
        return super.handleTranslateError(error, lineCount)
    }

    /**
     * @param {import('openai/lib/ChatCompletionStream').ChatCompletionStream<any>} runner
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

        /** Text-only buffer for repetition detection (timestamps excluded) */
        let textBuffer = ''
        let textBufEntryLen = 0

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

        let remarksPrevLen = 0

        const pipeline = passThroughStream
            .pipe(new JSONParser({ paths: ['$.outputs.*.start', '$.outputs.*.end', '$.outputs.*.text', '$.remarksIfContainedMergers'], keepStack: false, emitPartialTokens: true, emitPartialValues: true }))

        pipeline.on("data", (/** @type {{ value: string | number, key: string, partial: boolean }} */ { value, key, partial }) => {
            try {
                if (key === "start") {
                    if (textDone) {
                        prevLen.start = prevLen.end = prevLen.text = 0
                        textBufEntryLen = 0
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
                    const strValue = /** @type {string} */(value)
                    const delta = strValue.slice(textBufEntryLen)
                    textBuffer += delta
                    textBufEntryLen = strValue.length
                    if (!partial) {
                        textBuffer += '\n'
                        textBufEntryLen = 0
                    }
                    const pattern = detectRepetition(textBuffer, 2, 500, 3)
                    if (pattern) {
                        log.warn("[TranslatorStructuredTimestamp]", `Repetition detected: "${pattern.slice(0, 50)}"`)
                        this._repetitionDetected = true
                        runner.controller.abort()
                    }
                } else if (key === "remarksIfContainedMergers") {
                    const strValue = /** @type {string} */(value)
                    if (strValue) {
                        const delta = strValue.slice(remarksPrevLen)
                        if (delta) {
                            if (remarksPrevLen === 0) this.services.onStreamChunk?.("[remarks] ")
                            this.services.onStreamChunk?.(delta)
                        }
                        remarksPrevLen = strValue.length
                        if (!partial) {
                            this.services.onStreamChunk?.("\n")
                        }
                    }
                }
            } catch (err) {
                log.error("[TranslatorStructuredTimestamp]", "Parsing error:", err)
            }
        })

        pipeline.on("error", (/** @type {Error} */ err) => {
            log.error("[TranslatorStructuredTimestamp]", "stream-json parsing error:", err)
        })
    }

}
