#!/usr/bin/env node
//@ts-check
import { program } from "commander"
import { Translator } from "../src/translator.mjs"
import fs from 'node:fs'
import { parser } from "../src/subtitle.mjs";
import { wrapQuotes } from "../src/helpers.mjs";

program.description("Translation tool based on ChatGPT API")
    .option("-f, --from <language>", "Source language")
    .option("-t, --to <language>", "Target language", "English")
    .option("-m, --model <model>", "https://platform.openai.com/docs/api-reference/chat/create#chat/create-model")

    .option("-f, --file <file>", "Text file name to use as input, .srt or plain text")
    .option("--system-instruction <instruction>", "Override the prompt system instruction template (Translate {from} to {to}) with this plain text")
    .option("--plain-text <text>", "Only translate this input plain text")

    .option("--initial-prompts <prompts>", "Initial prompts for the translation in JSON", JSON.parse)
    .option("--no-use-moderator", "Don't use the OpenAI Moderation tool")
    .option("--no-prefix-line-with-number", "Don't prefix lines with numerical indices")
    .option("--history-prompt-length <length>", "Length of prompt history to retain", parseInt)
    .option("--batch-sizes <sizes>", "Batch sizes for translation prompts in JSON Array, eg: \"[10, 100]\"", JSON.parse)
    .option("--temperature <temperature>", "Sampling temperature to use, should set a low value below 0.3 to be more deterministic https://platform.openai.com/docs/api-reference/chat/create#chat/create-temperature", parseFloat)
    // .option("--n <n>", "Number of chat completion choices to generate for each input message", parseInt)
    // .option("--stream", "Enable stream mode for partial message deltas")
    // .option("--stop <stop>", "Up to 4 sequences where the API will stop generating further tokens")
    // .option("--max-tokens <max_tokens>", "The maximum number of tokens to generate in the chat completion", parseInt)
    .option("--top_p <top_p>", "Nucleus sampling parameter, top_p probability mass https://platform.openai.com/docs/api-reference/chat/create#chat/create-top_p", parseFloat)
    .option("--presence_penalty <presence_penalty>", "Penalty for new tokens based on their presence in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-presence_penalty", parseFloat)
    .option("--frequency_penalty <frequency_penalty>", "Penalty for new tokens based on their frequency in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-frequency_penalty", parseFloat)
    .option("--logit_bias <logit_bias>", "Modify the likelihood of specified tokens appearing in the completion https://platform.openai.com/docs/api-reference/chat/create#chat/create-logit_bias", JSON.parse)
    .option("--user <user>", "A unique identifier representing your end-user")
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
        ...(opts.user && { user: opts.user }),
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

        const progressFile = `${opts.file}.progress.csv`
        const outputFile = `${opts.file}.out_${opts.to}.srt`

        if (checkProgress(progressFile))
        {
            // TODO: check progress/resume etc
        }

        for await (const output of translator.translateLines(sourceLines))
        {
            const csv = `${output.index}, ${wrapQuotes(output.transform)}\n`
            const srtEntry = srtArrayWorking[output.index - 1]
            srtEntry.text = output.transform
            const outSrt = parser.toSrt([srtEntry])
            console.log(output.index, wrapQuotes(output.source), "->", wrapQuotes(output.transform))
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
    const response = await translator.translatePrompt(text)
    translator.printUsage()
    const output = response.data.choices[0].message.content
    console.log(output)
}

/**
 * @param {string} progressFile
 */
async function checkProgress(progressFile)
{
    return false
}
