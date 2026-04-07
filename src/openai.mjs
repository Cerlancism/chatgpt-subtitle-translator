import { OpenAI } from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
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

export class ChatStreamRepetitionError extends ChatStreamSyntaxError {
    /** @param {string} pattern */
    constructor(pattern) {
        super(`Repetition detected in stream: "${pattern}"`, { cause: "repetition" })
        this.pattern = pattern
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
 * Calls the OpenAI structured completion API (streaming or non-streaming) and returns the final completion.
 *
 * @param {import('./translator.mjs').TranslationServiceContext} services
 * @param {import('openai').OpenAI.ChatCompletionCreateParams} params
 * @param {{structure: import('zod').ZodType, name: string}} zFormat
 * @param {{jsonStream?: boolean, onJsonStream?: (runner: any) => void, onController?: (controller: AbortController) => void, shouldAbort?: (buffer: string) => string | null}} [opts]
 * @returns {Promise<import('openai/resources/chat/completions/completions.js').ParsedChatCompletion<any>>}
 */
export async function streamParse(services, params, zFormat, { jsonStream = false, onJsonStream, onController, shouldAbort } = {}) {
    const zodResponseFormatOutput = zodResponseFormat(zFormat.structure, zFormat.name)
    if (params.stream) {
        let repetitionPattern = null
        const runner = services.openai.chat.completions.stream({
            ...params,
            response_format: zodResponseFormatOutput,
            stream: true,
            stream_options: { include_usage: true },
        })
        onController?.(runner.controller)
        if (jsonStream && onJsonStream) {
            onJsonStream(runner)
        } else {
            let contentBuffer = ''
            runner.on("content.delta", (e) => {
                services.onStreamChunk?.(e.delta)
                if (shouldAbort) {
                    contentBuffer += e.delta
                    const pattern = shouldAbort(contentBuffer)
                    if (pattern) {
                        repetitionPattern = pattern
                        runner.controller.abort()
                    }
                }
            })
        }
        try {
            await runner.done()
        } catch (error) {
            if (repetitionPattern) {
                throw new ChatStreamRepetitionError(repetitionPattern)
            }
            throw error
        }
        services.onStreamEnd?.()
        return runner.finalChatCompletion()
    } else {
        return services.openai.chat.completions.parse({
            ...params,
            response_format: zodResponseFormatOutput,
            stream: false,
        })
    }
}

/**
 * @param {import("openai/streaming").Stream<import("openai").OpenAI.Chat.Completions.ChatCompletionChunk>} response
 * @param {(d: string) => void} onData
 * @param {(u: import('openai').OpenAI.Completions.CompletionUsage) => void} onEnd
 * @param {(buffer: string) => string | boolean | null} [shouldAbort] - return a truthy value to abort the stream; if a string is returned it is used as the repetition pattern
 * @returns {Promise<string>}
 */
export async function completeChatStream(response, onData = (d) => { }, onEnd = (u) => { }, shouldAbort = undefined) {
    let output = ''
    return await new Promise(async (resolve, reject) => {
        try {
            /** @type {import('openai').OpenAI.Completions.CompletionUsage} */
            let usage;
            let repetitionPattern = null
            for await (const part of response) {
                const text = part.choices[0]?.delta?.content
                if (text) {
                    output += text
                    onData(text)
                    if (shouldAbort) {
                        const detected = shouldAbort(output)
                        if (detected) {
                            repetitionPattern = typeof detected === 'string' ? detected : text
                            try { response.controller.abort() } catch (_) { }
                            break
                        }
                    }
                }
                else if (part.usage) {
                    usage = part.usage
                }
            }
            if (repetitionPattern !== null) {
                reject(new ChatStreamRepetitionError(repetitionPattern))
                return
            }
            onEnd(usage)
            resolve(output)

        } catch (error) {
            const chatStreamError = new ChatStreamSyntaxError(`Could not JSON parse stream message: ${error.message}`, error)
            reject(chatStreamError)
        }
    })
}
