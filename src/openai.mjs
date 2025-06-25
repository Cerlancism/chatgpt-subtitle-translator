import { OpenAI } from "openai";
import log from "loglevel"
import { retryWrapper, sleep } from './helpers.mjs';

/**
 * In USD per 1000 tokens
 */
export const ModelPricing = {
    "gpt-3.5-turbo": { prompt: 0.50 / 1000000 * 1000, completion: 1.50 / 1000000 * 1000 },
    "gpt-3.5-turbo-1106": { prompt: 0.001, completion: 0.002 },
    "gpt-4": { prompt: 0.03, completion: 0.06 },
    "gpt-4-32k": { prompt: 0.06, completion: 0.12 },
    "gpt-4-1106-preview": { prompt: 0.01, completion: 0.03 },
    "gpt-4o": { prompt: 5.00 / 1000000 * 1000, completion: 15.00 / 1000000 * 1000 },
    "gpt-4o-mini": { prompt: 0.150 / 1000000 * 1000, completion: 0.600 / 1000000 * 1000 },
}

export const ModelPricingAlias = {
    "gpt-3.5-turbo-0301": "gpt-3.5-turbo",
    "gpt-3.5-turbo-0613": "gpt-3.5-turbo",
    "gpt-3.5-turbo-16k": "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-16k-0613": "gpt-3.5-turbo-1106",
    "gpt-4-0613": "gpt-4",
    "gpt-4o-2024-05-13": "gpt-4o",
    "gpt-4o-mini-2024-07-18": "gpt-4o-mini"
}

/**
 * 
 * @param {string} model 
 * @returns {{prompt: number, completion: number}}
 */
export function getPricingModel(model)
{
    let modelPricing = ModelPricing[model]

    if (!modelPricing)
    {
        let aliasModel = ModelPricingAlias[model]
        if (aliasModel)
        {
            modelPricing = ModelPricing[aliasModel]
        }
    }
    return modelPricing
}

/**
 * @param {string} apiKey
 * @param {boolean} [dangerouslyAllowBrowser]
 * @param {string} [baseURL]
 * @param {import('undici').ProxyAgent} proxyAgent
 */
export function createOpenAIClient(apiKey, dangerouslyAllowBrowser = undefined, baseURL = undefined, proxyAgent = undefined)
{
    return new OpenAI({
        apiKey,
        baseURL,
        dangerouslyAllowBrowser: dangerouslyAllowBrowser,
        maxRetries: 3,
        fetchOptions: proxyAgent === undefined ? undefined : { dispatcher: proxyAgent},
    });
}

export class ChatStreamSyntaxError extends SyntaxError
{
    /**
     * @param {string} message
     * @param {ErrorOptions} cause
     */
    constructor(message, cause)
    {
        super(message, cause)
    }
}

/**
 * Retry the Openai API function until it succeeds or the maximum number of retries is reached
 * @template T
 * @param {() => Promise<T>} func The function to retry
 * @param {number} maxRetries The maximum number of retries to attempt
 * @param {string} description
 */
export async function openaiRetryWrapper(func, maxRetries, description)
{
    return await retryWrapper(func, maxRetries, async (retryContext) =>
    {
        const error = retryContext.error
        let delay = 1000 * retryContext.currentTry * retryContext.currentTry
        if (error instanceof OpenAI.APIError)
        {
            log.error(`[Error_${description}]`, new Date(), "Status", error.status, error.name, error.message, error.error)

            if (error.status === 429 || (error.status >= 500 && error.status <= 599))
            {
                delay = delay * retryContext.currentTry
            }
            else
            {
                throw `[Error_${description}] ${new Date()} ${error.message}`
            }
            log.error(`[Error_${description}]`, "Retries", retryContext.currentTry, "Delay", delay)
            await sleep(delay)
        }
        else if (error instanceof ChatStreamSyntaxError)
        {
            log.error(`[Error_${description}] ${error.message}`, "Retries", retryContext.currentTry, "Delay", delay)
            await sleep(delay)
        }
        else
        {
            throw `[Error_${description}] [openaiRetryWrapper] ${new Date()} unknown error ${error}`
        }
    }, async (retryContext) =>
    {
        log.error(`[Error_${description}] [openaiRetryWrapper] Max Retries Reached`, new Date(), retryContext)
        throw `[Error_${description}] [openaiRetryWrapper] Max Retries Reached, Error: ${retryContext.error?.message ?? retryContext.error}`
    })
}

/**
 * @param {import("openai/streaming").Stream<import("openai").OpenAI.Chat.Completions.ChatCompletionChunk>} response
 * @param {(d: string) => void} onData 
 * @param {(u: import('openai').OpenAI.Completions.CompletionUsage) => void} onEnd
 * @returns {Promise<string>}
 */
export async function completeChatStream(response, onData = (d) => { }, onEnd = (u) => { })
{
    let output = ''
    return await new Promise(async (resolve, reject) =>
    {
        try
        {
            /** @type {import('openai').OpenAI.Completions.CompletionUsage} */
            let usage;
            for await (const part of response)
            {
                const text = part.choices[0]?.delta?.content
                if (text)
                {
                    output += text
                    onData(text)
                }
                else if (part.usage)
                {
                    usage = part.usage
                }
            }
            onEnd(usage)
            resolve(output)

        } catch (error)
        {
            const chatStreamError = new ChatStreamSyntaxError(`Could not JSON parse stream message: ${error.message}`, error)
            reject(chatStreamError)
        }
    })
}
