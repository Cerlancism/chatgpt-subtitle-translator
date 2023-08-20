//@ts-check
import * as dotenv from 'dotenv'

dotenv.config()

import { OpenAI } from "openai";
import { CooldownContext } from './cooldown.mjs';
import { retryWrapper, sleep } from './helpers.mjs';
import gp3Encoder from "gpt-3-encoder";

export const PrmoptTokenCostPer1k = {
    "gpt-3.5-turbo": 0.002,
    'gpt-4': 0.03,
    'gpt-4-32k': 0.06
}

// export const CompletionTokenCostPer1k = {
//     "gpt-3.5-turbo": 0.002,
//     'gpt-4': 0.06,
//     'gpt-4-32k': 0.12
// }

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 3
});

export const coolerAPI = new CooldownContext(Number(process.env.OPENAI_API_RPM ?? 60), 60000, "ChatGPTAPI")
export const coolerModerator = new CooldownContext(Number(process.env.OPENAI_API_RPM ?? process.env.OPENAI_API_MODERATOR_RPM ?? 60), 60000, "OpenAIModerator")

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
            console.error(`[Error_${description}]`, new Date(), "Status", error.status, error.name, error.message, error.error)

            if (error.status === 429 || (error.status >= 500 && error.status <= 599))
            {
                delay = delay * retryContext.currentTry
            }
            else
            {
                process.exit(1)
            }
            console.error(`[Error_${description}]`, "Retries", retryContext.currentTry, "Delay", delay)
            await sleep(delay)
        }
        else if (error instanceof ChatStreamSyntaxError)
        {
            console.error(`[Error_${description}] ${error.message}`, "Retries", retryContext.currentTry, "Delay", delay)
            await sleep(delay)
        }
        else
        {
            throw `[Error_${description}] [openaiRetryWrapper] ${new Date()} unknown error ${error}`
        }
    }, async (retryContext) =>
    {
        console.error(`[Error_${description}] [openaiRetryWrapper] Max Retries Reached`, new Date(), retryContext)
        throw `[Error_${description}] [openaiRetryWrapper] ${retryContext}`
    })
}

/**
 * @param {import("openai/streaming").Stream<import("openai").OpenAI.Chat.Completions.ChatCompletionChunk>} response
 * @returns {Promise<string>}
 */
export async function completeChatStream(response, onData = (d) => { }, onEnd = () => { })
{
    let output = ''
    return await new Promise(async (resolve, reject) =>
    {
        try
        {
            for await (const part of response)
            {
                const text = part.choices[0].delta.content
                if (text)
                {
                    output += text
                    onData(text)
                }
            }
            onEnd()
            resolve(output)

        } catch (error)
        {
            const chatStreamError = new ChatStreamSyntaxError(`Could not JSON parse stream message: ${error.message}`, error)
            reject(chatStreamError)
        }
    })
}

/**
 * Seems to overcount a little bit
 * @param {Object[]} messages
 */
export function numTokensFromMessages(messages, model = 'gpt-3.5-turbo-0301')
{
    switch (model)
    {
        case 'gpt-3.5-turbo':
            // console.warn('Warning: gpt-3.5-turbo may change over time. Returning num tokens assuming gpt-3.5-turbo-0301.');
            return numTokensFromMessages(messages, 'gpt-3.5-turbo-0301');
        case 'gpt-4':
            // console.warn('Warning: gpt-4 may change over time. Returning num tokens assuming gpt-4-0314.');
            return numTokensFromMessages(messages, 'gpt-4-0314');
        case 'gpt-3.5-turbo-0301':
            var tokensPerMessage = 4; // every message follows <im_start>{role/name}\n{content}<im_end>\n
            var tokensPerName = -1; // if there's a name, the role is omitted
            break;
        case 'gpt-4-0314':
            var tokensPerMessage = 3;
            var tokensPerName = 1;
            break;
        default:
            throw new Error(`numTokensFromMessages() is not implemented for model ${model}. See https://github.com/openai/openai-python/blob/main/chatml.md for information on how messages are converted to tokens.`);
    }

    let numTokens = 0;
    for (const message of messages)
    {
        numTokens += tokensPerMessage;
        for (const [key, value] of Object.entries(message))
        {
            numTokens += gp3Encoder.encode(value).length;
            if (key === 'name')
            {
                numTokens += tokensPerName;
            }
        }
    }

    numTokens += 2; // every reply is primed with <im_start>assistant
    return numTokens;
}
