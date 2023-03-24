//@ts-check
import * as dotenv from 'dotenv'
dotenv.config()

import { axiosStatic } from './axios.mjs';
import { Configuration, OpenAIApi } from "openai";
import { CooldownContext } from './cooldown.mjs';
import { retryWrapper, sleep } from './helpers.mjs';
import gp3Encoder from "gpt-3-encoder";

const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
});

export const openai = new OpenAIApi(configuration);

export const coolerAPI = new CooldownContext(Number(process.env.OPENAI_API_RPM ?? 60), 60000, "ChatGPTAPI")
export const coolerModerator = new CooldownContext(Number(process.env.OPENAI_API_RPM ?? process.env.OPENAI_API_MODERATOR_RPM ?? 60), 60000, "OpenAIModerator")

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
        if (axiosStatic.isAxiosError(error))
        {
            console.error(`[Error_${description}]`, new Date(), "Status", error.response?.status, error.name, error.message, error.response?.data?.error)

            let delay = 1000 * retryContext.currentTry * retryContext.currentTry
            if (error.response?.status === 429 || (error.response?.status >= 500 && error.response?.status <= 599))
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
        else
        {
            throw `[Error_${description}] ${new Date()} unknown error ${error}`
        }
    }, async (retryContext) =>
    {
        console.error(`[Error_${description}]`, new Date(), retryContext)
        throw `[Error_${description}] ${retryContext}`
    })
}

/**
 * @param {import("axios").AxiosResponse} response
 * @return {Promise<import("axios").AxiosResponse<import("openai").CreateChatCompletionResponse, any>>}
 */
export async function completeChatStream(response, onData = (d) => { }, onEnd = () => { })
{
    let output = ''
    return new Promise((resolve, reject) =>
    {
        response.data.on("data", (/** @type {Buffer} */ data) =>
        {
            const lines = data.toString().split('\n').filter(line => line.trim() !== '');
            for (const line of lines)
            {
                const message = line.replace(/^data: /, '');
                if (message === '[DONE]')
                {
                    response.data = {
                        choices: [
                            { message: { role: "assistant", content: output } }
                        ]
                    }
                    onEnd()
                    resolve(response)
                    return; // Stream finished
                }
                try
                {
                    const parsed = JSON.parse(message);
                    const text = parsed.choices[0]?.delta?.content ?? ""
                    output += text
                    if (text)
                    {
                        onData(text)
                    }

                } catch (error)
                {
                    error.message = `Could not JSON parse stream message: ${error.message}`
                    reject(error)
                }
            }
        })

        response.data.on("error", (e) =>
        {
            reject(e)
        })
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
