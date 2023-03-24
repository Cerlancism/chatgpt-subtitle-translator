#!/usr/bin/env node
//@ts-check
import fs from 'node:fs'
import readline from 'readline'
import { program } from "commander"
import { DefaultOptions, Translator } from "../src/translator.mjs"
import { parser } from "../src/subtitle.mjs";
import { wrapQuotes } from "../src/helpers.mjs";

program.description("Translation tool based on ChatGPT API")
    .option("--from <language>", "Source language")
    .option("--to <language>", "Target language", "English")
    .option("-m, --model <model>", "https://platform.openai.com/docs/api-reference/chat/create#chat/create-model", DefaultOptions.createChatCompletionRequest.model)

    .option("-f, --file <file>", "Text file name to use as input, .srt or plain text")
    .option("-s, --system-instruction <instruction>", "Override the prompt system instruction template (Translate {from} to {to}) with this plain text")
    .option("--plain-text <text>", "Only translate this input plain text")

    .option("--initial-prompts <prompts>", "Initial prompts for the translation in JSON Array", JSON.parse, JSON.stringify(DefaultOptions.initialPrompts))
    .option("--no-use-moderator", "Don't use the OpenAI Moderation tool")
    .option("--no-prefix-line-with-number", "Don't prefix lines with numerical indices")
    .option("--history-prompt-length <length>", "Length of prompt history to retain", parseInt, DefaultOptions.historyPromptLength)
    .option("--batch-sizes <sizes>", "Batch sizes for translation prompts in JSON Array", JSON.parse, JSON.stringify(DefaultOptions.batchSizes))
    .option("-t, --temperature <temperature>", "Sampling temperature to use, should set a low value below 0.3 to be more deterministic https://platform.openai.com/docs/api-reference/chat/create#chat/create-temperature", parseFloat)
    // .option("--n <n>", "Number of chat completion choices to generate for each input message", parseInt)
    // .option("--stream", "Enable stream mode for partial message deltas")
    // .option("--stop <stop>", "Up to 4 sequences where the API will stop generating further tokens")
    // .option("--max-tokens <max_tokens>", "The maximum number of tokens to generate in the chat completion", parseInt)
    .option("--top_p <top_p>", "Nucleus sampling parameter, top_p probability mass https://platform.openai.com/docs/api-reference/chat/create#chat/create-top_p", parseFloat)
    .option("--presence_penalty <presence_penalty>", "Penalty for new tokens based on their presence in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-presence_penalty", parseFloat)
    .option("--frequency_penalty <frequency_penalty>", "Penalty for new tokens based on their frequency in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-frequency_penalty", parseFloat)
    .option("--logit_bias <logit_bias>", "Modify the likelihood of specified tokens appearing in the completion https://platform.openai.com/docs/api-reference/chat/create#chat/create-logit_bias", JSON.parse)
    // .option("--user <user>", "A unique identifier representing your end-user")
    .parse(process.argv);

const opts = (program.opts())

/**
 * @type {Partial<import("../src/translator.mjs").TranslatorOptions>}
 */
const options = {
    createChatCompletionRequest: {
        ...(opts.model && { model: opts.model }),
        ...(opts.temperature && { temperature: opts.temperature }),
        ...(opts.top_p && { top_p: opts.top_p }),
        // ...(opts.n && { n: opts.n }),
        // ...(opts.stream && { stream: opts.stream }),
        // ...(opts.stop && { stop: opts.stop }),
        // ...(opts.max_tokens && { max_tokens: opts.max_tokens }),
        ...(opts.presence_penalty && { presence_penalty: opts.presence_penalty }),
        ...(opts.frequency_penalty && { frequency_penalty: opts.frequency_penalty }),
        ...(opts.logit_bias && { logit_bias: opts.logit_bias }),
        // ...(opts.user && { user: opts.user }),
    },
    ...(opts.initialPrompts && { initialPrompts: opts.initialPrompts }),
    ...(opts.useModerator !== undefined && { useModerator: opts.useModerator }),
    ...(opts.prefixLineWithNumber !== undefined && { prefixLineWithNumber: opts.prefixLineWithNumber }),
    ...(opts.historyPromptLength && { historyPromptLength: opts.historyPromptLength }),
    ...(opts.batchSizes && { batchSizes: opts.batchSizes }),
};

const translator = new Translator({ from: opts.from, to: opts.to }, options);

if (opts.systemInstruction)
{
    translator.systemInstruction = opts.systemInstruction
}

if (opts.plainText)
{
    await translatePlainText(opts.plainText)
}
else if (opts.file)
{
    if (opts.file.endsWith(".srt"))
    {
        console.error("[CLI]", "Assume SRT file", opts.file)
        const text = fs.readFileSync(opts.file, 'utf-8')
        const srtArraySource = parser.fromSrt(text)
        const srtArrayWorking = parser.fromSrt(text)

        const sourceLines = srtArraySource.map(x => x.text)
        const fileTag = `${opts.systemInstruction ? "Custom" : opts.to}`

        const progressFile = `${opts.file}.progress_${fileTag}.csv`
        const outputFile = `${opts.file}.out_${fileTag}.srt`

        if (await checkFileExists(progressFile))
        {
            const progress = await getProgress(progressFile)

            if (progress.length === sourceLines.length)
            {
                console.error("[CLI]", "Progress already completed")
                process.exit(1)
            }
            console.error("[CLI]", "Resuming from", progress.length)
            const sourceProgress = sourceLines.slice(0, progress.length).map((x, i) => translator.preprocessLine(x, i, 0))
            for (let index = 0; index < progress.length; index++)
            {
                let transform = progress[index]
                if (transform.startsWith("[Flagged]"))
                {
                    translator.moderatorFlags.set(index, transform)
                }
                else
                {
                    transform = translator.preprocessLine(transform, index, 0)
                }
                translator.workingProgress.push({ source: sourceProgress[index], transform })
            }
            translator.offset = progress.length
        }

        for await (const output of translator.translateLines(sourceLines))
        {
            const csv = `${output.index}, ${wrapQuotes(output.finalTransform)}\n`
            const srtEntry = srtArrayWorking[output.index - 1]
            srtEntry.text = output.finalTransform
            const outSrt = parser.toSrt([srtEntry])
            console.log(output.index, wrapQuotes(output.source), "->", wrapQuotes(output.finalTransform))
            await Promise.all([
                fs.promises.appendFile(progressFile, csv),
                fs.promises.appendFile(outputFile, outSrt)]
            )
        }
    }
    else
    {
        console.error("[CLI]", "Assume plain text file", opts.file)
        const text = fs.readFileSync(opts.file, 'utf-8')
        await translatePlainText(text)
    }
}

/**
 * @param {string} text
 */
async function translatePlainText(text)
{
    const lines = text.split(/\r?\n/) //TODO: remove last empty line

    for await (const output of translator.translateLines(lines))
    {
        console.log(output.transform)
    }

    // translator.printUsage()
    // const output = response.data.choices[0].message.content
    // console.log(output)
}

/**
 * @param {string} progressFile
 */
async function getProgress(progressFile)
{
    const content = await fs.promises.readFile(progressFile, "utf-8")
    const lines = content.split(/\r?\n/)
    const progress = []

    for (let index = 0; index < lines.length; index++)
    {
        const line = lines[index];
        if (line.trim() === '')
        {
            continue
        }
        const splits = line.split(",")
        const id = Number(splits[0])
        const text = splits[1].trim()
        const expectedId = index + 1
        if (id === index + 1)
        {
            progress.push(text.substring(1, text.length - 1))
        }
        else
        {
            throw `Progress csv file not in order. Expected index ${expectedId}, got ${id}, text: ${text}`
        }
    }
    return progress
}

/**
 * @param {fs.PathLike} filePath
 */
async function checkFileExists(filePath)
{
    try
    {
        await fs.promises.access(filePath);
        return true; // file exists
    } catch (error)
    {
        return false // file does not exist
    }
}