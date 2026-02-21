import log from "loglevel"
import { openaiRetryWrapper, completeChatStream, getPricingModel } from './openai.mjs';
import { checkModeration } from './moderator.mjs';
import { splitStringByNumberLabel } from './subtitle.mjs';
import { roundWithPrecision, sleep } from './helpers.mjs';
import { CooldownContext } from './cooldown.mjs';
import { TranslationOutput } from './translatorOutput.mjs';

/**
 * @typedef TranslationServiceContext
 * @property {import("openai").OpenAI} openai
 * @property {CooldownContext} [cooler]
 * @property {(data: string) => void} [onStreamChunk]
 * @property {() => void} [onStreamEnd]
 * @property {() => void} [onClearLine]
 * @property {import('./moderator.mjs').ModerationServiceContext} [moderationService]
 */

/**
 * @type {TranslatorOptions}
 * @typedef TranslatorOptions
 * @property {Pick<Partial<import('openai').OpenAI.Chat.ChatCompletionCreateParams>, "messages" | "model"> & Omit<import('openai').OpenAI.Chat.ChatCompletionCreateParams, "messages" | "model">} createChatCompletionRequest
 * Options for ChatGPT besides the messages; it is recommended to set `temperature: 0` for an almost deterministic translation
 * @property {import('openai').OpenAI.ModerationModel} moderationModel
 * Moderation model
 * @property {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} initialPrompts
 * Initial prompt messages before the translation request messages
 * @property {boolean} useModerator `false` \
 * Verify with the free OpenAI Moderation tool before submitting the prompt to the ChatGPT model
 * @property {boolean} prefixNumber `true` \
 * Label lines with numerical prefixes to improve the one-to-one correlation between input and output line quantities
 * @property {boolean} lineMatching `true`
 * Enforce one-to-one line quantity matching between input and output
 * @property {number} useFullContext `0` \
 * Max context token budget for history. When > 0, includes as much workingProgress history as fits within this token budget (tracked from actual model response token counts), chunked by the last batchSizes value. Set to 0 to disable.
 * @property {number[]} batchSizes `[10, 100]` \
 * The number of lines to include in each translation prompt, provided they are estimated to fit within the token limit.
 * In case of mismatched output line quantities, this number will be decreased step-by-step according to the values in the array, ultimately reaching one.
 *
 * Larger batch sizes generally lead to more efficient token utilization and potentially better contextual translation.
 * However, mismatched output line quantities or exceeding the token limit will cause token wastage, requiring resubmission of the batch with a smaller batch size.
 * @property {"array" | "object" | "none" | false} structuredMode
 * @property {number} max_token
 * @property {number} inputMultiplier
 * @property {string} fallbackModel
 * @property {import('loglevel').LogLevelDesc} logLevel
 */
export const DefaultOptions = {
    createChatCompletionRequest: {
        model: "gpt-4o-mini"
    },
    moderationModel: "omni-moderation-latest",
    initialPrompts: [],
    useModerator: false,
    prefixNumber: true,
    lineMatching: true,
    useFullContext: 0,
    batchSizes: [10, 100],
    structuredMode: "array",
    max_token: 0,
    inputMultiplier: 0,
    fallbackModel: undefined,
    logLevel: undefined
}

/**
 * Translator using ChatGPT
 */
export class Translator {
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

        /**
         * @type {{ source: string; transform: string; promptTokens?: number; completionTokens?: number; }[]}
         * token counts are the total request cost averaged per entry for batch requests
         */
        this.workingProgress = []
        this.promptTokensUsed = 0
        this.promptTokensWasted = 0
        this.cachedTokens = 0
        this.completionTokensUsed = 0
        this.completionTokensWasted = 0
        this.tokensProcessTimeMs = 0

        this.offset = 0
        this.end = undefined

        this.workingBatchSizes = [...this.options.batchSizes]
        this.currentBatchSize = this.workingBatchSizes[this.workingBatchSizes.length - 1]
        this.moderatorFlags = new Map()

        this.pricingModel = getPricingModel(this.options.createChatCompletionRequest.model)
        this.aborted = false

        this.thinkTags = {
            start: "<think>",
            end: "</think>"
        }

        if (options.logLevel) {
            log.setLevel(options.logLevel)
        }
    }

    /**
     * @param {string[]} lines 
     */
    getMaxToken(lines) {
        if (this.options.max_token && !this.options.inputMultiplier) {
            return this.options.max_token
        }
        else if (this.options.max_token && this.options.inputMultiplier) {
            const max = JSON.stringify(lines).length * this.options.inputMultiplier
            return Math.min(this.options.max_token, max)
        }
        return undefined
    }

    /**
     * @param {string[]} inputLines
     * @param {string} rawContent
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
        if (inputLines.length === 1) {
            return [rawContent.split("\n").join(" ")]
        }
        else {
            return rawContent.split("\n").filter(x => x.trim().length > 0)
        }
    }

    /**
     * @param {string[]} lines
     * @returns {Promise<TranslationOutput>}
     */
    async translatePrompt(lines) {
        const text = lines.join("\n\n")
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        const userMessage = { role: "user", content: `${text}` }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const systemMessage = this.systemInstruction ? [{ role: "system", content: `${this.systemInstruction}` }] : []
        const messages = [...systemMessage, ...this.options.initialPrompts, ...this.promptContext, userMessage]
        const max_tokens = this.getMaxToken(lines)



        let startTime = 0, endTime = 0
        const streamMode = this.options.createChatCompletionRequest.stream
        const response = await openaiRetryWrapper(async () => {
            await this.services.cooler?.cool()
            startTime = Date.now()
            if (!streamMode) {
                const promptResponse = await this.services.openai.chat.completions.create({
                    messages,
                    ...this.options.createChatCompletionRequest,
                    stream: false,
                    max_tokens
                })
                endTime = Date.now()
                const usage = promptResponse.usage
                const rawContent = promptResponse.choices[0].message.content
                const prompt_tokens = usage?.prompt_tokens
                const completion_tokens = usage?.completion_tokens
                const cached_tokens = usage?.prompt_tokens_details?.cached_tokens
                const total_tokens = usage?.total_tokens
                const output = new TranslationOutput(
                    this.getOutput(lines, rawContent),
                    prompt_tokens,
                    completion_tokens,
                    cached_tokens,
                    total_tokens
                )
                return output
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
                        // process.stdout.write(data)
                        this.services.onStreamChunk?.(data)
                    }
                    else if (hasNewline) {
                        writeQueue += data
                        writeQueue = writeQueue.replaceAll("\n\n", "\n")
                    }
                    else {
                        writeQueue += data
                        // process.stdout.write(writeQueue)
                        this.services.onStreamChunk?.(writeQueue)
                        writeQueue = ''
                    }
                }, (u) => {
                    endTime = Date.now()
                    usage = u
                    // process.stdout.write("\n")
                    this.services.onStreamEnd?.()
                })
                const prompt_tokens = usage?.prompt_tokens
                const completion_tokens = usage?.completion_tokens
                const cached_tokens = usage?.prompt_tokens_details?.cached_tokens
                const total_tokens = usage?.total_tokens
                const output = new TranslationOutput(
                    this.getOutput(lines, streamOutput),
                    prompt_tokens,
                    completion_tokens,
                    cached_tokens,
                    total_tokens
                )
                return output
            }
        }, 3, "TranslationPrompt")

        this.promptTokensUsed += response.promptTokens
        this.completionTokensUsed += response.completionTokens
        this.cachedTokens += response.cachedTokens
        this.tokensProcessTimeMs += (endTime - startTime)
        return response
    }

    /**
     * @param {string[]} batch
     */
    async * translateSingle(batch) {
        log.debug(`[Translator]`, "Single line mode")
        batch = batch.slice(-this.currentBatchSize)
        for (let x = 0; x < batch.length; x++) {
            const input = batch[x]
            this.buildContext()
            const output = await this.translatePrompt([input])
            const writeOut = output.content[0]
            yield* this.yieldOutput([batch[x]], [writeOut], output.promptTokens, output.completionTokens)
        }
    }

    /**
     * 
     * @param {string[]} lines 
     */
    async * translateLines(lines) {
        log.debug("[Translator]", "System Instruction:", this.systemInstruction)
        this.aborted = false
        this.workingLines = lines
        const theEnd = this.end ?? lines.length

        for (let index = this.offset, reducedBatchSessions = 0; index < theEnd; index += this.currentBatchSize) {
            let batch = lines.slice(index, index + this.currentBatchSize).map((x, i) => this.preprocessLine(x, i, index))

            if (this.options.useModerator && !this.services.moderationService) {
                log.warn("[Translator]", "Moderation service requested but not configured, no moderation applied")
            }

            if (this.options.useModerator && this.services.moderationService) {
                const inputForModeration = batch.join("\n\n")
                const moderationData = await checkModeration(inputForModeration, this.services.moderationService, this.options.moderationModel)
                if (moderationData.flagged) {
                    if (!this.changeBatchSize('decrease')) // Already at smallest batch size
                    {
                        yield* this.translateSingle(batch)
                    }
                    else {
                        index -= this.currentBatchSize
                    }
                    continue
                }
            }
            this.buildContext()
            const output = await this.translatePrompt(batch)

            if (this.aborted) {
                log.debug("[Translator]", "Aborted")
                return
            }

            let outputs = output.content

            if ((this.options.lineMatching && batch.length !== outputs.length) || (batch.length > 1 && output.refusal)) {
                this.promptTokensWasted += output.promptTokens
                this.completionTokensWasted += output.completionTokens

                if (output.refusal) {
                    log.debug(`[Translator]`, "Refusal: ", output.refusal)
                }
                else {
                    log.debug(`[Translator]`, "Lines count mismatch", batch.length, outputs.length)
                }

                log.debug(`[Translator]`, "batch", batch)
                log.debug(`[Translator]`, "transformed", outputs)

                if (this.changeBatchSize("decrease")) {
                    index -= this.currentBatchSize
                }
                else {
                    yield* this.translateSingle(batch)
                }
            }
            else {
                // Lines are translated in batches but the model returns a single token count
                // for the whole batch request. Since workingProgress is stored per entry and
                // buildContext() slices and sums costs per entry, we divide evenly so that
                // summing any subset of entries approximates the proportional token cost.
                yield* this.yieldOutput(batch, outputs, output.promptTokens / outputs.length, output.completionTokens / outputs.length)
            }

            this.printUsage()

            if (this.batchSizeThreshold && reducedBatchSessions++ >= this.batchSizeThreshold) {
                reducedBatchSessions = 0
                const old = this.currentBatchSize
                this.changeBatchSize("increase")
                index -= (this.currentBatchSize - old)
            }
        }
    }

    /**
     * @param {string[]} promptSources
     * @param {string[]} promptTransforms
     * @param {number} [promptTokensPerEntry] Prompt token cost per entry from the model response, for context budget tracking
     * @param {number} [completionTokensPerEntry] Completion token cost per entry from the model response, for context budget tracking
     */
    * yieldOutput(promptSources, promptTransforms, promptTokensPerEntry, completionTokensPerEntry) {
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
            this.workingProgress.push({ source: promptSource, transform: promptTransform, promptTokens: promptTokensPerEntry, completionTokens: completionTokensPerEntry })
            const output = { index: this.workingProgress.length, source: originalSource, transform: outTransform, finalTransform }
            yield output
        }
    }

    /**
     * @param {string} line
     * @param {number} index
     * @param {number} offset
     */
    preprocessLine(line, index, offset) {
        line = line.replaceAll("\n", " \\N ")
        if (this.options.prefixNumber) {
            line = `${offset + index + 1}. ${line}`
        }
        return line
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
     * @param {"increase" | "decrease"} mode
     */
    changeBatchSize(mode) {
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

    buildContext() {
        if (this.workingProgress.length === 0) {
            return;
        }

        let sliced;
        if (this.options.useFullContext > 0) {
            // Slice workingProgress to fit within the token budget using tracked token counts
            // from actual model responses. Entries without token data are included without
            // contributing to the budget. Allows the first entry that crosses the budget to
            // still be included, since the specified budget is intentionally a buffer below
            // the model's limit.
            const maxTokens = this.options.useFullContext;
            let tokenCount = 0;
            let startIndex = this.workingProgress.length;
            for (let i = this.workingProgress.length - 1; i >= 0; i--) {
                const entry = this.workingProgress[i];
                tokenCount += (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);
                startIndex = i;
                if (tokenCount > maxTokens) break; // include this entry, then stop
            }
            sliced = this.workingProgress.slice(startIndex);
            const logSliceContext = sliced.length < this.workingProgress.length
                ? `sliced ${this.workingProgress.length - sliced.length} entries (${sliced.length}/${this.workingProgress.length} kept, ~${Math.round(tokenCount)} tokens)`
                : `full (${sliced.length} entries, ~${Math.round(tokenCount)} tokens)`
            log.debug("[Translator]", "Context:", logSliceContext)
        } else {
            sliced = this.workingProgress.slice(-this.options.batchSizes[this.options.batchSizes.length - 1]);
        }
        const offset = this.workingProgress.length - sliced.length;

        /**
         * @param {string} text
         * @param {number} index
         */
        const checkFlaggedMapper = (text, index) => {
            const id = index + (offset < 0 ? 0 : offset);
            if (this.moderatorFlags.has(id)) {
                // log.warn("[Translator]", "Prompt Flagged", id, text)
                return this.preprocessLine("-", id, 0);
            }
            return text;
        };

        const checkedSource = sliced.map((x, i) => checkFlaggedMapper(x.source, i));
        const checkedTransform = sliced.map((x, i) => checkFlaggedMapper(x.transform, i));
        this.promptContext = this.getContext(checkedSource, checkedTransform);
    }

    /**
     * @param {string[]} sourceLines
     * @param {string[]} transformLines
     */
    getContext(sourceLines, transformLines) {
        const chunks = [];
        const chunkSize = this.options.batchSizes[this.options.batchSizes.length - 1];
        for (let i = 0; i < sourceLines.length; i += chunkSize) {
            const sourceChunk = sourceLines.slice(i, i + chunkSize);
            const transformChunk = transformLines.slice(i, i + chunkSize);
            chunks.push({
                role: "user",
                content: this.getContextLines(sourceChunk, "user")
            });
            chunks.push({
                role: "assistant",
                content: this.getContextLines(transformChunk, "assistant")
            });
        }
        return /** @type {import('openai').OpenAI.Chat.ChatCompletionMessage[]}*/ (chunks);
    }


    /**
     * @param {string[]} lines 
     * @param {"user" | "assistant" } role
     * @returns {string}
     */
    getContextLines(lines, role) {
        return lines.join("\n\n")
    }

    get usage() {
        if (!this.pricingModel) {
            log.warn("[Translator]", `Cost computation not supported for ${this.options.createChatCompletionRequest.model}`)
        }

        const pricePrompt = this.pricingModel?.prompt
        const priceCompletion = this.pricingModel?.completion

        const usedTokens = this.promptTokensUsed + this.completionTokensUsed
        const wastedTokens = this.promptTokensWasted + this.completionTokensWasted
        const usedTokensPricing = pricePrompt ? roundWithPrecision(pricePrompt * (this.promptTokensUsed / 1000) + priceCompletion * (this.completionTokensUsed / 1000), 3) : NaN
        const wastedTokensPricing = priceCompletion ? roundWithPrecision(pricePrompt * (this.promptTokensWasted / 1000) + priceCompletion * (this.completionTokensWasted / 1000), 3) : NaN
        const rate = roundWithPrecision(usedTokens / (this.tokensProcessTimeMs / 1000 / 60), 2)
        const wastedPercent = (wastedTokens / usedTokens).toLocaleString(undefined, { style: 'percent', minimumFractionDigits: 0 })
        const cachedTokens = this.cachedTokens
        return {
            usedTokens,
            wastedTokens,
            usedTokensPricing,
            wastedTokensPricing,
            wastedPercent,
            cachedTokens,
            rate,
        }
    }

    async printUsage() {
        const usage = this.usage

        await sleep(10)

        const {
            usedTokens,
            wastedTokens,
            usedTokensPricing,
            wastedTokensPricing,
            wastedPercent,
            cachedTokens,
            rate,
        } = usage

        log.debug(
            `[Translator] Estimated Usage -`,
            "Tokens:", usedTokens, "$", usedTokensPricing >= 0 ? usedTokensPricing : "-",
            "Wasted:", wastedTokens, "$", wastedTokensPricing >= 0 ? wastedTokensPricing : "-", wastedPercent,
            "Cached:", cachedTokens >= 0 ? cachedTokens : "-",
            "Rate:", rate, "TPM", this.services.cooler?.rate, "RPM",
        )
    }

    abort() {
        log.warn("[Translator]", "Aborting")
        this.streamController?.abort()
        this.aborted = true
    }
}
