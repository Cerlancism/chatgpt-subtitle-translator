#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path';
import url from 'url'

import { Command } from "commander"
import { ProxyAgent } from 'proxy-agent';

import { Translator, DefaultOptions } from "../src/translator.mjs"
import { createOpenAIClient } from '../src/openai.mjs'
import { CooldownContext } from '../src/cooldown.mjs';
import { wrapQuotes } from "../src/helpers.mjs";
import { parser } from "../src/subtitle.mjs";

import 'dotenv/config'
const openai = createOpenAIClient(process.env.OPENAI_API_KEY, undefined, process.env.OPENAI_BASE_URL)
const coolerChatGPTAPI = new CooldownContext(Number(process.env.OPENAI_API_RPM ?? 60), 60000, "ChatGPTAPI")
const coolerOpenAIModerator = new CooldownContext(Number(process.env.OPENAI_API_RPM ?? process.env.OPENAI_API_MODERATOR_RPM ?? 60), 60000, "OpenAIModerator")

/**
 * @param {readonly string[]} args
 */
export function createInstance(args)
{
    const httpProxyConfig = process.env.http_proxy ?? process.env.HTTP_PROXY
    const httpsProxyConfig = process.env.https_proxy ?? process.env.HTTPS_PROXY

    if (httpProxyConfig || httpsProxyConfig)
    {
        console.error("[CLI HTTP/HTTPS PROXY]", "Using HTTP/HTTPS Proxy from ENV Detected", { httpProxyConfig, httpsProxyConfig })
        openai.httpAgent = new ProxyAgent()
    }

    const program = new Command()
        .description("Translation tool based on ChatGPT API")
        .option("--from <language>", "Source language")
        .option("--to <language>", "Target language", "English")
        .option("-m, --model <model>", "https://platform.openai.com/docs/api-reference/chat/create#chat/create-model", DefaultOptions.createChatCompletionRequest.model)

        .option("-i, --input <file>", "Text file name to use as input, .srt or plain text")
        .option("-o, --output <file>", "Output file name, defaults to be based on input file name")
        .option("-f, --file <file>", "Deprecated: alias for -i, --input")
        .option("-s, --system-instruction <instruction>", "Override the prompt system instruction template `Translate ${from} to ${to}` with this plain text")
        .option("-p, --plain-text <text>", "Only translate this input plain text")

        .option("--initial-prompts <prompts>", "Initiation prompt messages before the translation request messages in JSON Array", JSON.parse, DefaultOptions.initialPrompts)
        .option("--no-use-moderator", "Don't use the OpenAI Moderation tool")
        .option("--no-prefix-number", "Don't prefix lines with numerical indices")
        .option("--no-line-matching", "Don't enforce one to one line quantity input output matching")
        .option("-l, --history-prompt-length <length>", "Length of prompt history to retain", parseInt, DefaultOptions.historyPromptLength)
        .option("-b, --batch-sizes <sizes>", "Batch sizes for translation prompts in JSON Array", JSON.parse, DefaultOptions.batchSizes)
        .option("-t, --temperature <temperature>", "Sampling temperature to use, should set a low value below 0.3 to be more deterministic https://platform.openai.com/docs/api-reference/chat/create#chat/create-temperature", parseFloat)
        .option("--stream", "Enable stream mode for partial message deltas")
        // .option("--n <n>", "Number of chat completion choices to generate for each input message", parseInt)
        // .option("--stop <stop>", "Up to 4 sequences where the API will stop generating further tokens")
        // .option("--max-tokens <max_tokens>", "The maximum number of tokens to generate in the chat completion", parseInt)
        .option("--top_p <top_p>", "Nucleus sampling parameter, top_p probability mass https://platform.openai.com/docs/api-reference/chat/create#chat/create-top_p", parseFloat)
        .option("--presence_penalty <presence_penalty>", "Penalty for new tokens based on their presence in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-presence_penalty", parseFloat)
        .option("--frequency_penalty <frequency_penalty>", "Penalty for new tokens based on their frequency in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-frequency_penalty", parseFloat)
        .option("--logit_bias <logit_bias>", "Modify the likelihood of specified tokens appearing in the completion https://platform.openai.com/docs/api-reference/chat/create#chat/create-logit_bias", JSON.parse)
        // .option("--user <user>", "A unique identifier representing your end-user")
        .parse(args)

    const opts = program.opts()
    /**
     * @type {Partial<import("../src/translator.mjs").TranslatorOptions>}
     */
    const options = {
        createChatCompletionRequest: {
            ...(opts.model && { model: opts.model }),
            ...(opts.temperature !== undefined && { temperature: opts.temperature }),
            ...(opts.top_p !== undefined && { top_p: opts.top_p }),
            // ...(opts.n && { n: opts.n }),
            ...(opts.stream !== undefined && { stream: opts.stream }),
            // ...(opts.stop && { stop: opts.stop }),
            // ...(opts.max_tokens !== undefined && { max_tokens: opts.max_tokens }),
            ...(opts.presence_penalty !== undefined && { presence_penalty: opts.presence_penalty }),
            ...(opts.frequency_penalty !== undefined && { frequency_penalty: opts.frequency_penalty }),
            ...(opts.logit_bias && { logit_bias: opts.logit_bias }),
            // ...(opts.user && { user: opts.user }),
        },
        ...(opts.initialPrompts && { initialPrompts: opts.initialPrompts }),
        ...(opts.useModerator !== undefined && { useModerator: opts.useModerator }),
        ...(opts.prefixNumber !== undefined && { prefixNumber: opts.prefixNumber }),
        ...(opts.lineMatching !== undefined && { lineMatching: opts.lineMatching }),
        ...(opts.historyPromptLength !== undefined && { historyPromptLength: opts.historyPromptLength }),
        ...(opts.batchSizes && { batchSizes: opts.batchSizes }),
    };

    if (opts.file && !opts.input)
    {
        console.warn("[CLI]", "[WARNING]", "-f, --file is deprecated, use -i, --input")
        opts.input = opts.file
    }

    return { opts, options }
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href)
{
    const { opts, options } = createInstance(process.argv)

    /**
     * @type {import('../src/translator.mjs').TranslationServiceContext}
     */
    const services = {
        openai,
        cooler: coolerChatGPTAPI,
        onStreamChunk: (data) => process.stdout.write(data),
        onStreamEnd: () => process.stdout.write("\n"),
        moderationService: {
            openai,
            cooler: coolerOpenAIModerator
        }
    }

    const translator = new Translator({ from: opts.from, to: opts.to }, services, options);

    if (opts.systemInstruction)
    {
        translator.systemInstruction = opts.systemInstruction
    }

    if (opts.plainText)
    {
        await translatePlainText(translator, opts.plainText)
    }
    else if (opts.input)
    {
        if (opts.input.endsWith(".srt"))
        {
            console.error("[CLI]", "Assume SRT file", opts.input)
            const text = fs.readFileSync(opts.input, 'utf-8')
            const srtArraySource = parser.fromSrt(text)
            const srtArrayWorking = parser.fromSrt(text)

            const sourceLines = srtArraySource.map(x => x.text)
            const fileTag = `${opts.systemInstruction ? "Custom" : opts.to}`

            const progressFile = `${opts.input}.progress_${fileTag}.csv`
            const outputFile = opts.output ? opts.output : `${opts.input}.out_${fileTag}.srt`

            if (await checkFileExists(progressFile))
            {
                const progress = await getProgress(progressFile)

                if (progress.length === sourceLines.length)
                {
                    console.error("[CLI]", `Progress already completed ${progressFile}`)
                    console.error("[CLI]", `Overwriting ${progressFile}`)
                    fs.writeFileSync(progressFile, '')
                    console.error("[CLI]", `Overwriting ${outputFile}`)
                    fs.writeFileSync(outputFile, '')
                }
                else
                {
                    console.error("[CLI]", `Resuming from ${progressFile}`, progress.length)
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
            }
            else
            {
                fs.writeFileSync(outputFile, '')
            }

            try
            {
                for await (const output of translator.translateLines(sourceLines))
                {
                    const csv = `${output.index}, ${wrapQuotes(output.finalTransform.replaceAll("\n", "\\N"))}\n`
                    const srtEntry = srtArrayWorking[output.index - 1]
                    srtEntry.text = output.finalTransform
                    const outSrt = parser.toSrt([srtEntry])
                    console.log(output.index, wrapQuotes(output.source), "->", wrapQuotes(output.finalTransform))
                    await Promise.all([
                        fs.promises.appendFile(progressFile, csv),
                        fs.promises.appendFile(outputFile, outSrt)
                    ])
                }
            } catch (error)
            {
                process.exit(1)
            }
        }
        else
        {
            console.error("[CLI]", "Assume plain text file", opts.input)
            const fileTag = `${opts.systemInstruction ? "Custom" : opts.to}`
            const ext = path.extname(opts.input)
            const outputFile = opts.output ? opts.output : `${opts.input}.out_${fileTag}${ext}`
            const text = fs.readFileSync(opts.input, 'utf-8')
            fs.writeFileSync(outputFile, '')
            await translatePlainText(translator, text, outputFile)
        }
    }
}

/**
 * @param {Translator} translator
 * @param {string} text
 * @param {import('node:fs').PathLike} [outfile]
 */
async function translatePlainText(translator, text, outfile)
{
    const lines = text.split(/\r?\n/)
    if (lines[lines.length - 1].length === 0)
    {
        lines.pop()
    }
    try
    {
        for await (const output of translator.translateLines(lines))
        {
            if (!translator.options.createChatCompletionRequest.stream)
            {
                console.log(output.transform)
            }
            if (outfile)
            {
                fs.appendFileSync(outfile, output.transform + "\n")
            }
        }
    } catch (error)
    {
        process.exit(1)
    }

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
        if (id === expectedId)
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
