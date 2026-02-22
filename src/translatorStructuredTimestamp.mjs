import { z } from "zod";
import log from "loglevel"

import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.mjs";
import { secondsToTimestamp } from "./subtitle.mjs";

/**
 * @typedef {{ id: string, startTime: string, endTime: string, startSeconds: number, endSeconds: number, text: string }} SrtEntry
 * @typedef {{ start: number, end: number, text: string }} TimestampEntry
 */

const TOLERANCE_SECONDS = 0.011  // ~11ms tolerance for floating-point rounding

const timestampSchema = z.object({
    outputs: z.array(z.object({
        start: z.number(),
        end: z.number(),
        text: z.string()
    }))
})

/**
 * @extends {TranslatorStructuredBase<SrtEntry[]>}
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

        /** @type {{ inputs: TimestampEntry[], outputs: TimestampEntry[], completionTokens: number }[]} */
        this.batchHistory = []
    }

    /**
     * @override
     * @param {SrtEntry[]} entries
     * @returns {Promise<TranslationOutput>}
     */
    async translatePrompt(entries) {
        const inputEntries = entries.map(e => ({ start: e.startSeconds, end: e.endSeconds, text: e.text }))
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        const userMessage = { role: "user", content: JSON.stringify({ inputs: inputEntries }) }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const systemMessage = this.systemInstruction ? [{ role: "system", content: `${this.systemInstruction}` }] : []
        const messages = [...systemMessage, ...this.options.initialPrompts, ...this.promptContext, userMessage]
        const max_tokens = this.getMaxToken(entries.map(e => e.text))

        try {
            let startTime = 0, endTime = 0
            startTime = Date.now()

            await this.services.cooler?.cool()

            const output = await this.streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens
            }, {
                structure: timestampSchema,
                name: "translation_timestamp"
            }, false)

            endTime = Date.now()

            const translationCandidate = output.choices[0].message

            /** @type {TimestampEntry[]} */
            const outputEntries = translationCandidate.refusal
                ? []
                : (translationCandidate.parsed?.outputs ?? [])

            const translationOutput = new TranslationOutput(
                /** @type {any} */ (outputEntries),
                output.usage?.prompt_tokens,
                output.usage?.completion_tokens,
                output.usage?.prompt_tokens_details?.cached_tokens,
                output.usage?.total_tokens,
                translationCandidate.refusal
            )

            this.promptTokensUsed += translationOutput.promptTokens
            this.completionTokensUsed += translationOutput.completionTokens
            this.cachedTokens += translationOutput.cachedTokens
            this.contextTokens = translationOutput.totalTokens
            this.tokensProcessTimeMs += (endTime - startTime)

            return translationOutput
        } catch (error) {
            log.error("[TranslatorStructuredTimestamp]", `Error ${error?.constructor?.name}`, error?.message)
            return this.handleTranslateError(error, entries.length)
        }
    }

    buildTimestampContext() {
        if (this.batchHistory.length === 0) return

        const maxTokens = this.options.useFullContext
        let tokenCount = 0
        let startIndex = this.batchHistory.length

        if (maxTokens > 0) {
            for (let i = this.batchHistory.length - 1; i >= 0; i--) {
                tokenCount += (this.batchHistory[i].completionTokens ?? 0) * 2
                startIndex = i
                if (tokenCount > maxTokens) break
            }
            const sliceCount = this.batchHistory.length - startIndex
            const logMsg = sliceCount < this.batchHistory.length
                ? `sliced ${this.batchHistory.length - sliceCount} batches (${sliceCount}/${this.batchHistory.length} kept, ~${Math.round(tokenCount)} tokens)`
                : `full (${sliceCount} batches, ~${Math.round(tokenCount)} tokens)`
            log.debug("[TranslatorStructuredTimestamp]", "Context:", logMsg)
        } else {
            startIndex = Math.max(0, this.batchHistory.length - 1)
        }

        const sliced = this.batchHistory.slice(startIndex)
        this.promptContext = []
        for (const batch of sliced) {
            this.promptContext.push({ role: "user", content: JSON.stringify({ inputs: batch.inputs }) })
            this.promptContext.push({ role: "assistant", content: JSON.stringify({ outputs: batch.outputs }) })
        }
    }

    /**
     * @param {SrtEntry[]} entries
     */
    async * translateSingleSrt(entries) {
        log.debug("[TranslatorStructuredTimestamp]", "Single entry mode")
        for (const entry of entries) {
            this.buildTimestampContext()
            const output = await this.translatePrompt([entry])
            /** @type {TimestampEntry[]} */
            const outputEntries = /** @type {any} */ (output.content)
            const resultEntry = outputEntries?.[0] ?? { start: entry.startSeconds, end: entry.endSeconds, text: entry.text }

            if (!outputEntries?.[0]) {
                log.warn("[TranslatorStructuredTimestamp]", "Empty output for single entry, using original:", entry.text)
            }

            const inputEntry = { start: entry.startSeconds, end: entry.endSeconds, text: entry.text }
            this.batchHistory.push({
                inputs: [inputEntry],
                outputs: [resultEntry],
                completionTokens: output.completionTokens
            })

            yield {
                startTime: secondsToTimestamp(resultEntry.start),
                endTime: secondsToTimestamp(resultEntry.end),
                startSeconds: resultEntry.start,
                endSeconds: resultEntry.end,
                text: resultEntry.text
            }
        }
    }

    /**
     * @param {SrtEntry[]} entries
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

            /** @type {TimestampEntry[]} */
            const outputEntries = /** @type {any} */ (output.content)

            const lastInputEnd = batch.at(-1).endSeconds
            const lastOutputEnd = outputEntries.at(-1)?.end
            const isMismatch = outputEntries.length === 0
                || Math.abs(lastOutputEnd - lastInputEnd) > TOLERANCE_SECONDS

            if (!isMismatch && outputEntries.length !== batch.length) {
                const mergeIdx = outputEntries.findIndex((o, i) => batch[i] && Math.abs(o.start - batch[i].startSeconds) > TOLERANCE_SECONDS)
                const mergeStart = mergeIdx === -1 ? outputEntries.length : mergeIdx
                const mergeEntry = batch[mergeStart]
                const mergeOutput = outputEntries[mergeStart]
                log.debug("[TranslatorStructuredTimestamp]",
                    "Merging detected from entry", mergeStart,
                    `(input: ${batch.length}, output: ${outputEntries.length})`,
                    mergeEntry ? `\n  input:  ${mergeEntry.startTime}: "${mergeEntry.text}"` : "",
                    mergeOutput ? `\n  output: ${secondsToTimestamp(mergeOutput.start)}: "${mergeOutput.text}"` : ""
                )
            }

            if (isMismatch || (batch.length > 1 && output.refusal)) {
                this.promptTokensWasted += output.promptTokens
                this.completionTokensWasted += output.completionTokens

                if (output.refusal) {
                    log.debug("[TranslatorStructuredTimestamp]", "Refusal:", output.refusal)
                } else {
                    log.debug("[TranslatorStructuredTimestamp]",
                        "Timestamp boundary mismatch",
                        "expected end:", secondsToTimestamp(lastInputEnd),
                        "got:", lastOutputEnd != null ? secondsToTimestamp(lastOutputEnd) : lastOutputEnd,
                        `(input: ${batch.length}, output: ${outputEntries.length})`
                    )
                }

                if (this.changeBatchSize("decrease")) {
                    index -= this.currentBatchSize
                } else {
                    yield* this.translateSingleSrt(batch)
                }
            } else {
                const inputsForHistory = batch.map(e => ({ start: e.startSeconds, end: e.endSeconds, text: e.text }))
                this.batchHistory.push({
                    inputs: inputsForHistory,
                    outputs: outputEntries,
                    completionTokens: output.completionTokens
                })

                for (const outEntry of outputEntries) {
                    yield {
                        startTime: secondsToTimestamp(outEntry.start),
                        endTime: secondsToTimestamp(outEntry.end),
                        startSeconds: outEntry.start,
                        endSeconds: outEntry.end,
                        text: outEntry.text
                    }
                }

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
     * @param {string[]} lines
     * @param {"user" | "assistant"} role
     */
    getContextLines(lines, role) {
        // Not used in timestamp mode; context is built by buildTimestampContext()
        return JSON.stringify(role === "user" ? { inputs: lines } : { outputs: lines })
    }
}
