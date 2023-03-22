//@ts-check
import * as dotenv from 'dotenv'
dotenv.config()

import { Configuration, OpenAIApi } from "openai";
import { axiosStatic } from './axios.mjs';
import { CooldownContext } from './cooldown.mjs';
import { retryWrapper, sleep } from './helpers.mjs';

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
            console.error(`[Error_${description}]`, new Date(), "Status", error.response?.status, error.name, error.message, JSON.stringify(error.response?.data))

            let delay = 1000 * retryContext.currentTry * retryContext.currentTry
            if (error.response?.status === 429 || (error.response?.status >= 500 && error.response?.status <= 599))
            {
                delay = delay * retryContext.currentTry
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