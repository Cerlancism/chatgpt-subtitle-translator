import log from "loglevel"
import { countTokens } from "gpt-tokenizer"
import { roundWithPrecision, sleep } from './helpers.mjs'

/** Context history chunk size (entries) in dynamic batch mode — fixed so chunk
 * boundaries stay stable across batches (required for prefix caching) and small
 * enough for precise window selection. */
const CONTEXT_CHUNK_ENTRIES = 16

/**
 * Runtime context passed to translation service functions.
 *
 * @typedef TranslationServiceContext
 * @property {import("openai").OpenAI} openai - Configured OpenAI client instance
 * @property {import('./cooldown.mjs').CooldownContext} [cooler] - Optional cooldown controller for rate-limit back-off
 * @property {(data: string) => void} [onStreamChunk] - Called for each streamed token chunk
 * @property {() => void} [onStreamEnd] - Called when a stream response finishes
 * @property {() => void} [onClearLine] - Called to erase the current console line (progress UI)
 * @property {(result: { contextSummary?: string, finalInstruction?: string }) => void | Promise<void>} [onAgentPlanningResult] - Called when agent planning produces reusable context
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
 * @property {boolean} skipFitting
 * Skip LLM-based token-range fitting for planning summaries and consolidation in agent mode
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
 * Output record yielded per line by string-based translators.
 * @typedef LineOutput
 * @property {number} index
 * @property {string} source
 * @property {string} transform
 * @property {string} finalTransform
 */

/**
 * @abstract
 * @template [T=string] Input entry type
 * @template [TOut=LineOutput] Output type yielded by translateLines
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
        /** Cached tokens reported by the most recent request (null/undefined if unsupported) */
        this.lastCachedTokens = undefined
        this.completionTokensUsed = 0
        this.completionTokensWasted = 0
        this.tokensProcessTimeMs = 0
        this.contextPromptTokens = 0
        this.contextCompletionTokens = 0
        /** First history chunk index included in the prompt context (stepped window anchor) */
        this.contextAnchor = 0
        /** Measured prompt-context tokens per history entry, from the last context build.
         * Feeds the cache-aware dynamic batch cap; 0 until the first context build. */
        this.contextCostPerEntry = 0
        
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
     * Translates input entries, yielding outputs as they complete.
     * String-based translators yield {@link LineOutput} records;
     * entry-based translators (timestamp) yield their entry type.
     * @param {T[]} _lines
     * @returns {AsyncGenerator<TOut>}
     */
    async * translateLines(_lines) {
        throw new Error(`${this.constructor.name}.translateLines() is not implemented`)
    }

    /**
     * Timing and accumulation wrapper - subclasses override doTranslatePrompt, not this.
     * @param {T[]} lines
     * @returns {Promise<import('./translatorOutput.mjs').TranslationOutput<T[]>>}
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
     * @param {T[]} _lines
     * @returns {Promise<import('./translatorOutput.mjs').TranslationOutput<T[]>>}
     */
    async doTranslatePrompt(_lines) {
        throw new Error(`${this.constructor.name}.doTranslatePrompt() is not implemented`)
    }

    /**
     * Assembles the chat messages for a translation prompt:
     * system instruction, initial prompts, accumulated context, then the user content.
     * @param {string} [userContent] - omit to send no user message (schema-only modes)
     * @param {string} [systemContent] - defaults to the system instruction
     * @returns {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]}
     */
    buildPromptMessages(userContent, systemContent = this.systemInstruction) {
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const messages = systemContent ? [{ role: "system", content: `${systemContent}` }] : []
        messages.push(...this.options.initialPrompts, ...this.promptContext)
        if (userContent !== undefined) {
            messages.push({ role: "user", content: userContent })
        }
        return messages
    }

    /**
     * @param {T[]} lines
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
     * @template C
     * @param {import('./translatorOutput.mjs').TranslationOutput<C>} output
     * @param {number} elapsedMs - time elapsed for this request in milliseconds
     * @returns {import('./translatorOutput.mjs').TranslationOutput<C>}
     */
    accumulateUsage(output, elapsedMs) {
        this.promptTokensUsed += output.promptTokens
        this.completionTokensUsed += output.completionTokens
        if (output.cachedTokens != null) {
            this.cachedTokens = (this.cachedTokens ?? 0) + output.cachedTokens
        }
        this.lastCachedTokens = output.cachedTokens
        this.contextPromptTokens = output.promptTokens
        this.contextCompletionTokens = output.completionTokens
        this.tokensProcessTimeMs += elapsedMs
        return output
    }

    /**
     * History chunk size for context building: the last (largest) fixed batch size,
     * or a fixed constant in dynamic mode. The size must not change between batches —
     * chunk boundaries define the prompt context prefix, and reshaping them (as the
     * per-batch dynamic size would) breaks server-side prefix caching. The constant
     * also keeps chunks fine-grained so the stepped context window can select
     * precisely within the token budget.
     */
    get contextChunkSize() {
        return this.options.batchSizes?.[this.options.batchSizes.length - 1] ?? CONTEXT_CHUNK_ENTRIES
    }

    /**
     * Logs which portion of the translation history was kept for the prompt context.
     * @param {number} includedEntries
     * @param {number} totalEntries
     * @param {number} tokenCount
     */
    logContextSelection(includedEntries, totalEntries, tokenCount) {
        if (this.options.useFullContext <= 0) {
            return
        }
        if (includedEntries > 0 && tokenCount > 0) {
            this.contextCostPerEntry = tokenCount / includedEntries
        }
        const message = includedEntries < totalEntries
            ? `sliced ${totalEntries - includedEntries} entries (${includedEntries}/${totalEntries} kept, ${tokenCount} tokens)`
            : `all (${includedEntries} entries, ${tokenCount} tokens)`
        log.debug(`[${this.constructor.name}]`, "Context:", message)
    }

    /**
     * Selects history chunks for the prompt context using a stepped (anchored) window
     * that fits within the useFullContext token budget. When budget is disabled (≤ 0),
     * returns only the last chunk.
     *
     * The window start (`contextAnchor`) stays fixed across batches so the prompt prefix
     * remains byte-stable for server-side prefix caching. The anchor only jumps forward
     * when the suffix overflows the budget, shedding enough chunks to leave headroom
     * (down to ~half the budget) before the next jump - one cache miss per jump instead
     * of one per batch. If chunk boundaries shift under the anchor (e.g. dynamic batch
     * size changes), the anchor walks back to refill the window up to the same headroom.
     * @template T
     * @param {T[]} chunks
     * @param {(chunk: T) => number} getChunkCost
     * @returns {{ includedChunks: T[], tokenCount: number }}
     */
    selectContextChunks(chunks, getChunkCost) {
        const maxTokens = this.options.useFullContext
        if (maxTokens <= 0 || chunks.length === 0) {
            const includedCount = Math.min(1, chunks.length)
            return { includedChunks: chunks.slice(chunks.length - includedCount), tokenCount: 0 }
        }

        const headroomTarget = Math.floor(maxTokens / 2)
        const anchorWasClamped = this.contextAnchor > chunks.length - 1
        let anchor = Math.min(this.contextAnchor, chunks.length - 1)

        const suffixCosts = []
        let tokenCount = 0
        for (let i = anchor; i < chunks.length; i++) {
            const cost = getChunkCost(chunks[i])
            suffixCosts.push(cost)
            tokenCount += cost
        }

        if (tokenCount > maxTokens) {
            // Overflow: jump the anchor forward, always keeping at least the most recent chunk.
            // Mandatory drops enforce the budget; optional drops add headroom for future growth
            // but never shed below the headroom target (coarse chunks would otherwise leave
            // almost no context).
            let drop = 0
            while (anchor < chunks.length - 1 && tokenCount > maxTokens) {
                tokenCount -= suffixCosts[drop++]
                anchor++
            }
            while (anchor < chunks.length - 1 && tokenCount - suffixCosts[drop] >= headroomTarget) {
                tokenCount -= suffixCosts[drop++]
                anchor++
            }
        }
        else {
            // Refill: only reachable when chunk boundaries shifted under the anchor
            // (in steady state the chunk dropped last would exceed the headroom target).
            // After a clamp the cache prefix is already lost this batch, so refill up to
            // the full budget; otherwise cap at the headroom target to avoid creep-back.
            const fillLimit = anchorWasClamped ? maxTokens : headroomTarget
            while (anchor > 0) {
                const cost = getChunkCost(chunks[anchor - 1])
                if (tokenCount + cost > fillLimit) break
                tokenCount += cost
                anchor--
            }
        }

        this.contextAnchor = anchor
        return { includedChunks: chunks.slice(anchor), tokenCount }
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
        const lastCachedTokens = this.lastCachedTokens
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
            lastCachedTokens,
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
            lastCachedTokens,
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
            "\n\tCached:", ...(lastCachedTokens != null && cachedTokens >= 0
                ? [cachedTokens - lastCachedTokens, "+", lastCachedTokens, "=", cachedTokens]
                : [cachedTokens > 0 ? cachedTokens : "-"]),
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
