import log from "loglevel"
import { countTokens } from "gpt-tokenizer"
import { roundWithPrecision, sleep } from './helpers.mjs'

/**
 * Runtime context passed to translation service functions.
 *
 * @typedef TranslationServiceContext
 * @property {import("openai").OpenAI} openai - Configured OpenAI client instance
 * @property {import('./cooldown.mjs').CooldownContext} [cooler] - Optional cooldown controller for rate-limit back-off
 * @property {(data: string) => void} [onStreamChunk] - Called for each streamed token chunk
 * @property {() => void} [onStreamEnd] - Called when a stream response finishes
 * @property {() => void} [onClearLine] - Called to erase the current console line (progress UI)
 * @property {import('./moderator.mjs').ModerationServiceContext} [moderationService] - Optional moderation service context
 */

/**
 * @typedef TranslatorOptions
 * @property {Pick<Partial<import('openai').OpenAI.Chat.ChatCompletionCreateParams>, "messages" | "model"> & Omit<import('openai').OpenAI.Chat.ChatCompletionCreateParams, "messages" | "model">} createChatCompletionRequest
 * Options for ChatGPT besides the messages; it is recommended to set `temperature: 0` for an almost deterministic translation
 * @property {import('openai').OpenAI.ModerationModel} moderationModel
 * Moderation model
 * @property {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} initialPrompts
 * Initial prompt messages before the translation request messages
 * @property {boolean} useModerator `false`  
 * Verify with the free OpenAI Moderation tool before submitting the prompt to the ChatGPT model
 * @property {boolean} prefixNumber `true`  
 * Label lines with numerical prefixes to improve the one-to-one correlation between input and output line quantities
 * @property {boolean} lineMatching `true`  
 * Enforce one-to-one line quantity matching between input and output
 * @property {number} useFullContext `2000`  
 * Max context token budget for history. When > 0, includes as much workingProgress history as fits within this token budget (tracked from actual model response token counts), chunked by the last batchSizes value. Set to 0 to include history without a token limit check.
 * @property {number[] | undefined} batchSizes
 * The number of lines to include in each translation prompt, provided they are estimated to fit within the token limit.
 * In case of mismatched output line quantities, this number will be decreased step-by-step according to the values in the array, ultimately reaching one.
 * When `undefined` (not explicitly provided), batch size is determined dynamically per batch based on the `useFullContext`
 * token budget. On failure, the size is reduced and retried down to a minimum, then resets on the next successful batch.
 *
 * Larger batch sizes generally lead to more efficient token utilization and potentially better contextual translation.
 * However, mismatched output line quantities or exceeding the token limit will cause token wastage, requiring resubmission of the batch with a smaller batch size.
 * @property {"array" | "object" | "none" | "timestamp"} structuredMode `"array"`
 * Structured response format mode
 * @property {boolean} skipRefineInstruction
 * Skip the final instruction refinement API call in agent mode; use the base system instruction directly
 * @property {string} agentContextSummary  
 * Pre-supplied context summary for agent mode; skips the batch scanning pass entirely
 * @property {number} guardRepetition `10`
 * Minimum number of pattern repeats before aborting a streaming response. Set to `0` to disable repetition detection.
 * @property {number} max_token `0`
 * @property {number} inputMultiplier `0`
 * @property {import('loglevel').LogLevelDesc} logLevel
 * @property {string} [inputFile] 
 * Input file path, used by agent mode to provide file context during planning
 */

export const DefaultOptions = {
    createChatCompletionRequest: {
        model: "gpt-4o-mini",
        temperature: 0
    },
    moderationModel: "omni-moderation-latest",
    initialPrompts: [],
    useModerator: false,
    prefixNumber: true,
    lineMatching: true,
    useFullContext: 2000,
    batchSizes: undefined,
    structuredMode: "array",
    guardRepetition: 10,
    max_token: 0,
    inputMultiplier: 0,
    logLevel: undefined
}

/**
 * @abstract
 * @template [T=string]
 * @template {T[]} [TLines=T[]]
 * Abstract base class for all translator implementations.
 * Holds shared state (token counters, options, batch sizes) and utility methods
 * (abort, usage tracking, batch size management, token budget slicing).
 */
export class TranslatorBase {
    /**
     * @param {{from?: string, to: string}} language
     * @param {TranslationServiceContext} services
     * @param {Partial<TranslatorOptions>} [options]
     */
    constructor(language, services, options) {
        options.createChatCompletionRequest = { ...DefaultOptions.createChatCompletionRequest, ...options.createChatCompletionRequest }

        this.language = language
        this.services = services
        this.options = /** @type {TranslatorOptions & {createChatCompletionRequest: {model: string}}} */ ({ ...DefaultOptions, ...options })
        this.systemInstruction = `Translate ${this.language.from ? this.language.from + " " : ""}to ${this.language.to}`
        
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        this.promptContext = []
        
        this.promptTokensUsed = 0
        this.promptTokensWasted = 0
        this.cachedTokens = 0
        this.completionTokensUsed = 0
        this.completionTokensWasted = 0
        this.tokensProcessTimeMs = 0
        this.contextPromptTokens = 0
        this.contextCompletionTokens = 0
        
        this.isDynamicBatch = !this.options.batchSizes
        this.dynamicReductionFactor = 1
        this.workingBatchSizes = this.options.batchSizes ? [...this.options.batchSizes] : []
        this.currentBatchSize = this.options.batchSizes ? this.workingBatchSizes[this.workingBatchSizes.length - 1] : 0
        
        this.aborted = false
        /** @type {AbortController | undefined} */
        this.streamController = undefined
        
        if (options.logLevel) {
            log.setLevel(options.logLevel)
        }
        log.debug("[Translator]", "Model:", this.options.createChatCompletionRequest.model)
    }

    /**
     * @abstract
     * @param {string[]} _lines
     * @returns {AsyncGenerator<{index: number, source: string, transform: string, finalTransform: string}>}
     */
    async * translateLines(_lines) {
        throw new Error(`${this.constructor.name}.translateLines() is not implemented`)
    }

    /**
     * Timing and accumulation wrapper - subclasses override doTranslatePrompt, not this.
     * @param {TLines} lines
     * @returns {Promise<import('./translatorOutput.mjs').TranslationOutput>}
     */
    async translatePrompt(lines) {
        const startTime = Date.now()
        const output = await this.doTranslatePrompt(lines)
        const endTime = Date.now()
        const result = this.accumulateUsage(output, endTime - startTime)
        return result
    }

    /**
     * @abstract
     * @param {TLines} _lines
     * @returns {Promise<import('./translatorOutput.mjs').TranslationOutput>}
     */
    async doTranslatePrompt(_lines) {
        throw new Error(`${this.constructor.name}.doTranslatePrompt() is not implemented`)
    }

    /**
     * @param {TLines} lines
     */
    getMaxToken(lines) {
        if (this.options.max_token && !this.options.inputMultiplier) {
            return this.options.max_token
        }
        else if (this.options.max_token && this.options.inputMultiplier) {
            const max = countTokens(JSON.stringify(lines)) * this.options.inputMultiplier
            return Math.min(this.options.max_token, max)
        }
        return undefined
    }

    /**
     * @param {"increase" | "decrease"} mode
     */
    changeBatchSize(mode) {
        if (!this.options.batchSizes) return false
        const old = this.currentBatchSize
        if (mode === "decrease") {
            if (this.currentBatchSize === this.options.batchSizes[0]) {
                return false
            }
            this.workingBatchSizes.unshift(this.workingBatchSizes.pop())
        }
        else if (mode === "increase") {
            if (this.currentBatchSize === this.options.batchSizes[this.options.batchSizes.length - 1]) {
                return false
            }
            this.workingBatchSizes.push(this.workingBatchSizes.shift())
        }
        this.currentBatchSize = this.workingBatchSizes[this.workingBatchSizes.length - 1]
        if (this.currentBatchSize === this.options.batchSizes[this.options.batchSizes.length - 1]) {
            this.batchSizeThreshold = undefined
        }
        else {
            this.batchSizeThreshold = Math.floor(Math.max(old, this.currentBatchSize) / Math.min(old, this.currentBatchSize))
        }
        log.debug("[Translator]", "BatchSize", mode, old, "->", this.currentBatchSize, "SizeThreshold", this.batchSizeThreshold)
        return true
    }

    /**
     * Accumulates token usage from a translatePrompt response into running totals, then returns the output.
     * @param {import('./translatorOutput.mjs').TranslationOutput} output
     * @param {number} elapsedMs - time elapsed for this request in milliseconds
     * @returns {import('./translatorOutput.mjs').TranslationOutput}
     */
    accumulateUsage(output, elapsedMs) {
        this.promptTokensUsed += output.promptTokens
        this.completionTokensUsed += output.completionTokens
        this.cachedTokens += output.cachedTokens
        this.contextPromptTokens = output.promptTokens
        this.contextCompletionTokens = output.completionTokens
        this.tokensProcessTimeMs += elapsedMs
        return output
    }

    /**
     * Scans pre-grouped chunks from most recent backward, returning those that fit within
     * the useFullContext token budget. When budget is disabled (≤ 0), returns only the last chunk.
     * @template T
     * @param {T[]} chunks
     * @param {(chunk: T) => number} getChunkCost
     * @returns {{ includedChunks: T[], tokenCount: number }}
     */
    selectContextChunks(chunks, getChunkCost) {
        const maxTokens = this.options.useFullContext
        let tokenCount = 0
        let includedCount = maxTokens <= 0 ? Math.min(1, chunks.length) : 0
        if (maxTokens > 0) {
            for (let i = chunks.length - 1; i >= 0; i--) {
                const cost = getChunkCost(chunks[i])
                if (tokenCount + cost > maxTokens) break
                tokenCount += cost
                includedCount++
            }
            // Always include at least the most recent chunk to avoid losing all context
            if (includedCount === 0 && chunks.length > 0) includedCount = 1
        }
        return { includedChunks: chunks.slice(chunks.length - includedCount), tokenCount }
    }

    get usage() {
        const promptTokensUsed = this.promptTokensUsed
        const completionTokensUsed = this.completionTokensUsed
        const promptTokensWasted = this.promptTokensWasted
        const completionTokensWasted = this.completionTokensWasted
        const usedTokens = promptTokensUsed + completionTokensUsed
        const wastedTokens = promptTokensWasted + completionTokensWasted
        const minutesElapsed = this.tokensProcessTimeMs / 1000 / 60
        const promptRate = roundWithPrecision(promptTokensUsed / minutesElapsed, 0)
        const completionRate = roundWithPrecision(completionTokensUsed / minutesElapsed, 0)
        const rate = roundWithPrecision(usedTokens / minutesElapsed, 0)
        const wastedPercent = (wastedTokens / usedTokens).toLocaleString(undefined, { style: 'percent', minimumFractionDigits: 0 })
        const cachedTokens = this.cachedTokens
        const contextPromptTokens = this.contextPromptTokens
        const contextCompletionTokens = this.contextCompletionTokens
        const contextTokens = contextPromptTokens + contextCompletionTokens
        return {
            promptTokensUsed,
            completionTokensUsed,
            promptTokensWasted,
            completionTokensWasted,
            usedTokens,
            wastedTokens,
            wastedPercent,
            cachedTokens,
            contextPromptTokens,
            contextCompletionTokens,
            contextTokens,
            promptRate,
            completionRate,
            rate,
        }
    }

    async printUsage() {
        const usage = this.usage

        await sleep(10)

        const {
            promptTokensUsed,
            completionTokensUsed,
            promptTokensWasted,
            completionTokensWasted,
            usedTokens,
            wastedTokens,
            wastedPercent,
            cachedTokens,
            contextPromptTokens,
            contextCompletionTokens,
            contextTokens,
            promptRate,
            completionRate,
            rate,
        } = usage

        log.debug(
            `[Translator] Estimated Usage`,
            "\n\tTokens:", promptTokensUsed, "+", completionTokensUsed, "=", usedTokens,
            "\n\tWasted:", promptTokensWasted, "+", completionTokensWasted, "=", wastedTokens, wastedPercent,
            "\n\tCached:", cachedTokens >= 0 ? cachedTokens : "-",
            "\n\tContext:", ...(contextTokens > 0 ? [contextPromptTokens, "+", contextCompletionTokens, "=", contextTokens, "/", this.options.useFullContext, `(${Math.round(contextTokens / this.options.useFullContext * 100)}%)`] : ["-"]),
            "\n\tRate:", promptRate, "+", completionRate, "=", rate, "TPM", this.services.cooler?.rate, "RPM",
        )
    }

    abort() {
        log.warn("[Translator]", "Aborting")
        this.streamController?.abort()
        this.aborted = true
    }
}
