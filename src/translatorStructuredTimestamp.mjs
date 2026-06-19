import { PassThrough } from "stream";
import { z } from "zod";
import { JSONParser } from "@streamparser/json-node";
import log from "loglevel"
import { countTokens } from "gpt-tokenizer"

import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.mjs";
import { timestampToMilliseconds, millisecondsToTimestamp } from "./subtitle.mjs";
import { encodeGeneric as encodeToon } from "@blackwell-systems/gcf";

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
    outputs: timestampEntriesSchema
})

const schemaDescriptions = {
    single: [
        "outputs: Subtitle entries with start and end as milliseconds",
    ].join("\n"),
    batch: [
        "outputs: Subtitle entries with start and end as milliseconds",
        "Only merge entries if the combined text remains readable as a subtitle (prefer keeping entries separate if the merged text would exceed ~42 characters).",
    ].join("\n"),
}

/**
 * Timestamp-entry translator: input and yielded output are both {@link TimestampEntry}.
 * @extends {TranslatorStructuredBase<TimestampEntry, TimestampEntry>}
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
     * @returns {Promise<TranslationOutput<TimestampEntry[]>>}
     */
    async doTranslatePrompt(entries) {
        const isSingle = entries.length === 1
        const schema = isSingle ? singleTimestampSchema : batchTimestampSchema
        const schemaAppendix = isSingle ? schemaDescriptions.single : schemaDescriptions.batch
        const systemContent = this.systemInstruction ? `${this.systemInstruction}\n\n# Output Schema\n${schemaAppendix}` : undefined
        const messages = this.buildPromptMessages(encodeToon({ inputs: entries.map(toMsEntry) }), systemContent)

        try {
            this.currentBatchEntries = entries

            const output = await this.requestStructured(entries, messages, {
                structure: schema,
                name: "translation_timestamp"
            }, {
                jsonStream: true,
                onJsonStream: (runner) => this.jsonStreamParse(runner),
            })

            const translationCandidate = output.choices[0].message

            const parsedRaw = translationCandidate.refusal ? null : translationCandidate.parsed
            const outputs = parsedRaw?.outputs?.map(fromMsEntry) ?? []

            return TranslationOutput.fromCompletion(outputs, output)
        } catch (error) {
            return this.logAndHandleTranslateError(error, entries.length)
        }
    }

    /**
     * @override Timestamp entries are passed to the prompt as-is.
     * @param {TimestampEntry} entry
     * @returns {TimestampEntry}
     */
    preprocessLine(entry) {
        return entry
    }

    /**
     * @override Text content of a timestamp entry, used for repetition guarding,
     * moderation input and token weighting (timestamps excluded).
     * @param {TimestampEntry} entry
     */
    getLineText(entry) {
        return entry.text
    }

    /**
     * @override
     * Builds the prompt context from entryHistory (instead of workingProgress).
     */
    buildContext() {
        if (this.entryHistory.length === 0) return

        const chunkSize = this.contextChunkSize

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

        const includedEntries = includedChunks.reduce((sum, c) => sum + c.size, 0)
        this.logContextSelection(includedEntries, this.entryHistory.length, tokenCount)

        this.promptContext = /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */ (
            includedChunks.flatMap(({ userContent, assistantContent }) => [
                { role: "user", content: userContent },
                { role: "assistant", content: assistantContent }
            ])
        )
    }

    /**
     * @override Emits the output of one single-mode entry,
     * falling back to the original entry on empty output.
     * @param {TimestampEntry} input
     * @param {TranslationOutput<TimestampEntry[]>} output
     * @returns {Generator<TimestampEntry>}
     */
    * yieldSingleSuccess(input, output) {
        const outputEntries = output.content ?? []
        const resultEntry = outputEntries[0] ?? input

        if (!outputEntries[0]) {
            log.warn("[TranslatorStructuredTimestamp]", "Empty output for single entry, using original:", input.text)
        }

        this.entryHistory.push({ input, output: resultEntry, completionTokens: output.completionTokens })

        yield resultEntry
    }

    /**
     * @deprecated Use {@link translateLines} instead.
     * @param {TimestampEntry[]} entries
     */
    async * translateSrtLines(entries) {
        yield* this.translateLines(entries)
    }

    /**
     * @override Emits the entries of a successful batch, matching each input to its
     * (possibly merged) output entry for the context history.
     * @param {TimestampEntry[]} batch
     * @param {TimestampEntry[]} outputEntries
     * @param {TranslationOutput<TimestampEntry[]>} output
     * @returns {Generator<TimestampEntry>}
     */
    * yieldBatchSuccess(batch, outputEntries, output) {
        const completionTokensPerEntry = output.completionTokens / batch.length
        for (const input of batch) {
            const matchedOutput = outputEntries.find(o => o.start <= input.start && o.end >= input.end)
                ?? outputEntries.at(-1)
            this.entryHistory.push({ input, output: matchedOutput, completionTokens: completionTokensPerEntry })
        }

        yield* outputEntries
    }

    /**
     * @param {TimestampEntry[]} batch
     * @param {TimestampEntry[]} outputEntries
     * @returns {boolean}
     */
    evaluateBatchOutput(batch, outputEntries) {
        const firstInputStart = batch[0].start
        const firstOutputStart = outputEntries[0]?.start
        const lastInputEnd = batch.at(-1).end
        const lastOutputEnd = outputEntries.at(-1)?.end
        const isMismatch = outputEntries.length === 0 || firstOutputStart !== firstInputStart || lastOutputEnd !== lastInputEnd
        const actuallyMerged = outputEntries.length !== batch.length

        this.logMergeStatus(batch, outputEntries, isMismatch, actuallyMerged, lastInputEnd)

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
     * @param {boolean} isMismatch
     * @param {boolean} actuallyMerged
     * @param {string} lastInputEnd
     */
    logMergeStatus(batch, outputEntries, isMismatch, actuallyMerged, lastInputEnd) {
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
                `\n output:${outputToLog.map(fmtEntry).join("")}`
            )
        }
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

        const pipeline = passThroughStream
            .pipe(new JSONParser({ paths: ['$.outputs.*.start', '$.outputs.*.end', '$.outputs.*.text'], keepStack: false, emitPartialTokens: true, emitPartialValues: true }))

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
                    const strValue = /** @type {string} */(value ?? '')
                    const delta = strValue.slice(textBufEntryLen)
                    textBuffer += delta
                    textBufEntryLen = strValue.length
                    if (!partial) {
                        textBuffer += '\n'
                        textBufEntryLen = 0
                    }
                    const pattern = this.checkRepetition(textBuffer)
                    if (pattern) {
                        this.abortOnRepetition(pattern, runner, textBuffer)
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
