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
 * @property {import('./moderator.mjs').ModerationServiceContext} [moderationService]
 */

/**
 * @type {TranslatorOptions}
 * @typedef TranslatorOptions
 * @property {Pick<Partial<import('openai').OpenAI.Chat.ChatCompletionCreateParams>, "messages" | "model"> & Omit<import('openai').OpenAI.Chat.ChatCompletionCreateParams, "messages" | "model">} createChatCompletionRequest
 * Options to ChatGPT besides the messages, it is recommended to set `temperature: 0` for a (almost) deterministic translation
 * @property {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} initialPrompts 
 * Initiation prompt messages before the translation request messages
 * @property {boolean} useModerator `true` \
 * Verify with the free OpenAI Moderation tool prior to submitting the prompt to ChatGPT model
 * @property {boolean} prefixNumber `true` \
 * Label lines with numerical prefixes to improve the one-to-one correlation between line quantities for input and output
 * @property {boolean} lineMatching `true`
 * Enforce one to one line quantity input output matching
 * @property {number} historyPromptLength `10` \
 * Length of the prompt history to be retained and passed over to the next translation request in order to maintain some context.
 * @property {number[]} batchSizes `[10, 100]` \
 * The number of lines to include in each translation prompt, provided that they are estimated to within the token limit. 
 * In case of mismatched output line quantities, this number will be decreased step-by-step according to the values in the array, ultimately reaching one.
 * 
 * Larger batch sizes generally lead to more efficient token utilization and potentially better contextual translation. 
 * However, mismatched output line quantities or exceeding the token limit will cause token wastage, requiring resubmission of the batch with a smaller batch size.
 * @property {boolean | "array" | "object" } structuredMode
 * @property {number} max_token
 * @property {number} inputMultiplier
 */
export const DefaultOptions = {
    createChatCompletionRequest: {
        model: "gpt-4o-mini"
    },
    initialPrompts: [],
    useModerator: true,
    prefixNumber: true,
    lineMatching: true,
    historyPromptLength: 10,
    batchSizes: [10, 100],
    structuredMode: false,
    max_token: 0,
    inputMultiplier: 0
}
/**
 * Translator using ChatGPT
 */
export class Translator
{
    /**
     * @param {{from?: string, to: string}} language
     * @param {TranslationServiceContext} services
     * @param {Partial<TranslatorOptions>} [options]
     */
    constructor(language, services, options)
    {
        options.createChatCompletionRequest = { ...DefaultOptions.createChatCompletionRequest, ...options.createChatCompletionRequest }

        this.language = language
        this.services = services
        this.options = /** @type {TranslatorOptions & {createChatCompletionRequest: {model: string}}} */ ({ ...DefaultOptions, ...options })
        this.systemInstruction = `Translate ${this.language.from ? this.language.from + " " : ""}to ${this.language.to}`
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        this.promptContext = []

        /** @type {{ source: string; transform: string; }[]} */
        this.workingProgress = []
        this.promptTokensUsed = 0
        this.promptTokensWasted = 0
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
    }

    /**
     * @param {string[]} lines 
     */
    getMaxToken(lines)
    {
        if (this.options.max_token && !this.options.inputMultiplier)
        {
            return this.options.max_token
        }
        else if (this.options.max_token && this.options.inputMultiplier)
        {
            const max = JSON.stringify(lines).length * this.options.inputMultiplier
            return Math.min(this.options.max_token, max)
        }
        return undefined
    }

    /**
     * @param {string[]} lines
     * @returns {Promise<TranslationOutput>}
     */
    async translatePrompt(lines)
    {
        const text = lines.join("\n\n")
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        const userMessage = { role: "user", content: `${text}` }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const systemMessage = this.systemInstruction ? [{ role: "system", content: `${this.systemInstruction}` }] : []
        const messages = [...systemMessage, ...this.options.initialPrompts, ...this.promptContext, userMessage]
        const max_tokens = this.getMaxToken(lines)

        /**
         * @param {string} text 
         */
        function getOutput(text)
        {
            if (lines.length === 1)
            {
                return [text.split("\n").join(" ")]
            }
            else
            {
                return text.split("\n").filter(x => x.trim().length > 0)
            }
        }

        let startTime = 0, endTime = 0
        const streamMode = this.options.createChatCompletionRequest.stream 
        const response = await openaiRetryWrapper(async () =>
        {
            await this.services.cooler?.cool()
            startTime = Date.now()
            if (!streamMode)
            {
                const promptResponse = await this.services.openai.chat.completions.create({
                    messages,
                    ...this.options.createChatCompletionRequest,
                    stream: false,
                    max_tokens
                })
                endTime = Date.now()
                const output = new TranslationOutput(
                    getOutput(promptResponse.choices[0].message.content),
                    promptResponse.usage?.prompt_tokens,
                    promptResponse.usage?.completion_tokens,
                    promptResponse.usage?.total_tokens
                )
                return output
            }
            else
            {
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
                const streamOutput = await completeChatStream(promptResponse, /** @param {string} data */(data) =>
                {
                    const hasNewline = data.includes("\n")
                    if (writeQueue.length === 0 && !hasNewline)
                    {
                        // process.stdout.write(data)
                        this.services.onStreamChunk?.(data)
                    }
                    else if (hasNewline)
                    {
                        writeQueue += data
                        writeQueue = writeQueue.replaceAll("\n\n", "\n")
                    }
                    else
                    {
                        writeQueue += data
                        // process.stdout.write(writeQueue)
                        this.services.onStreamChunk?.(writeQueue)
                        writeQueue = ''
                    }
                }, (u) =>
                {
                    endTime = Date.now()
                    usage = u
                    // process.stdout.write("\n")
                    this.services.onStreamEnd?.()
                })
                const prompt_tokens = usage.prompt_tokens
                const completion_tokens = usage.completion_tokens
                const output = new TranslationOutput(
                    getOutput(streamOutput),
                    prompt_tokens,
                    completion_tokens
                )
                return output
            }
        }, 3, "TranslationPrompt")

        this.promptTokensUsed += response.promptTokens
        this.completionTokensUsed += response.completionTokens
        this.tokensProcessTimeMs += (endTime - startTime)
        return response
    }

    /**
     * @param {string[]} batch
     */
    async * translateSingle(batch)
    {
        console.error(`[Translator]`, "Single line mode")
        batch = batch.slice(-this.currentBatchSize)
        for (let x = 0; x < batch.length; x++)
        {
            const input = batch[x]
            this.buildContext()
            const output = await this.translatePrompt([input])
            const writeOut = output.content[0]
            yield* this.yieldOutput([batch[x]], [writeOut])
        }
    }

    /**
     * 
     * @param {string[]} lines 
     */
    async * translateLines(lines)
    {
        console.error("[Translator]", "System Instruction:", this.systemInstruction)
        this.aborted = false
        this.workingLines = lines
        const theEnd = this.end ?? lines.length

        for (let index = this.offset, reducedBatchSessions = 0; index < theEnd; index += this.currentBatchSize)
        {
            let batch = lines.slice(index, index + this.currentBatchSize).map((x, i) => this.preprocessLine(x, i, index))

            if (this.options.useModerator && !this.services.moderationService)
            {
                console.warn("[Translator]", "Moderation service requested but not configured, no moderation applied")
            }

            if (this.options.useModerator && this.services.moderationService)
            {
                const inputForModeration = batch.join("\n\n")
                const moderationData = await checkModeration(inputForModeration, this.services.moderationService)
                if (moderationData.flagged)
                {
                    if (!this.changeBatchSize('decrease')) // Already at smallest batch size
                    {
                        yield* this.translateSingle(batch)
                    }
                    else
                    {
                        index -= this.currentBatchSize
                    }
                    continue
                }
            }
            this.buildContext()
            const output = await this.translatePrompt(batch)

            if (this.aborted)
            {
                console.error("[Translator]", "Aborted")
                return
            }

            let outputs = output.content

            if ((this.options.lineMatching && batch.length !== outputs.length) || (batch.length > 1 && output.refusal))
            {
                this.promptTokensWasted += output.promptTokens
                this.completionTokensWasted += output.completionTokens

                if (output.refusal) 
                {
                    console.error(`[Translator]`, "Refusal: ", output.refusal)
                }
                else
                {
                    console.error(`[Translator]`, "Lines count mismatch", batch.length, outputs.length)
                }

                console.error(`[Translator]`, "batch", batch)
                console.error(`[Translator]`, "transformed", outputs)

                if (this.changeBatchSize("decrease"))
                {
                    index -= this.currentBatchSize
                }
                else
                {
                    yield* this.translateSingle(batch)
                }
            }
            else
            {
                yield* this.yieldOutput(batch, outputs)
            }

            this.printUsage()

            if (this.batchSizeThreshold && reducedBatchSessions++ >= this.batchSizeThreshold)
            {
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
     */
    * yieldOutput(promptSources, promptTransforms)
    {
        for (let index = 0; index < promptSources.length; index++)
        {
            const promptSource = promptSources[index];
            const promptTransform = promptTransforms[index] ?? ""
            const workingIndex = this.workingProgress.length
            const originalSource = this.workingLines[workingIndex]
            let finalTransform = promptTransform
            let outTransform = promptTransform

            if (this.moderatorFlags.has(workingIndex))
            {
                finalTransform = `[Flagged][Moderator] ${originalSource} -> ${finalTransform} `
            }
            else if (this.options.prefixNumber)
            {
                const splits = this.postprocessNumberPrefixedLine(finalTransform)
                finalTransform = splits.text
                outTransform = splits.text
                const expectedLabel = workingIndex + 1
                if (expectedLabel !== splits.number)
                {
                    console.warn("[Translator]", "Label mismatch", expectedLabel, splits.number)
                    this.moderatorFlags.set(workingIndex, { remarks: "Label Mismatch", outIndex: splits.number })
                    finalTransform = `[Flagged][Model] ${originalSource} -> ${finalTransform}`
                }
            }
            else
            {
                finalTransform = this.postprocessLine(finalTransform)
            }
            this.workingProgress.push({ source: promptSource, transform: promptTransform })
            const output = { index: this.workingProgress.length, source: originalSource, transform: outTransform, finalTransform }
            yield output
        }
    }

    /**
     * @param {string} line
     * @param {number} index
     * @param {number} offset
     */
    preprocessLine(line, index, offset)
    {
        line = line.replaceAll("\n", " \\N ")
        if (this.options.prefixNumber)
        {
            line = `${offset + index + 1}. ${line}`
        }
        return line
    }

    /**
     * @param {string} line
     */
    postprocessNumberPrefixedLine(line)
    {
        const splits = splitStringByNumberLabel(line)
        splits.text = this.postprocessLine(splits.text)
        return splits
    }

    /**
     * @param {string} line
     */
    postprocessLine(line)
    {
        line = line.replaceAll(" \\N ", "\n")
        line = line.replaceAll("\\N", "\n")
        return line
    }

    /**
     * @param {"increase" | "decrease"} mode
     */
    changeBatchSize(mode)
    {
        const old = this.currentBatchSize
        if (mode === "decrease")
        {
            if (this.currentBatchSize === this.options.batchSizes[0])
            {
                return false
            }
            this.workingBatchSizes.unshift(this.workingBatchSizes.pop())
        }
        else if (mode === "increase")
        {
            if (this.currentBatchSize === this.options.batchSizes[this.options.batchSizes.length - 1])
            {
                return false
            }
            this.workingBatchSizes.push(this.workingBatchSizes.shift())
        }
        this.currentBatchSize = this.workingBatchSizes[this.workingBatchSizes.length - 1]
        if (this.currentBatchSize === this.options.batchSizes[this.options.batchSizes.length - 1])
        {
            this.batchSizeThreshold = undefined
        }
        else
        {
            this.batchSizeThreshold = Math.floor(Math.max(old, this.currentBatchSize) / Math.min(old, this.currentBatchSize))
        }
        console.error("[Translator]", "BatchSize", mode, old, "->", this.currentBatchSize, "SizeThreshold", this.batchSizeThreshold)
        return true
    }

    buildContext()
    {
        if (this.workingProgress.length === 0 || this.options.historyPromptLength === 0)
        {
            return
        }
        const sliced = this.workingProgress.slice(-this.options.historyPromptLength)
        const offset = this.workingProgress.length - this.options.historyPromptLength

        /**
         * @param {string} text
         * @param {number} index
         */
        const checkFlaggedMapper = (text, index) =>
        {
            const id = index + (offset < 0 ? 0 : offset)
            if (this.moderatorFlags.has(id))
            {
                // console.error("[Translator]", "Prompt Flagged", id, text)
                return this.preprocessLine("-", id, 0)
            }
            return text
        }

        this.promptContext = /** @type {import('openai').OpenAI.Chat.ChatCompletionMessage[]}*/([
            { role: "user", content: sliced.map((x, i) => checkFlaggedMapper(x.source, i)).join("\n\n") },
            { role: "assistant", content: sliced.map((x, i) => checkFlaggedMapper(x.transform, i)).join("\n\n") }
        ])
    }

    get usage()
    {
        if (!this.pricingModel)
        {
            return null
        }

        const usedTokens = this.promptTokensUsed + this.completionTokensUsed
        const wastedTokens = this.promptTokensWasted + this.completionTokensWasted
        const usedTokensPricing = roundWithPrecision(this.pricingModel.prompt * (this.promptTokensUsed / 1000) + this.pricingModel.completion * (this.completionTokensUsed / 1000), 3)
        const wastedTokensPricing = roundWithPrecision(this.pricingModel.prompt * (this.promptTokensWasted / 1000) + this.pricingModel.completion * (this.completionTokensWasted / 1000), 3)
        const rate = roundWithPrecision(usedTokens / (this.tokensProcessTimeMs / 1000 / 60), 2)
        const wastedPercent = (wastedTokens / usedTokens).toLocaleString(undefined, { style: 'percent', minimumFractionDigits: 0 })
        return {
            usedTokens,
            wastedTokens,
            usedTokensPricing,
            wastedTokensPricing,
            wastedPercent,
            rate,
        }
    }

    async printUsage()
    {
        const usage = this.usage
        if (!usage)
        {
            console.warn("[Translator]", `Cost computation not supported yet for ${this.options.createChatCompletionRequest.model}`)
            return
        }

        await sleep(10)

        const {
            usedTokens,
            wastedTokens,
            usedTokensPricing,
            wastedTokensPricing,
            wastedPercent,
            rate,
        } = usage

        console.error(
            `[Translator] Estimated Usage -`,
            "Tokens:", usedTokens, "$", usedTokensPricing,
            "Wasted:", wastedTokens, "$", wastedTokensPricing, wastedPercent,
            "Rate:", rate, "TPM", this.services.cooler?.rate, "RPM"
        )
    }

    abort()
    {
        console.error("[Translator]", "Aborting")
        this.streamController?.abort()
        this.aborted = true
    }
}
