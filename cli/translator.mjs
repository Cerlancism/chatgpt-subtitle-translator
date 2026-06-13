#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path';
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import * as undici from 'undici';

import { Command, Option } from "commander"
import log from 'loglevel'

import {
    DefaultOptions,
    Translator,
    TranslatorStructuredObject,
    TranslatorStructuredArray,
    TranslatorStructuredTimestamp,
    TranslatorAgent,
    createOpenAIClient,
    CooldownContext,
    subtitleParser,
    wrapQuotes
} from "../src/main.mjs"

import 'dotenv/config'

const proxyAgent = getProxyAgent()
const openai = createOpenAIClient(process.env.OPENAI_API_KEY, undefined, process.env.OPENAI_BASE_URL, proxyAgent)
const coolerChatGPTAPI = new CooldownContext(Number(process.env.OPENAI_API_RPM ?? 500), 60000, "ChatGPTAPI")
const coolerOpenAIModerator = new CooldownContext(Number(process.env.OPENAI_API_MODERATOR_RPM ?? process.env.OPENAI_API_RPM ?? 500), 60000, "OpenAIModerator")
const AGENT_SUMMARY_CACHE_VERSION = 1

function getProxyAgent() {
    const httpProxyConfig = process.env.http_proxy ?? process.env.HTTP_PROXY
    const httpsProxyConfig = process.env.https_proxy ?? process.env.HTTPS_PROXY

    if (httpProxyConfig || httpsProxyConfig) {
        log.debug("[CLI HTTP/HTTPS PROXY]", "Using HTTP/HTTPS Proxy from ENV Detected", { httpProxyConfig, httpsProxyConfig })
        const proxyAgent = new undici.EnvHttpProxyAgent();
        return proxyAgent
    }

    return undefined
}

/**
 * Adds all shared translator options to a command.
 * @param {Command} cmd
 * @returns {Command}
 */
function addTranslatorOptions(cmd) {
    return cmd
        .option("--from <language>", "Source language")
        .option("--to <language>", "Target language", "English")
        .option("-m, --model <model>", "OpenAI model to use for translation", process.env.OPENAI_DEFAULT_MODEL ?? DefaultOptions.createChatCompletionRequest.model)
        .option("--moderation-model <model>", "OpenAI moderation model", DefaultOptions.moderationModel)

        .option("-i, --input <file>", "Text file name to use as input, .srt or plain text")
        .option("-o, --output <file>", "Output file name, defaults to be based on input file name")
        .option("-s, --system-instruction <instruction>", "Override the prompt system instruction template `Translate ${from} to ${to}`")
        .option("-p, --plain-text <text>", "Only translate this input plain text. Not supported in timestamp mode, or with the agent subcommand using -r timestamp")
        .addOption(new Option("-r, --structured <mode>", "Structured response format mode").choices(["array", "object", "timestamp", "agent", "none"]).default("array"))

        .option("--experimental-max_token <value>", "", val => parseInt(val, 10), 0)
        .option("--experimental-input-multiplier <value>", "", val => parseInt(val, 10), 0)
        .option("-c, --context <tokens>", "Max context token budget for history. Includes as much translation history as fits within this token budget, chunked by the last value in --batch-sizes, to work better with prompt caching. Set to 0 to include history without a token limit check. Recommended: set to 30% less than the model's max context length.", val => parseInt(val, 10), DefaultOptions.useFullContext)

        .option("--initial-prompts <prompts>", "Initial prompt messages before the translation request messages, as a JSON array", JSON.parse, DefaultOptions.initialPrompts)
        .option("--use-moderator", "Use the OpenAI Moderation tool")
        .option("--no-prefix-number", "Don't prefix lines with numerical indices")
        .option("--no-line-matching", "Don't enforce one-to-one line quantity input output matching")
        .option("-b, --batch-sizes <sizes>", "Batch sizes for translation prompts in JSON Array. When omitted, batch size is determined automatically based on the context token budget", JSON.parse)
        .option("-g, --guard-repetition <threshold>", "Minimum pattern repeats before aborting a streaming response. Set to 0 to disable", val => parseInt(val, 10), DefaultOptions.guardRepetition)
        .option("-t, --temperature <temperature>", "Sampling temperature to use, should set a low value such as 0 to be more deterministic", parseFloat, DefaultOptions.createChatCompletionRequest.temperature)
        .option("--no-stream", "Disable stream progress output to terminal (streaming is on by default)")
        .option("--top_p <top_p>", "Nucleus sampling parameter, top_p probability mass", parseFloat)
        .option("--presence_penalty <presence_penalty>", "Penalty for new tokens based on their presence in the text so far", parseFloat)
        .option("--frequency_penalty <frequency_penalty>", "Penalty for new tokens based on their frequency in the text so far", parseFloat)
        .option("--logit_bias <logit_bias>", "Modify the likelihood of specified tokens appearing in the completion", JSON.parse)
        .option("--reasoning_effort <reasoning_effort>", "Constrains effort on reasoning for reasoning models")
        .addOption(new Option("--log-level <level>", "Log level").choices(["trace", "debug", "info", "warn", "error", "silent"]))
        .option("--silent", "Same as --log-level silent")
        .option("--quiet", "Same as --log-level silent")
}

/**
 * @param {readonly string[]} args
 */
async function createInstance(args) {
    const program = addTranslatorOptions(new Command()
        .name("translator")
        .description("Translation tool based on ChatGPT API"))

    addTranslatorOptions(program.command("agent")
        .description("Agentic multi-pass translation: planning pass observes content before translating"))
        .option("--skip-refine", "Skip final instruction refinement and use the base instruction directly")
        .option("--no-fitting", "Skip LLM-based token-range fitting for planning summaries and consolidation")
        .option("--context-summary <summary>", "Provide a context summary directly, skipping the batch summary scanning pass")
        .action(async (_, agentCmd) => {
            const opts = agentCmd.optsWithGlobals()
            await run(opts, buildOptions(opts), true)
        })

    program.action(async () => {
        const opts = program.opts()
        const isAgentAlias = opts.structured === "agent"
        if (isAgentAlias) opts.structured = "array"
        await run(opts, buildOptions(opts), isAgentAlias)
    })

    await program.parseAsync(args)
    const opts = program.opts()
    return { program, opts }
}

/**
 * Builds the TranslatorOptions object from parsed Commander opts.
 * @param {Record<string, any>} opts
 * @returns {Partial<import("../src/translator.mjs").TranslatorOptions>}
 */
function buildOptions(opts) {
    /** @type {Partial<import("../src/translator.mjs").TranslatorOptions>} */
    const options = {
        createChatCompletionRequest: {
            ...(opts.model && { model: opts.model }),
            ...(opts.temperature !== undefined && { temperature: opts.temperature }),
            ...(opts.top_p !== undefined && { top_p: opts.top_p }),
            stream: opts.stream,
            ...(opts.presence_penalty !== undefined && { presence_penalty: opts.presence_penalty }),
            ...(opts.frequency_penalty !== undefined && { frequency_penalty: opts.frequency_penalty }),
            ...(opts.logit_bias && { logit_bias: opts.logit_bias }),
            ...(opts.reasoning_effort && { reasoning_effort: opts.reasoning_effort }),
        },
        ...(opts.initialPrompts && { initialPrompts: opts.initialPrompts }),
        ...(opts.moderationModel !== undefined && { moderationModel: opts.moderationModel }),
        ...(opts.useModerator !== undefined && { useModerator: opts.useModerator }),
        ...(opts.prefixNumber !== undefined && { prefixNumber: opts.prefixNumber }),
        ...(opts.lineMatching !== undefined && { lineMatching: opts.lineMatching }),
        ...(opts.batchSizes && { batchSizes: opts.batchSizes }),
        ...(opts.structured && opts.structured !== "none" && { structuredMode: opts.structured }),
        ...(opts.experimentalMax_token && { max_token: opts.experimentalMax_token }),
        ...(opts.experimentalInputMultiplier && { inputMultiplier: opts.experimentalInputMultiplier }),
        ...(opts.context !== undefined && { useFullContext: opts.context }),
        ...(opts.guardRepetition !== undefined && { guardRepetition: opts.guardRepetition }),
        ...(opts.logLevel && { logLevel: opts.logLevel }),
        ...(opts.input && { inputFile: opts.input }),
        ...(opts.skipRefine && { skipRefineInstruction: true }),
        ...(opts.fitting === false && { skipFitting: true }),
        ...(opts.contextSummary && { agentContextSummary: opts.contextSummary })
    }

    log.setDefaultLevel("debug")

    if (opts.silent || opts.quiet) {
        options.logLevel = "silent"
    }

    if (options.logLevel) {
        log.setLevel(options.logLevel)
    }

    log.debug("[CLI]", "Log level", Object.entries(log.levels).find(x => x[1] === log.getLevel())?.[0])

    if (options.inputMultiplier && !options.max_token) {
        log.error("[CLI]", "[ERROR]", "--experimental-input-multiplier must be set with --experimental-max_token")
        process.exit(1)
    }

    return options
}

/**
 * @param {Record<string, any>} opts
 */
function getBaseSystemInstruction(opts) {
    return opts.systemInstruction ?? `Translate ${opts.from ? opts.from + " " : ""}to ${opts.to}`
}

/**
 * @param {string} inputFile
 */
function getAgentSummaryFile(inputFile) {
    return `${inputFile}.agent-summary.json`
}

/**
 * @param {Record<string, any>} opts
 * @param {Partial<import("../src/translator.mjs").TranslatorOptions>} options
 */
function getAgentSummaryMetadata(opts, options) {
    const inputStat = fs.statSync(opts.input)
    return {
        version: AGENT_SUMMARY_CACHE_VERSION,
        inputFile: opts.input,
        inputSize: inputStat.size,
        inputMtimeMs: inputStat.mtimeMs,
        from: opts.from,
        to: opts.to,
        model: options.createChatCompletionRequest?.model,
        structuredMode: options.structuredMode ?? "array",
        useFullContext: options.useFullContext,
        systemInstruction: getBaseSystemInstruction(opts),
    }
}

/**
 * @param {Record<string, any>} opts
 * @param {Partial<import("../src/translator.mjs").TranslatorOptions>} options
 */
function loadAgentSummary(opts, options) {
    const summaryFile = getAgentSummaryFile(opts.input)
    if (!fs.existsSync(summaryFile)) {
        return undefined
    }
    try {
        const cache = JSON.parse(fs.readFileSync(summaryFile, "utf-8"))
        const expected = getAgentSummaryMetadata(opts, options)
        const isCompatible =
            cache.version === expected.version &&
            cache.inputFile === expected.inputFile &&
            cache.inputSize === expected.inputSize &&
            cache.inputMtimeMs === expected.inputMtimeMs &&
            cache.from === expected.from &&
            cache.to === expected.to &&
            cache.model === expected.model &&
            cache.structuredMode === expected.structuredMode &&
            cache.useFullContext === expected.useFullContext &&
            cache.systemInstruction === expected.systemInstruction &&
            typeof cache.contextSummary === "string" &&
            cache.contextSummary.length > 0

        if (!isCompatible) {
            log.warn("[CLI]", `Ignoring stale agent summary cache ${summaryFile}`)
            return undefined
        }

        log.debug("[CLI]", `Using agent summary cache ${summaryFile}`)
        return cache.contextSummary
    } catch (error) {
        log.warn("[CLI]", `Could not read agent summary cache ${summaryFile}:`, error?.message ?? error)
        return undefined
    }
}

/**
 * @param {Record<string, any>} opts
 * @param {Partial<import("../src/translator.mjs").TranslatorOptions>} options
 * @param {{ contextSummary?: string, finalInstruction?: string }} result
 */
function saveAgentSummary(opts, options, result) {
    if (!result.contextSummary) return
    try {
        const summaryFile = getAgentSummaryFile(opts.input)
        const payload = {
            ...getAgentSummaryMetadata(opts, options),
            createdAt: new Date().toISOString(),
            contextSummary: result.contextSummary,
            finalInstruction: result.finalInstruction,
        }
        fs.writeFileSync(summaryFile, `${JSON.stringify(payload, null, 2)}\n`)
        log.debug("[CLI]", `Saved agent summary cache ${summaryFile}`)
    } catch (error) {
        log.warn("[CLI]", `Could not save agent summary cache for ${opts.input}:`, error?.message ?? error)
    }
}

export {
    getAgentSummaryFile,
    getAgentSummaryMetadata,
    loadAgentSummary,
    saveAgentSummary,
}

/**
 * @param {Record<string, any>} opts
 * @param {Partial<import("../src/translator.mjs").TranslatorOptions>} options
 * @param {boolean} [agentMode]
 */
async function run(opts, options, agentMode = false) {
    /** Wraps a progress output callback to a no-op when the log level is silent. @template {Function} F @param {F} fn */
    const unlessSilent = (fn) => log.getLevel() === log.levels.SILENT ? () => { } : fn

    if (agentMode && opts.input && !options.agentContextSummary) {
        const cachedSummary = loadAgentSummary(opts, options)
        if (cachedSummary) {
            options.agentContextSummary = cachedSummary
        }
    }

    /**
     * @type {import('../src/translator.mjs').TranslationServiceContext}
     */
    const services = {
        openai,
        cooler: coolerChatGPTAPI,
        onStreamChunk: unlessSilent((data) => {
            process.stdout.write(data)
        }),
        onStreamEnd: unlessSilent(() => {
            process.stdout.write("\n")
        }),
        onClearLine: unlessSilent(() => {
            readline.clearLine(process.stdout, 0)
            readline.cursorTo(process.stdout, 0)
        }),
        onAgentPlanningResult: agentMode && opts.input
            ? (result) => saveAgentSummary(opts, options, result)
            : undefined,
        moderationService: {
            openai,
            cooler: coolerOpenAIModerator
        }
    }

    const structuredTranslators = {
        array: TranslatorStructuredArray,
        timestamp: TranslatorStructuredTimestamp,
        object: TranslatorStructuredObject,
    }

    function getTranslator() {
        const language = { from: opts.from, to: opts.to }
        if (!agentMode) {
            const TranslatorClass = structuredTranslators[options.structuredMode] ?? Translator
            return new TranslatorClass(language, services, options)
        }
        // Agent mode composes an inner delegate; only array (default) and timestamp are supported
        const DelegateClass = structuredTranslators[options.structuredMode ?? "array"]
        if (DelegateClass !== TranslatorStructuredArray && DelegateClass !== TranslatorStructuredTimestamp) {
            log.error("[CLI]", `Unsupported agent delegate mode: ${options.structuredMode}`)
            process.exit(1)
        }
        return new TranslatorAgent(language, services, options, new DelegateClass(language, services, options))
    }

    const translator = getTranslator()

    if (opts.systemInstruction) {
        translator.systemInstruction = opts.systemInstruction
    }

    if (opts.plainText) {
        if (options.structuredMode === "timestamp") {
            log.error("[CLI]", "--plain-text is not supported in timestamp mode.")
            process.exit(1)
        }
        if (!(translator instanceof Translator || translator instanceof TranslatorAgent)) throw new Error("Expected Translator or TranslatorAgent")
        await runWithErrorExit(() => translatePlainText(translator, opts.plainText))
    }
    else if (opts.input) {
        const fileTag = opts.systemInstruction ? "Custom" : opts.to
        if (opts.input.endsWith(".srt")) {
            await translateSrtFile(translator, opts, options, agentMode, fileTag)
        }
        else {
            await translateTextFile(/** @type {import('../src/translator.mjs').Translator} */(translator), opts, fileTag)
        }
    }
}

/**
 * @param {Translator | TranslatorStructuredTimestamp | TranslatorAgent} translator
 * @param {Record<string, any>} opts
 * @param {{ structuredMode?: string }} options
 * @param {boolean} agentMode
 * @param {string} fileTag
 */
async function translateSrtFile(translator, opts, options, agentMode, fileTag) {
    log.debug("[CLI]", "Assume SRT file", opts.input)
    const text = fs.readFileSync(opts.input, 'utf-8')
    const srtArraySource = subtitleParser.fromSrt(text)
    const outputFile = opts.output ? opts.output : `${opts.input}.out_${fileTag}.srt`

    const isNoResumeMode = options.structuredMode === "timestamp" || agentMode
    if (isNoResumeMode) {
        log.warn("[CLI]", `${agentMode ? "Agent" : "Timestamp"} mode: progress resumption is not supported, starting from beginning.`)
        fs.writeFileSync(outputFile, '')
    }

    if (options.structuredMode === "timestamp") {
        if (!(translator instanceof TranslatorStructuredTimestamp || translator instanceof TranslatorAgent)) {
            throw new Error("Expected TranslatorStructuredTimestamp or TranslatorAgent")
        }
        await runWithErrorExit(() => translateTimestampSrt(translator, srtArraySource, outputFile))
        return
    }

    const srtArrayWorking = subtitleParser.fromSrt(text)
    const sourceLines = srtArraySource.map(x => x.text)

    if (translator instanceof TranslatorAgent) {
        await runWithErrorExit(() => writeSrtTranslation(translator, sourceLines, srtArrayWorking, outputFile))
        return
    }

    if (translator instanceof TranslatorStructuredTimestamp) throw new Error("Unexpected TranslatorStructuredTimestamp")

    const progressFile = `${opts.input}.progress_${fileTag}.csv`
    await resumeProgress(translator, sourceLines, progressFile, outputFile)
    await runWithErrorExit(() => writeSrtTranslation(translator, sourceLines, srtArrayWorking, outputFile, progressFile))
}

/**
 * @param {import('../src/translator.mjs').Translator} translator
 * @param {Record<string, any>} opts
 * @param {string} fileTag
 */
async function translateTextFile(translator, opts, fileTag) {
    log.debug("[CLI]", "Assume plain text file", opts.input)
    const ext = path.extname(opts.input)
    const outputFile = opts.output ? opts.output : `${opts.input}.out_${fileTag}${ext}`
    const text = fs.readFileSync(opts.input, 'utf-8')
    fs.writeFileSync(outputFile, '')
    await runWithErrorExit(() => translatePlainText(translator, text, outputFile))
}

/**
 * @param {() => Promise<void>} fn
 */
async function runWithErrorExit(fn) {
    try {
        await fn()
    } catch (error) {
        log.error("[CLI]", "Error", error)
        process.exit(1)
    }
}

/**
 * @param {TranslatorStructuredTimestamp | TranslatorAgent} translator
 * @param {ReturnType<typeof subtitleParser.fromSrt>} srtArraySource
 * @param {string} outputFile
 */
async function translateTimestampSrt(translator, srtArraySource, outputFile) {
    const timestampSource = srtArraySource.map(e => ({ start: e.startTime, end: e.endTime, text: e.text }))
    let outputId = 1
    for await (const output of translator.translateLines(timestampSource)) {
        // Timestamp delegates always yield TimestampEntry
        const srtOut = /** @type {import('../src/translatorStructuredTimestamp.mjs').TimestampEntry} */ (output)
        const entry = {
            id: String(outputId),
            startTime: srtOut.start,
            startSeconds: subtitleParser.timestampToSeconds(srtOut.start),
            endTime: srtOut.end,
            endSeconds: subtitleParser.timestampToSeconds(srtOut.end),
            text: srtOut.text
        }
        const outSrt = subtitleParser.toSrt([entry])
        log.info(outputId, entry.startTime, "->", entry.endTime, wrapQuotes(entry.text))
        await fs.promises.appendFile(outputFile, outSrt)
        outputId++
    }
}

/**
 * @param {import('../src/translator.mjs').Translator} translator
 * @param {string[]} sourceLines
 * @param {string} progressFile
 * @param {string} outputFile
 */
async function resumeProgress(translator, sourceLines, progressFile, outputFile) {
    if (await checkFileExists(progressFile)) {
        const progress = await getProgress(progressFile)

        if (progress.length === sourceLines.length) {
            log.debug("[CLI]", `Progress already completed ${progressFile}`)
            log.debug("[CLI]", `Overwriting ${progressFile}`)
            fs.writeFileSync(progressFile, '')
            log.debug("[CLI]", `Overwriting ${outputFile}`)
            fs.writeFileSync(outputFile, '')
        }
        else {
            log.debug("[CLI]", `Resuming from ${progressFile}`, progress.length)
            const sourceProgress = sourceLines.slice(0, progress.length).map((x, i) => translator.preprocessLine(x, i, 0))
            for (let index = 0; index < progress.length; index++) {
                let transform = progress[index]
                if (transform.startsWith("[Flagged]")) {
                    translator.moderatorFlags.set(index, transform)
                }
                else {
                    transform = translator.preprocessLine(transform, index, 0)
                }
                translator.workingProgress.push({ source: sourceProgress[index], transform })
            }
            translator.offset = progress.length
        }
    }
    else {
        fs.writeFileSync(outputFile, '')
    }
}

/**
 * @param {import('../src/translator.mjs').Translator | import('../src/translatorAgent.mjs').TranslatorAgent} translator
 * @param {string[]} sourceLines
 * @param {ReturnType<typeof subtitleParser.fromSrt>} srtArrayWorking
 * @param {string} outputFile
 * @param {string} [progressFile]
 */
async function writeSrtTranslation(translator, sourceLines, srtArrayWorking, outputFile, progressFile) {
    for await (const out of translator.translateLines(sourceLines)) {
        // String-based translators always yield LineOutput records
        const output = /** @type {import('../src/translatorBase.mjs').LineOutput} */ (out)
        const srtEntry = srtArrayWorking[output.index - 1]
        srtEntry.text = output.finalTransform
        const outSrt = subtitleParser.toSrt([srtEntry])
        log.info(output.index, wrapQuotes(output.source), "->", wrapQuotes(output.finalTransform))
        const writes = [fs.promises.appendFile(outputFile, outSrt)]
        if (progressFile) {
            const csv = `${output.index}, ${wrapQuotes(output.finalTransform.replaceAll("\n", "\\N"))}\n`
            writes.push(fs.promises.appendFile(progressFile, csv))
        }
        await Promise.all(writes)
    }
}

/**
 * @param {import('../src/translator.mjs').Translator | import('../src/translatorAgent.mjs').TranslatorAgent} translator
 * @param {string} text
 * @param {string} [outfile]
 */
async function translatePlainText(translator, text, outfile) {
    const lines = text.split(/\r?\n/)
    if (lines[lines.length - 1].length === 0) {
        lines.pop()
    }
    for await (const out of translator.translateLines(lines)) {
        // String-based translators always yield LineOutput records
        const output = /** @type {import('../src/translatorBase.mjs').LineOutput} */ (out)
        if (!translator.options.createChatCompletionRequest.stream) {
            log.info(output.transform)
        }
        if (outfile) {
            fs.appendFileSync(outfile, output.transform + "\n")
        }
    }
}

/**
 * @param {string} progressFile
 */
async function getProgress(progressFile) {
    const content = await fs.promises.readFile(progressFile, "utf-8")
    const lines = content.split(/\r?\n/)
    const progress = []

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim() === '') {
            continue
        }
        const splits = line.split(",")
        const id = Number(splits[0])
        const text = splits[1].trim()
        const expectedId = index + 1
        if (id === expectedId) {
            progress.push(text.substring(1, text.length - 1))
        }
        else {
            throw `Progress csv file not in order. Expected index ${expectedId}, got ${id}, text: ${text}`
        }
    }
    return progress
}

/**
 * @param {fs.PathLike} filePath
 */
async function checkFileExists(filePath) {
    try {
        await fs.promises.access(filePath);
        return true; // file exists
    } catch (error) {
        return false // file does not exist
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    createInstance(process.argv)
}
