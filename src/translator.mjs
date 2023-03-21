//@ts-check
import { splitStringByNumberLabel } from './subtitle.mjs';

import { coolerAPI, openai, openaiRetryWrapper } from './openai.mjs';
import { checkModeration, getModeratorDescription, getModeratorResults } from './moderator.mjs';
import { roundWithPrecision, sleep, wrapQuotes } from './helpers.mjs';

/**
 * @type {TranslatorOptions}
 * @typedef TranslatorOptions
 * @property {Pick<Partial<import('openai').CreateChatCompletionRequest>, "messages" | "model"> & Omit<import('openai').CreateChatCompletionRequest, "messages" | "model">} createChatCompletionRequest
 * Options to ChatGPT besides the messages, it is recommended to set `temperature: 0` for a (almost) deterministic translation
 * @property {import('openai').ChatCompletionRequestMessage[]} initialPrompts 
 * Initiate the prompt by sending warm-up messages prior to the first translation request
 * @property {boolean} useModerator `true` \
 * Verify with the free OpenAI Moderation tool prior to submitting the prompt to ChatGPT model
 * @property {boolean} prefixLineWithNumber `true` \
 * Label lines with numerical prefixes to improve the one-to-one correlation between line quantities for input and output
 * @property {number} historyPromptLength `10` \
 * Length of the prompt history to be retained and passed over to the next translation request in order to maintain some context.
 * @property {number[]} batchSizes `[10, 100]` \
 * The number of lines to include in each translation prompt, provided that they are estimated to within the token limit. 
 * In case of mismatched output line quantities, this number will be decreased step-by-step according to the values in the array, ultimately reaching one.
 * 
 * Larger batch sizes generally lead to more efficient token utilization and potentially better contextual translation. 
 * However, mismatched output line quantities or exceeding the token limit will cause token wastage, requiring resubmission of the batch with a smaller batch size.
 */
const DefaultOptions = {
    createChatCompletionRequest: {
        model: "gpt-3.5-turbo"
    },
    initialPrompts: [],
    useModerator: true,
    prefixLineWithNumber: true,
    historyPromptLength: 10,
    batchSizes: [10, 100]
}
/**
 * Translator using ChatGPT
 */
export class Translator
{
    /**
     * @param {{from?: string, to: string}} language
     * @param {Partial<TranslatorOptions>} [options]
     */
    constructor(language, options)
    {
        options.createChatCompletionRequest = { ...DefaultOptions.createChatCompletionRequest, ...options.createChatCompletionRequest }

        this.language = language
        this.options = /** @type {TranslatorOptions & {createChatCompletionRequest: {model: string}}} */ ({ ...DefaultOptions, ...options })

        this.openaiClient = openai
        this.systemInstruction = `Translate ${this.language.from ? this.language.from + " " : ""}to ${this.language.to}`
        this.promptContext = this.options.initialPrompts;

        this.cooler = coolerAPI

        /**
         * @type {{ source: string; transform: string; }[]}
         */
        this.workingProgress = []
        this.tokensUsed = 0
        this.tokensWasted = 0
        this.tokensProcessTimeMs = 0

        this.offset = 0
        this.end = undefined

        this.workingBatchSizes = [...this.options.batchSizes]
        this.currentBatchSize = this.workingBatchSizes[this.workingBatchSizes.length - 1]
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
                this.batchSizeThreshold = undefined
                return false
            }
            this.workingBatchSizes.unshift(this.workingBatchSizes.pop())
        }
        else if (mode === "increase")
        {
            if (this.currentBatchSize === this.options.batchSizes[this.options.batchSizes.length - 1])
            {
                this.batchSizeThreshold = undefined
                return false
            }
            this.workingBatchSizes.push(this.workingBatchSizes.shift())
        }
        this.currentBatchSize = this.workingBatchSizes[this.workingBatchSizes.length - 1]
        this.batchSizeThreshold = Math.floor(Math.max(old, this.currentBatchSize) / Math.min(old, this.currentBatchSize))
        console.error("[Translator]", "BatchSize", mode, old, "->", this.currentBatchSize, "SizeThreshold", this.batchSizeThreshold)
        return true
    }


    /**
     * @param {string} text
     */
    async translatePrompt(text)
    {
        /** @type {import('openai').ChatCompletionRequestMessage} */
        const userMessage = { role: "user", content: `${text}` }
        /** @type {import('openai').ChatCompletionRequestMessage[]} */
        const systemMessage = this.systemInstruction ? [{ role: "system", content: `${this.systemInstruction}` }] : []
        const messages = [...systemMessage, ...this.promptContext, userMessage]

        let startTime = 0, endTime = 0
        const response = await openaiRetryWrapper(async () =>
        {
            await this.cooler.cool()
            startTime = Date.now()
            const result = await openai.createChatCompletion({
                messages,
                ...this.options.createChatCompletionRequest
            })
            endTime = Date.now()
            return result
        }, 3, "TranslationPrompt")

        this.tokensUsed += getTokens(response)
        this.tokensProcessTimeMs += (endTime - startTime)

        return response
    }

    /**
     * @param {string[]} batch
     */
    async * translateSingle(batch)
    {
        console.error(`[Translator]`, "Single line mode")
        for (let x = 0; x < batch.length; x++)
        {
            const input = batch[x]
            if (this.options.useModerator)
            {
                const moderationData = await checkModeration(input)
                if (moderationData.flagged)
                {
                    const moderationResults = getModeratorResults(moderationData)
                    const moderationDescription = getModeratorDescription(moderationResults)
                    yield* this.yieldOutput([input], [`[ModeratorFlagged] ${moderationDescription}`])
                    continue
                }
            }
            this.buildContext()
            const output = await this.translatePrompt(input)
            const text = getPromptContent(output)
            const writeOut = text.split("\n").join(" ")
            yield* this.yieldOutput([batch[x]], [writeOut])
        }
    }

    /**
     * 
     * @param {string[]} lines 
     */
    async * translateLines(lines)
    {
        console.error("[Translator]", "System Instruction", this.systemInstruction)
        this.workingLines = lines
        const theEnd = this.end ?? lines.length

        for (let index = this.offset, reducedBatchSessions = 0; index < theEnd; index += this.currentBatchSize)
        {
            let batch = lines.slice(index, index + this.currentBatchSize).map(x => x.replaceAll("\n", " "))
            if (this.options.prefixLineWithNumber)
            {
                batch = batch.map((x, i) => `${index + i + 1}. ${x}`)
            }
            const input = batch.join("\n\n")
            if (this.options.useModerator)
            {
                const moderationData = await checkModeration(input)
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
            const output = await this.translatePrompt(input)
            const text = getPromptContent(output)
            let outputs = text.split("\n").filter(x => x.length > 0)

            if (batch.length !== outputs.length)
            {
                this.tokensWasted += getTokens(output)
                console.error(`[Translator]`, "Lines count mismatch", batch.length, outputs.length)

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
     * @param {string[]} promptTransformes
     */
    * yieldOutput(promptSources, promptTransformes)
    {
        for (let index = 0; index < promptSources.length; index++)
        {
            const promptSource = promptSources[index];
            const promptTransform = promptTransformes[index]
            const originalSource = this.workingLines[this.workingProgress.length]
            let outTransform = promptTransformes[index]

            if (this.options.prefixLineWithNumber)
            {
                const splits = splitStringByNumberLabel(outTransform)
                outTransform = splits.text
            }
            this.workingProgress.push({ source: promptSource, transform: promptTransform })
            const output = { index: this.workingProgress.length, source: originalSource, transform: outTransform }
            yield output
        }
    }

    buildContext()
    {
        if (this.workingProgress.length === 0)
        {
            return
        }
        const sliced = this.workingProgress.slice(-this.options.historyPromptLength)

        this.promptContext = /** @type {import('openai').ChatCompletionRequestMessage[]}*/([
            { role: "user", content: sliced.map(x => x.source).join("\n\n") },
            { role: "assistant", content: sliced.map(x => x.transform).join("\n\n") }
        ])
    }

    async printUsage()
    {
        await sleep(10)
        console.error(
            `[Translator]`,
            "Tokens:", this.tokensUsed, "$", roundWithPrecision(0.002 * (this.tokensUsed / 1000), 3),
            "Wasted:", this.tokensWasted, "$", roundWithPrecision(0.002 * (this.tokensWasted / 1000), 3), (this.tokensWasted / this.tokensUsed).toLocaleString(undefined, { style: 'percent', minimumFractionDigits: 0 }),
            "Rate:", roundWithPrecision(this.tokensUsed / (this.tokensProcessTimeMs / 1000 / 60), 2), "TPM", this.cooler.rate, "RPM"
        )
    }
}

/**
 * @param {import("axios").AxiosResponse<import("openai").CreateChatCompletionResponse, any>} response
 */
function getTokens(response)
{
    return response.data.usage?.total_tokens ?? 0
}

/**
 * @param {import("axios").AxiosResponse<import("openai").CreateChatCompletionResponse, any>} openaiRes
 */
function getPromptContent(openaiRes)
{
    return openaiRes.data.choices[0].message?.content ?? ""
}
