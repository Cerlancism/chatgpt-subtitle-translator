//@ts-check
import fs from 'fs'
import { srtFileToNumberLabledLines } from './subtitle.js';

import { openai } from './openai.js';
import { checkModeration } from './moderator.js';
import { CooldownContext } from './cooldown.js';

/**
 * @type {import('./types.js').DefaultPretext}
 */
const DefaultPretextJpnChn = {
    preprompt: { role: "user", content: "1. こんにちは\n\n2. バイバイ" },
    preoutput: { role: "assistant", content: "1. 你好\n\n2. 拜拜" }
}

const cooler = new CooldownContext(10, 60000, "ChatGPTAPI")

/**
 * @param {string} text
 */
async function translatePrompt(text, pretext = DefaultPretextJpnChn, instruction = "Translate Japanese to Chinese zh-cn")
{
    try
    {
        await cooler.use()
        const result = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: `${instruction}` },
                pretext.preprompt,
                pretext.preoutput,
                { role: "user", content: `${text}` }
            ]
        })

        return result
    }
    catch (error)
    {
        console.error("error translatePrompt", error.message)
        process.exit(1)
    }
}

/**
 * @param {string[]} lines
 */
export async function translateLines(lines, offset = 0, end = undefined, batchSizes = { small: 10, large: 100 }, defaultPretext = undefined, instruction = undefined)
{
    /** @type {{source: string; transform: string;}[]} */
    const progress = []
    let tokenUsed = 0

    let BatchSizeLarge = batchSizes.large
    let BatchSizeSmall = batchSizes.small

    let batchSize = BatchSizeLarge
    let reducedBatchSessions = 0
    const theEnd = end ?? lines.length
    for (let index = offset; index < theEnd; index += batchSize)
    {
        const batch = lines.slice(index, index + batchSize)
        const input = batch.join("\n\n")

        const moderationData = await checkModeration(input)
        if (moderationData.flagged)
        {
            if (batchSize === BatchSizeLarge)
            {
                batchSize = BatchSizeSmall
                index -= batchSize
                console.error("Batch size", batchSize)
            }
            else if (batchSize === BatchSizeSmall)
            {
                const tokens = await singleTranslate(batch, progress, defaultPretext)
                tokenUsed += tokens
            }
            continue
        }
        else
        {
            const pretext = getPretext(progress, defaultPretext)
            const output = await translatePrompt(input, pretext, instruction)

            tokenUsed += getTokens(output)

            const text = getTranslationFromPrompt(output)
            let lines = text.split("\n").filter(x => x.length > 0)

            if (batch.length !== lines.length)
            {
                console.error("Lines count mismatch", batch.length, lines.length)

                if (batchSize === BatchSizeLarge)
                {
                    batchSize = BatchSizeSmall
                    index -= batchSize
                }
                else if (batchSize === BatchSizeSmall)
                {
                    const tokens = await singleTranslate(batch, progress, defaultPretext)
                    tokenUsed += tokens
                }
                console.error("Batch size", batchSize)
            }
            else
            {
                writeOutput(batch, lines, progress)
            }
        }

        console.error("Tokens:", tokenUsed, "Cost:", 0.002 * (tokenUsed / 1000))

        if (batchSize === BatchSizeSmall && reducedBatchSessions++ >= BatchSizeLarge / BatchSizeSmall)
        {
            reducedBatchSessions = 0
            batchSize = BatchSizeLarge
            index -= (batchSize - BatchSizeSmall)
            console.error("Revert batch size", batchSize)
        }
    }
}


/**
 * @param {fs.PathOrFileDescriptor} file
 */
export async function translateSrtChinese(file, offset = 0, end = undefined)
{
    const srtArray = srtFileToNumberLabledLines(file)

    await translateLines(srtArray, offset, end)
}

/**
 * @param {string | any[]} batch
 * @param {{ source: string; transform: string; }[]} progress
 * @param {import('./types.js').DefaultPretext} [defaultPretext]
 * @returns {Promise<number>}
 */
async function singleTranslate(batch, progress, defaultPretext)
{
    let tokenUsed = 0
    console.error("Single line mode")
    for (let x = 0; x < batch.length; x++)
    {
        const input = batch[x]
        const moderationData = await checkModeration(input)
        if (moderationData.flagged)
        {
            writeOutput([input], ["(Censored)"], progress)
            continue
        }
        const pretext = getPretext(progress, undefined, defaultPretext)
        const output = await translatePrompt(input, pretext)
        tokenUsed += getTokens(output)

        const text = getTranslationFromPrompt(output)
        const writeOut = text.split("\n").join(" ")

        writeOutput([batch[x]], [writeOut], progress)
    }

    return tokenUsed
}

/**
 * @param {import("axios").AxiosResponse<import("openai").CreateChatCompletionResponse, any>} openaiRes
 */
function getTranslationFromPrompt(openaiRes)
{
    return openaiRes.data.choices[0].message?.content ?? ""
}

/**
 * @param {{source: string;transform: string;}[]} progress
 * @param {number} pretextLength
 * @returns {import('./types.js').DefaultPretext}
 */
function getPretext(progress, pretextLength = 10, defaultPretext = DefaultPretextJpnChn)
{
    if (progress.length === 0)
    {
        return defaultPretext
    }

    const sliced = progress.slice(-pretextLength)

    return {
        preprompt: { role: "user", content: sliced.map(x => x.source).join("\n\n") },
        preoutput: { role: "assistant", content: sliced.map(x => x.transform).join("\n\n") }
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
 * @param {string[]} sources
 * @param {string[]} transformed
 * @param {{ source: string; transform: string; }[]} progress
 */
function writeOutput(sources, transformed, progress)
{
    for (let index = 0; index < sources.length; index++)
    {
        const source = sources[index];
        const transform = transformed[index]
        progress.push({ source, transform })
        console.log(transform)
    }
}

