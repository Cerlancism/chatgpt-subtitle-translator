import log from "loglevel"
import { countTokens } from "gpt-tokenizer"
import { openaiRetryWrapper, completeChatStream } from './openai.mjs';
import { detectRepetition } from 'llm-summary';
import { checkModeration } from './moderator.mjs';
import { splitStringByNumberLabel } from './subtitle.mjs';
import { roundWithPrecision } from './helpers.mjs';
import { TranslatorBase, DefaultOptions, CONTEXT_HEADROOM_FRACTION } from './translatorBase.mjs';
import { TranslationOutput } from './translatorOutput.mjs';

export { DefaultOptions }

export const AUTO_BATCH_MIN = 3
export const AUTO_BATCH_REDUCTION = 3
/** Number of dynamic batches whose history fits in the context window's growth span
 * (the part of the budget freed when the window is trimmed, see selectContextChunks).
 * Each trim moves the window anchor and misses the server-side prompt prefix cache,
 * so this is roughly the number of batches served per cache miss. */
export const CACHE_WINDOW_BATCH_CYCLES = 3

/**
 * Computes an evened-out batch size for the next dynamic batch.
 *
 * A naive greedy fill (take as many entries as fit in `budget`, repeat) leaves a
 * small remainder at the tail end, e.g. entries weighted to fit 30/batch over 100
 * entries yield [30, 30, 30, 10]. Instead we:
 *   1. Greedily count how many batches `B` the remaining entries need at full budget.
 *   2. Spread the remaining token load evenly across `B` batches, so the per-batch
 *      target becomes `remainingTokens / B` rather than the full `budget`,
 *      producing [25, 25, 25, 25].
 *
 * Recomputed each iteration, so per-entry token variance and mid-stream budget
 * reductions self-correct. The hard `budget` is never exceeded, and the result is
 * at least `AUTO_BATCH_MIN` (unless fewer entries remain).
 *
 * @param {number[]} weights - per-entry token counts, indexed globally
 * @param {number} startIndex - index of the first unprocessed entry
 * @param {number} budget - hard per-batch token budget
 * @returns {number} number of entries to include in the next batch
 */
export function computeEvenBatchSize(weights, startIndex, budget) {
    const remaining = weights.length - startIndex
    if (remaining <= 0) return 0
    if (budget <= 0) return remaining

    // Step 1: greedily count batches and total tokens over the remaining range.
    let batchCount = 0
    let remainingTokens = 0
    let batchTokens = 0
    let batchEntries = 0
    for (let i = startIndex; i < weights.length; i++) {
        const w = weights[i]
        remainingTokens += w
        if (batchEntries > 0 && batchTokens + w > budget) {
            batchCount++
            batchTokens = 0
            batchEntries = 0
        }
        batchTokens += w
        batchEntries++
    }
    if (batchEntries > 0) batchCount++
    if (batchCount <= 1) return remaining

    // Step 2: even per-batch token target across the counted batches.
    const targetTokens = remainingTokens / batchCount

    let tokensSoFar = 0
    let count = 0
    for (let i = startIndex; i < weights.length; i++) {
        const w = weights[i]
        if (count > 0 && (tokensSoFar + w > budget || tokensSoFar + w > targetTokens)) break
        tokensSoFar += w
        count++
    }
    return Math.max(AUTO_BATCH_MIN, count)
}

/**
 * @typedef {import('./translatorBase.mjs').TranslationServiceContext} TranslationServiceContext
 * @typedef {import('./translatorBase.mjs').TranslatorOptions} TranslatorOptions
 */

/**
 * @template [T=string] Input entry type
 * @template [TOut=import('./translatorBase.mjs').LineOutput] Output type yielded by translateLines
 * @extends {TranslatorBase<T, TOut>}
 * Translator using ChatGPT - string-based implementation.
 */
export class Translator extends TranslatorBase {
    /**
     * @param {{from?: string, to: string}} language
     * @param {TranslationServiceContext} services
     * @param {Partial<TranslatorOptions>} [options]
     */
    constructor(language, services, options) {
        super(language, services, options)

        /**
         * @type {{ source: string; transform: string; completionTokens?: number; }[]}
         * token counts are the total request cost averaged per entry for batch requests
         */
        this.workingProgress = []
        this.offset = 0
        this.end = undefined
        this.moderatorFlags = new Map()

        this.thinkTags = {
            start: "<think>",
            end: "</think>"
        }
    }

    /**
     * Repetition detection callback for streaming abort guards.
     * Returns the repeated pattern if detected, or `null`.
     * Disabled when `options.guardRepetition` is `0`.
     * @param {string} buffer
     * @returns {string | null}
     */
    checkRepetition(buffer) {
        const threshold = this._effectiveGuardRepetition ?? this.options.guardRepetition
        if (!threshold) return null
        return detectRepetition(buffer, 2, 500, threshold)
    }

    /**
     * Plain-text content of one input entry, used for repetition guarding,
     * moderation input and token weighting. Entry-based subclasses override.
     * @param {T} line
     * @returns {string}
     */
    getLineText(line) {
        return String(line)
    }

    /**
     * Checks input lines for existing repetition patterns.
     * If the input already meets the guard threshold, raises the effective threshold to 3x to avoid false aborts.
     * @param {T[]} lines
     */
    adjustGuardForInputRepetition(lines) {
        this._effectiveGuardRepetition = undefined
        const threshold = this.options.guardRepetition
        if (!threshold) return
        const text = lines.map(l => this.getLineText(l)).join("\n")
        const pattern = detectRepetition(text, 2, 500, threshold)
        if (!pattern) return
        const boosted = threshold * 3
        this._effectiveGuardRepetition = boosted
        log.warn(`[Translator]`, `Input contains repeated pattern "${pattern.slice(0, 50)}" - raising repetition guard threshold from ${threshold} to ${boosted}`)
    }

    /**
     * Splits the raw model response into output lines, stripping any think block.
     * String mode assumes T = string.
     * @param {T[]} inputLines
     * @param {string} rawContent
     * @returns {T[]}
     */
    getOutput(inputLines, rawContent) {
        rawContent = rawContent.trim()
        if (rawContent.startsWith(this.thinkTags.start)) {
            const endTagIndex = rawContent.indexOf(this.thinkTags.end)
            if (endTagIndex > 0) {
                const endIndex = endTagIndex + this.thinkTags.end.length
                const thinkBlock = rawContent.slice(0, endIndex).trim()
                if (thinkBlock) {
                    log.debug("[Translator]", "[ThinkBlock] Detected\n", thinkBlock)
                }
                rawContent = rawContent.slice(endIndex)
            }
        }
        const lines = inputLines.length === 1
            ? [rawContent.split("\n").join(" ")]
            : rawContent.split("\n").filter(x => x.trim().length > 0)
        return /** @type {T[]} */ (/** @type {unknown} */ (lines))
    }

    /**
     * @override
     * @param {T[]} lines
     * @returns {Promise<TranslationOutput<T[]>>}
     */
    async doTranslatePrompt(lines) {
        const text = lines.join("\n\n")
        const messages = this.buildPromptMessages(`${text}`)
        const max_tokens = this.getMaxToken(lines)

        const streamMode = this.options.createChatCompletionRequest.stream
        return openaiRetryWrapper(async () => {
            await this.services.cooler?.cool()
            if (!streamMode) {
                const promptResponse = await this.services.openai.chat.completions.create({
                    messages,
                    ...this.options.createChatCompletionRequest,
                    stream: false,
                    max_tokens
                })
                const rawContent = promptResponse.choices[0].message.content
                return TranslationOutput.fromUsage(this.getOutput(lines, rawContent), promptResponse.usage)
            }
            else {
                const promptResponse = await this.services.openai.chat.completions.create({
                    messages,
                    ...this.options.createChatCompletionRequest,
                    stream: true,
                    stream_options: {
                        include_usage: true
                    },
                    max_tokens
                })

                this.streamController = promptResponse.controller

                let writeQueue = ''
                /** @type {import('openai').OpenAI.Completions.CompletionUsage} */
                let usage
                const streamOutput = await completeChatStream(promptResponse, /** @param {string} data */(data) => {
                    const hasNewline = data.includes("\n")
                    if (writeQueue.length === 0 && !hasNewline) {
                        this.services.onStreamChunk?.(data)
                    }
                    else if (hasNewline) {
                        writeQueue += data
                        writeQueue = writeQueue.replaceAll("\n\n", "\n")
                    }
                    else {
                        writeQueue += data
                        this.services.onStreamChunk?.(writeQueue)
                        writeQueue = ''
                    }
                }, (u) => {
                    usage = u
                    this.services.onStreamEnd?.()
                }, (buffer) => {
                    return this.checkRepetition(buffer)
                })
                return TranslationOutput.fromUsage(this.getOutput(lines, streamOutput), usage)
            }
        }, 3, "TranslationPrompt")
    }

    /**
     * @param {T[]} batch
     * @param {T[]} outputs
     * @returns {boolean}
     */
    evaluateBatchOutput(batch, outputs) {
        const isMismatch = this.options.lineMatching && batch.length !== outputs.length
        if (isMismatch) {
            log.debug(`[Translator]`, "Lines count mismatch", batch.length, outputs.length)
            log.debug(`[Translator]`, "batch", batch)
            log.debug(`[Translator]`, "transformed", outputs)
        }
        return isMismatch
    }

    /**
     * Translates a failed batch one entry at a time.
     * @param {T[]} batch
     * @returns {AsyncGenerator<TOut>}
     */
    async * translateSingle(batch) {
        log.debug(`[${this.constructor.name}]`, "Single line mode")
        batch = batch.slice(-this.currentBatchSize)
        for (const input of batch) {
            this.adjustGuardForInputRepetition([input])
            this.buildContext()
            const output = await this.translatePrompt([input])
            this._effectiveGuardRepetition = undefined
            yield* this.yieldSingleSuccess(input, output)
        }
    }

    /**
     * Token weight of one input entry for dynamic batch sizing.
     * @param {T} line
     * @returns {number}
     */
    getLineTokenWeight(line) {
        return countTokens(this.getLineText(line))
    }

    /**
     * Input-token budget of one dynamic batch: the context window's growth span shared
     * by CACHE_WINDOW_BATCH_CYCLES batches, converted from history cost to input tokens
     * with the measured (or prior) history cost ratio.
     */
    get dynamicBatchBudget() {
        const growthSpan = this.options.useFullContext * (1 - CONTEXT_HEADROOM_FRACTION)
        return Math.floor(growthSpan / CACHE_WINDOW_BATCH_CYCLES / this.historyCostRatio)
    }

    /**
     * Computes how many lines starting at startIndex fit within the dynamic batch budget.
     * The reduction factor shrinks the budget *before* evening so the remaining
     * lines stay balanced even in a reduced state.
     * Returns at least AUTO_BATCH_MIN.
     * @param {T[]} lines
     * @param {number} startIndex
     * @param {number} [reductionFactor]
     * @returns {number}
     */
    computeDynamicBatchSize(lines, startIndex, reductionFactor = 1) {
        if (!this.options.useFullContext) {
            return lines.length - startIndex
        }
        const budget = Math.floor(this.dynamicBatchBudget / reductionFactor)
        if (budget <= 0) {
            return Math.min(AUTO_BATCH_MIN, lines.length - startIndex)
        }
        const weights = lines.map(l => this.getLineTokenWeight(l))
        return computeEvenBatchSize(weights, startIndex, budget)
    }

    /**
     * Recomputes and logs the dynamic batch size for the batch starting at index.
     * @param {T[]} lines
     * @param {number} index
     */
    applyDynamicBatchSize(lines, index) {
        this.currentBatchSize = this.computeDynamicBatchSize(lines, index, this.dynamicReductionFactor)
        const reduction = this.dynamicReductionFactor > 1 ? `, reduction x${this.dynamicReductionFactor}` : ""
        log.debug(`[${this.constructor.name}]`, "Dynamic batch size:", this.currentBatchSize,
            `(budget: ${this.dynamicBatchBudget} tokens, history cost ratio: ${roundWithPrecision(this.historyCostRatio, 1)}x${reduction})`)
    }

    /**
     * Decides how to recover after a failed batch (line mismatch, refusal or moderation flag).
     * Shrinks the batch size for a retry when possible; otherwise signals the caller
     * to fall back to single-entry mode. On "retry" the caller rewinds its loop index
     * by `currentBatchSize` to resubmit the same range with the reduced size.
     * @returns {"single" | "retry"}
     */
    resolveBatchFailure() {
        if (this.isDynamicBatch) {
            if (this.currentBatchSize <= AUTO_BATCH_MIN) {
                this.dynamicReductionFactor = 1
                return "single"
            }
            this.dynamicReductionFactor *= AUTO_BATCH_REDUCTION
            return "retry"
        }
        return this.changeBatchSize("decrease") ? "retry" : "single"
    }

    /**
     * Records the tokens of a failed batch as wasted and logs any refusal.
     * @param {TranslationOutput<T[]>} output
     */
    recordWaste(output) {
        this.promptTokensWasted += output.promptTokens
        this.completionTokensWasted += output.completionTokens
        if (output.refusal) {
            log.debug(`[${this.constructor.name}]`, "Refusal:", output.refusal)
        }
    }

    /**
     * Adjusts batch sizing after a successful batch. In dynamic mode, gradually
     * eases the reduction factor back toward 1; in fixed mode, ramps the batch
     * size back up once the success threshold is reached.
     * @param {number} reducedBatchSessions
     * @returns {{ reducedBatchSessions: number, indexDelta: number }}
     *   Updated session counter and an index adjustment for the caller's loop.
     */
    adjustBatchOnSuccess(reducedBatchSessions) {
        let indexDelta = 0
        if (this.isDynamicBatch) {
            if (this.dynamicReductionFactor > 1 && reducedBatchSessions++ >= AUTO_BATCH_REDUCTION) {
                reducedBatchSessions = 0
                this.dynamicReductionFactor = Math.max(1, this.dynamicReductionFactor / AUTO_BATCH_REDUCTION)
            }
        } else if (this.batchSizeThreshold && reducedBatchSessions++ >= this.batchSizeThreshold) {
            reducedBatchSessions = 0
            const old = this.currentBatchSize
            this.changeBatchSize("increase")
            indexDelta = this.currentBatchSize - old
        }
        return { reducedBatchSessions, indexDelta }
    }

    /**
     * Text submitted to the moderation endpoint for a batch.
     * @param {T[]} batch
     * @returns {string}
     */
    getModerationInput(batch) {
        return batch.map(l => this.getLineText(l)).join("\n\n")
    }

    /**
     * Emits the outputs of a successful batch and records them into the history.
     * String mode assumes T = string; entry-based subclasses override.
     * @param {T[]} batch
     * @param {T[]} outputs
     * @param {TranslationOutput<T[]>} output
     * @returns {Generator<TOut>}
     */
    * yieldBatchSuccess(batch, outputs, output) {
        // Lines are translated in batches but the model returns a single token count
        // for the whole batch request. Since workingProgress is stored per entry and
        // buildContext() slices and sums costs per entry, we divide evenly so that
        // summing any subset of entries approximates the proportional token cost.
        const sources = /** @type {string[]} */ (/** @type {unknown} */ (batch))
        const transforms = /** @type {string[]} */ (/** @type {unknown} */ (outputs))
        yield* this.yieldOutput(sources, transforms, output.completionTokens / outputs.length)
    }

    /**
     * Emits the output of one successfully translated entry in single mode.
     * String mode assumes T = string; entry-based subclasses override.
     * @param {T} input
     * @param {TranslationOutput<T[]>} output
     * @returns {Generator<TOut>}
     */
    * yieldSingleSuccess(input, output) {
        const source = /** @type {string} */ (/** @type {unknown} */ (input))
        const transform = /** @type {string} */ (/** @type {unknown} */ (output.content[0]))
        yield* this.yieldOutput([source], [transform], output.completionTokens)
    }

    /**
     * @param {T[]} lines
     * @returns {AsyncGenerator<TOut>}
     */
    async * translateLines(lines) {
        log.debug(`[${this.constructor.name}]`, "System Instruction:", this.systemInstruction)
        this.aborted = false
        this.workingLines = lines
        const theEnd = this.end ?? lines.length

        for (let index = this.offset, reducedBatchSessions = 0; index < theEnd; index += this.currentBatchSize) {
            if (this.isDynamicBatch) {
                this.applyDynamicBatchSize(lines, index)
            }

            let batch = lines.slice(index, index + this.currentBatchSize).map((x, i) => this.preprocessLine(x, i, index))

            if (this.options.useModerator && !this.services.moderationService) {
                log.warn(`[${this.constructor.name}]`, "Moderation service requested but not configured, no moderation applied")
            }

            if (this.options.useModerator && this.services.moderationService) {
                const moderationData = await checkModeration(this.getModerationInput(batch), this.services.moderationService, this.options.moderationModel)
                if (moderationData.flagged) {
                    if (this.resolveBatchFailure() === "single") {
                        yield* this.translateSingle(batch)
                    } else {
                        index -= this.currentBatchSize
                    }
                    continue
                }
            }
            this.adjustGuardForInputRepetition(batch)
            this.buildContext()
            const output = await this.translatePrompt(batch)
            this._effectiveGuardRepetition = undefined

            if (this.aborted) {
                log.debug(`[${this.constructor.name}]`, "Aborted")
                return
            }

            const outputs = /** @type {T[]} */ (output.content)

            if (this.evaluateBatchOutput(batch, outputs) || (batch.length > 1 && output.refusal)) {
                this.recordWaste(output)

                if (this.resolveBatchFailure() === "single") {
                    yield* this.translateSingle(batch)
                } else {
                    index -= this.currentBatchSize
                }
            }
            else {
                yield* this.yieldBatchSuccess(batch, outputs, output)

                const adjusted = this.adjustBatchOnSuccess(reducedBatchSessions)
                reducedBatchSessions = adjusted.reducedBatchSessions
                index -= adjusted.indexDelta
            }

            this.printUsage()
        }
    }

    /**
     * Builds and yields per-line output records, recording them into workingProgress
     * and the batch into the context history.
     * String mode only - assumes TOut is {@link import('./translatorBase.mjs').LineOutput}.
     * @param {string[]} promptSources
     * @param {string[]} promptTransforms
     * @param {number} [completionTokensPerEntry] Completion token cost per entry from the model response, for context budget tracking
     * @returns {Generator<TOut>}
     */
    * yieldOutput(promptSources, promptTransforms, completionTokensPerEntry) {
        const start = this.workingProgress.length
        let inputTokens = 0
        for (let index = 0; index < promptSources.length; index++) {
            const promptSource = promptSources[index];
            const promptTransform = promptTransforms[index] ?? ""
            const workingIndex = this.workingProgress.length
            const originalSource = this.workingLines[workingIndex]
            let finalTransform = promptTransform
            let outTransform = promptTransform

            if (this.moderatorFlags.has(workingIndex)) {
                finalTransform = `[Flagged][Moderator] ${originalSource} -> ${finalTransform} `
            }
            else if (this.options.prefixNumber) {
                const splits = this.postprocessNumberPrefixedLine(finalTransform)
                finalTransform = splits.text
                outTransform = splits.text
                const expectedLabel = workingIndex + 1
                if (expectedLabel !== splits.number) {
                    log.warn("[Translator]", "Label mismatch", expectedLabel, splits.number)
                    this.moderatorFlags.set(workingIndex, { remarks: "Label Mismatch", outIndex: splits.number })
                    finalTransform = `[Flagged][Model] ${originalSource} -> ${finalTransform}`
                }
            }
            else {
                finalTransform = this.postprocessLine(finalTransform)
            }
            this.workingProgress.push({ source: promptSource, transform: promptTransform, completionTokens: completionTokensPerEntry })
            inputTokens += this.getLineTokenWeight(originalSource)
            const output = { index: this.workingProgress.length, source: originalSource, transform: outTransform, finalTransform }
            yield /** @type {TOut} */ (/** @type {unknown} */ (output))
        }
        this.recordHistoryChunk(this.renderHistoryChunk(start, this.workingProgress.length), promptSources.length, inputTokens)
    }

    /**
     * Prepares one input entry for the prompt. String mode flattens newlines and
     * optionally applies a numeric prefix; entry-based subclasses override.
     * @param {T} line
     * @param {number} index
     * @param {number} offset
     * @returns {T}
     */
    preprocessLine(line, index, offset) {
        let text = /** @type {string} */ (/** @type {unknown} */ (line))
        text = text.replaceAll("\n", " \\N ")
        if (this.options.prefixNumber) {
            text = `${offset + index + 1}. ${text}`
        }
        return /** @type {T} */ (/** @type {unknown} */ (text))
    }

    /**
     * @param {string} line
     */
    postprocessNumberPrefixedLine(line) {
        const splits = splitStringByNumberLabel(line.trim())
        splits.text = this.postprocessLine(splits.text)
        return splits
    }

    /**
     * @param {string} line
     */
    postprocessLine(line) {
        line = line.replaceAll(" \\N ", "\n")
        line = line.replaceAll("\\N", "\n")
        return line
    }

    /**
     * @override Records any history seeded outside of translateLines (progress resumption)
     * before building the context.
     */
    buildContext() {
        this.recordSeededHistory()
        super.buildContext()
    }

    /**
     * Records workingProgress entries not yet in the context history (seeded by progress
     * resumption) as batches of the size the batching would have sent them in, so they
     * form stable context chunks like translated batches do.
     */
    recordSeededHistory() {
        const seeded = this.workingProgress.length
        if (this.historyLength >= seeded) return
        const lines = /** @type {T[]} */ (this.workingLines ?? this.workingProgress.map(e => e.source)).slice(0, seeded)
        for (let start = this.historyLength; start < seeded;) {
            const size = this.isDynamicBatch ? this.computeDynamicBatchSize(lines, start) : this.options.batchSizes.at(-1)
            const end = Math.min(start + size, seeded)
            const inputTokens = lines.slice(start, end).reduce((sum, l) => sum + this.getLineTokenWeight(l), 0)
            this.recordHistoryChunk(this.renderHistoryChunk(start, end), end - start, inputTokens)
            start = end
        }
    }

    /**
     * Renders a range of workingProgress entries as prompt context messages,
     * substituting a placeholder for flagged entries.
     * @param {number} start
     * @param {number} end
     * @returns {import("openai").OpenAI.Chat.ChatCompletionMessageParam[]}
     */
    renderHistoryChunk(start, end) {
        const entries = this.workingProgress.slice(start, end)
        /** @param {string} text @param {number} index */
        const checkFlagged = (text, index) => {
            if (!this.moderatorFlags.has(index)) return text
            const placeholder = /** @type {T} */ (/** @type {unknown} */ ("-"))
            return this.getLineText(this.preprocessLine(placeholder, index, 0))
        }
        const sources = entries.map((e, i) => checkFlagged(e.source, start + i))
        const transforms = entries.map((e, i) => checkFlagged(e.transform, start + i))
        return this.getContext(sources, transforms)
    }

    /**
     * Prompt context messages of one translated batch: its user/assistant message pair.
     * @param {string[]} sourceLines
     * @param {string[]} transformLines
     */
    getContext(sourceLines, transformLines) {
        return /** @type {import('openai').OpenAI.Chat.ChatCompletionMessage[]}*/ ([
            { role: "user", content: this.getContextLines(sourceLines, "user") },
            { role: "assistant", content: this.getContextLines(transformLines, "assistant") },
        ]);
    }


    /**
     * @param {string[]} lines
     * @param {"user" | "assistant" } role
     * @returns {string}
     */
    getContextLines(lines, role) {
        return lines.join("\n\n")
    }
}
