import { OpenAI } from "openai";
import log from "loglevel"
import { retryWrapper, sleep } from './helpers.mjs';


/**
 * @param {string} apiKey
 * @param {boolean} [dangerouslyAllowBrowser]
 * @param {string} [baseURL]
 * @param {import('undici').ProxyAgent} proxyAgent
 */
export function createOpenAIClient(apiKey, dangerouslyAllowBrowser = undefined, baseURL = undefined, proxyAgent = undefined) {
    return new OpenAI({
        apiKey,
        baseURL,
        dangerouslyAllowBrowser: dangerouslyAllowBrowser,
        maxRetries: 3,
        fetchOptions: proxyAgent === undefined ? undefined : { dispatcher: proxyAgent },
    });
}

export class ChatStreamSyntaxError extends SyntaxError {
    /**
     * @param {string} message
     * @param {ErrorOptions} cause
     */
    constructor(message, cause) {
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
export async function openaiRetryWrapper(func, maxRetries, description) {
    return await retryWrapper(func, maxRetries, async (retryContext) => {
        const error = retryContext.error
        let delay = 1000 * retryContext.currentTry * retryContext.currentTry
        if (error instanceof OpenAI.APIError) {
            log.error(`[Error_${description}]`, new Date(), "Status", error.status, error.name, error.message, error.error)

            if (error.status === 429 || (error.status >= 500 && error.status <= 599)) {
                delay = delay * retryContext.currentTry
            }
            else {
                throw `[Error_${description}] ${new Date()} ${error.message}`
            }
            log.error(`[Error_${description}]`, "Retries", retryContext.currentTry, "Delay", delay)
            await sleep(delay)
        }
        else if (error instanceof ChatStreamSyntaxError) {
            log.error(`[Error_${description}] ${error.message}`, "Retries", retryContext.currentTry, "Delay", delay)
            await sleep(delay)
        }
        else {
            throw `[Error_${description}] [openaiRetryWrapper] ${new Date()} unknown error ${error}`
        }
    }, async (retryContext) => {
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
export async function completeChatStream(response, onData = (d) => { }, onEnd = (u) => { }) {
    let output = ''
    return await new Promise(async (resolve, reject) => {
        try {
            /** @type {import('openai').OpenAI.Completions.CompletionUsage} */
            let usage;
            for await (const part of response) {
                const text = part.choices[0]?.delta?.content
                if (text) {
                    output += text
                    onData(text)
                }
                else if (part.usage) {
                    usage = part.usage
                }
            }
            onEnd(usage)
            resolve(output)

        } catch (error) {
            const chatStreamError = new ChatStreamSyntaxError(`Could not JSON parse stream message: ${error.message}`, error)
            reject(chatStreamError)
        }
    })
}
