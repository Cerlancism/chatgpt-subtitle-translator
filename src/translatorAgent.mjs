import log from "loglevel"
import { z } from "zod"
import { countTokens } from "gpt-tokenizer"
import { encode as encodeToon } from "@toon-format/toon"

import { summarise } from "llm-summary"
import { streamParse } from "./openai.mjs"
import { timestampToMilliseconds } from "./subtitle.mjs"
import { DefaultOptions } from "./translatorBase.mjs"
import { roundWithPrecision } from "./helpers.mjs"
import { Translator } from "./translator.mjs"
import { TranslatorStructuredTimestamp, toMsEntry } from "./translatorStructuredTimestamp.mjs"

const scanBatchSchema = z.object({
    batchSummary: z.string().describe("Translation notes for this scan window.")
})

const finalInstructionSchema = z.object({
    finalInstruction: z.string().describe("Translation system instruction for this subtitle file.")
})

const overviewSchema = z.object({
    overview: z.string().describe("Content overview of the subtitle file.")
})

const detectedLanguageSchema = z.object({
    from: z.string(),
    to: z.string()
})

const outputLanguageSchema = z.object({
    detectedLanguage: z.string(),
    matches: z.boolean()
})

const correctiveInstructionSchema = z.object({
    correctiveInstruction: z.string(),
    correctedSample: z.string()
})

const VERIFY_SAMPLE_SIZE = 5

const agentInstructionSchema = z.object({
    agentInstruction: z.string().describe("Self-instruction for scanning and translating this subtitle file.")
})

/** Fraction of useFullContext allocated to each scan window in Pass 1. */
export const SCAN_WINDOW_BUDGET_FRACTION = 0.5
/** Fraction of useFullContext used as the base context budget (overview, language detection, etc.). */
export const BASE_CONTEXT_BUDGET_FRACTION = 0.1
/** Fraction of useFullContext allocated to the agent instruction token budget. */
export const INSTRUCTION_BUDGET_FRACTION = 0.5
/** Fraction of the consolidation budget used as the target token count. */
export const CONSOLIDATION_TARGET_FRACTION = 0.5
/** Lower-bound fraction when expressing a target range (e.g. "~lower–upper tokens"). */
export const SUMMARY_RANGE_LOWER_FRACTION = 0.67
/** Multiplier over target tokens used as max_tokens for consolidation calls. */
export const CONSOLIDATION_MAX_TOKENS_MULTIPLIER = 1.5

/**
 * @typedef {import('./translatorStructuredTimestamp.mjs').TimestampEntry} TimestampEntry
 * @typedef {{ finalInstruction: string }} PlanningResult
 */

/** @param {number} useFullContext @returns {number} */
const agentInstructionTokenBudget = (useFullContext) => Math.floor(useFullContext * INSTRUCTION_BUDGET_FRACTION)

/**
 * Returns the inclusive end index of a scan window starting at startIdx,
 * consuming entries until adding the next would exceed tokenBudget.
 * Always includes at least one entry.
 *
 * @param {TimestampEntry[]} entries
 * @param {number} startIdx
 * @param {number} tokenBudget - max tokens per window; Infinity = no limit
 * @returns {number} inclusive end index
 */
function computeScanWindowEnd(entries, startIdx, tokenBudget) {
    let totalTokens = 0
    for (let i = startIdx; i < entries.length; i++) {
        const entryTokens = countTokens(encodeToon({ inputs: [entries[i]].map(toMsEntry) }))
        if (i > startIdx && totalTokens + entryTokens > tokenBudget) {
            return i - 1
        }
        totalTokens += entryTokens
    }
    return entries.length - 1
}


/**
 * Agentic multi-pass translator using composition.
 *
 * Pass 0 (Overview): Samples first/last entries for content overview and scan guidance.
 * Pass 1 (Planning): Scans all entries in token-bounded windows (SCAN_WINDOW_BUDGET_FRACTION of useFullContext), accumulating
 * batch summaries. After scanning, summaries are consolidated and optionally refined
 * into a final instruction. Custom batch slice boundaries are committed per window.
 * Pass 2 (Translation): Uses the accumulated instruction and custom slices,
 * delegating translation to the inner translator via the mode adapter.
 */
export class TranslatorAgent {

    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} options
     * @param {TranslatorStructuredTimestamp | Translator} delegate - inner translator instance
     */
    constructor(language, services, options, delegate) {
        this.language = language
        this.services = services
        this.options = /** @type {import("./translator.mjs").TranslatorOptions & {createChatCompletionRequest: {model: string}}} */ ({
            ...DefaultOptions,
            ...options,
            createChatCompletionRequest: { ...DefaultOptions.createChatCompletionRequest, ...options.createChatCompletionRequest }
        })
        /** @type {TranslatorStructuredTimestamp | Translator} */
        this.delegate = delegate
        this.systemInstruction = delegate.systemInstruction

        /** @type {AbortController | undefined} */
        this.streamController = undefined

        this.planningPromptTokens = 0
        this.planningCompletionTokens = 0
        this.planningElapsedTimeMs = 0
        /** @type {number | undefined} */
        this._planningLastCallTime = undefined

        /** @type {string} Detected source language from Pass 0 (empty if unknown) */
        this.detectedFrom = ""
        /** @type {string} Detected target language from Pass 0 */
        this.detectedTo = ""
    }

    get baseContextBudget() {
        return this.options.useFullContext ? Math.floor(this.options.useFullContext * BASE_CONTEXT_BUDGET_FRACTION) : undefined
    }

    /** @returns {string} Target language for use in prompts - falls back to language.to */
    get targetLanguage() {
        return this.detectedTo || this.language.to
    }

    /**
     * Core usage accumulation: adds prompt/completion counts, updates elapsed time, and logs.
     * @param {number} promptTokens
     * @param {number} completionTokens
     * @param {string} [label]
     */
    _addPlanningUsage(promptTokens, completionTokens, label) {
        const now = Date.now()
        if (this._planningLastCallTime !== undefined) this.planningElapsedTimeMs += now - this._planningLastCallTime
        this._planningLastCallTime = now
        this.planningPromptTokens += promptTokens
        this.planningCompletionTokens += completionTokens
        const { planningPromptRate, planningCompletionRate, planningRate } = this.usage
        log.debug(
            `[TranslatorAgent]${label ? ` [${label}]` : ""} planning tokens:`,
            "\n\tStep:", promptTokens, "+", completionTokens, "=", promptTokens + completionTokens,
            "\n\tTotal:", this.planningPromptTokens, "+", this.planningCompletionTokens, "=", this.planningPromptTokens + this.planningCompletionTokens,
            ...(planningRate !== undefined ? ["\n\tRate:", planningPromptRate, "+", planningCompletionRate, "=", planningRate, "TPM"] : []),
        )
    }

    /**
     * Accumulates token usage from a SummariseResult and logs it.
     * @param {import('llm-summary').SummariseResult} result
     * @param {string} [label]
     */
    _accumulateSummariseUsage(result, label) {
        return this._addPlanningUsage(result.usage.input, result.usage.output, label)
    }

    /**
     * Builds a base {@link import('llm-summary').SummariseOptions} object with model and verbose
     * derived from current options and log level, merged with any call-specific overrides.
     * @param {import('llm-summary').SummariseOptions} [extras] - call-specific overrides
     * @returns {import('llm-summary').SummariseOptions}
     */
    _summariseOptions(extras = {}) {
        return {
            model: this.options.createChatCompletionRequest.model,
            verbose: log.getLevel() <= log.levels.DEBUG,
            ...extras
        }
    }

    /**
     * Accumulates token usage from a planning-pass streamParse response and logs it.
     * @param {import('openai').OpenAI.Chat.ChatCompletion} completion
     * @param {string} [label] - step name for logging
     */
    _accumulatePlanningUsage(completion, label) {
        return this._addPlanningUsage(
            completion?.usage?.prompt_tokens ?? 0,
            completion?.usage?.completion_tokens ?? 0,
            label
        )
    }

    get usage() {
        const base = this.delegate.usage
        const planningPromptTokens = this.planningPromptTokens
        const planningCompletionTokens = this.planningCompletionTokens
        const planningMinutesElapsed = this.planningElapsedTimeMs > 0 ? this.planningElapsedTimeMs / 1000 / 60 : undefined
        const planningPromptRate = planningMinutesElapsed ? roundWithPrecision(planningPromptTokens / planningMinutesElapsed, 0) : undefined
        const planningCompletionRate = planningMinutesElapsed ? roundWithPrecision(planningCompletionTokens / planningMinutesElapsed, 0) : undefined
        const planningRate = planningMinutesElapsed ? roundWithPrecision((planningPromptTokens + planningCompletionTokens) / planningMinutesElapsed, 0) : undefined
        return {
            ...base,
            planningPromptTokens,
            planningCompletionTokens,
            planningPromptRate,
            planningCompletionRate,
            planningRate,
        }
    }

    printUsage() {
        if (this.planningPromptTokens > 0 || this.planningCompletionTokens > 0) {
            const { planningPromptTokens, planningCompletionTokens, planningPromptRate, planningCompletionRate, planningRate } = this.usage
            log.debug(
                `[TranslatorAgent] Planning tokens:`,
                "\n\tTokens:", planningPromptTokens, "+", planningCompletionTokens, "=", planningPromptTokens + planningCompletionTokens,
                ...(planningRate !== undefined ? ["\n\tRate:", planningPromptRate, "+", planningCompletionRate, "=", planningRate, "TPM", this.services.cooler?.rate, "RPM"] : []),
            )
        }
    }

    /**
     * Convenience wrapper: calls the shared streamParse with this agent's services and controller binding.
     * @param {import('openai').OpenAI.ChatCompletionCreateParams} params
     * @param {{structure: import('zod').ZodType, name: string}} zFormat
     */
    _streamParse(params, zFormat) {
        return streamParse(this.services, params, zFormat, { onController: (c) => { this.streamController = c } })
    }

    abort() {
        this.streamController?.abort()
        this.delegate.abort()
    }

    // ────────────────────────────────────────────────────────────────
    //  Pass 0: Overview
    // ────────────────────────────────────────────────────────────────

    /**
     * Pass 0: Two-step overview and agent instruction generation.
     *
     * Step 1: Samples first/last N entries (N = batchSizes[0]) with subtitle metadata
     *         to produce a content overview. Logged for visibility.
     *
     * Step 1b: Detects source and target languages from the base instruction and overview,
     *          setting `this.detectedFrom` and `this.detectedTo`.
     *
     * Step 2: Feeds the overview to the model to generate an enhanced agent instruction.
     *         The model decides whether to incorporate subtitle metadata into the instruction.
     *
     * @param {TimestampEntry[]} entries
     * @param {string} subtitleMeta - subtitle metadata string (file, entry count, duration)
     * @returns {Promise<{ overview: string, agentInstruction: string } | null>}
     */
    async _runOverviewPass(entries, subtitleMeta) {
        const sampleSize = this.options.batchSizes?.[0] ?? 10
        const head = entries.slice(0, sampleSize)
        const tail = entries.length > sampleSize
            ? entries.slice(-sampleSize)
            : []

        const sampleLabel = tail.length > 0
            ? `First ${head.length} entries (0-${head.length - 1}) and last ${tail.length} entries (${entries.length - tail.length}-${entries.length - 1})`
            : `All ${head.length} entries`

        log.debug("[TranslatorAgent]", "Pass 0 (Overview): sampling", sampleLabel)

        // Step 1: Generate overview from metadata + sampled entries
        const overview = await this._generateOverview(head, tail, sampleLabel, subtitleMeta)
        if (!overview) return null

        log.debug("[TranslatorAgent]", "Overview:", overview)

        // Step 1b: Detect source and target languages from instruction + sampled content
        await this._detectLanguages(head, tail)

        // Step 2: Generate enhanced agent instruction from the overview
        const agentInstruction = await this._generateAgentInstruction(overview)
        if (!agentInstruction) return { overview, agentInstruction: "" }

        log.debug("[TranslatorAgent]", "Agent instruction:", agentInstruction)
        return { overview, agentInstruction }
    }

    /**
     * Step 1 of Pass 0: produces a content overview from subtitle metadata and sampled entries.
     *
     * @param {TimestampEntry[]} head - first N sampled entries
     * @param {TimestampEntry[]} tail - last N sampled entries (may be empty)
     * @param {string} sampleLabel - human-readable description of the sample
     * @param {string} subtitleMeta - subtitle metadata (file, entry count, duration)
     * @returns {Promise<string | null>}
     */
    async _generateOverview(head, tail, sampleLabel, subtitleMeta) {
        const sampledContent = tail.length > 0
            ? `${sampleLabel}:\n\nFirst:\n${encodeToon({ inputs: head.map(toMsEntry) })}\n\nLast:\n${encodeToon({ inputs: tail.map(toMsEntry) })}`
            : `${sampleLabel}:\n${encodeToon({ inputs: head.map(toMsEntry) })}`
        const userContent = `${subtitleMeta}\n\n${sampledContent}`

        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const messages = [
            {
                role: "system",
                content: `${this.systemInstruction}\n---\n` +
                    `You are previewing a subtitle file before translation. ` +
                    `Analyze the subtitle metadata and sampled entries to produce a brief overview (2-5 sentences).\n\n` +
                    `# Rules:\n` +
                    `1. Cover: file name/episode identity, total duration, genre, setting, tone, people names, and any notable linguistic features (dialect, slang, technical jargon).\n` +
                    `2. Retain key subtitle metadata (file name, entry count, duration) in the overview.`
            },
            { role: "user", content: userContent }
        ]

        try {
            await this.services.cooler?.cool()
            const output = await this._streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: this.baseContextBudget
            }, { structure: overviewSchema, name: "agent_overview" })
            this._accumulatePlanningUsage(output, "overview")
            const parsed = output.choices[0]?.message?.parsed
            if (!parsed || output.choices[0]?.message?.refusal) {
                log.warn("[TranslatorAgent]", "Overview step refusal or empty response")
                return null
            }
            return parsed.overview
        } catch (error) {
            log.warn("[TranslatorAgent]", "Overview step failed:", error?.message, "- continuing without overview")
            return null
        }
    }

    /**
     * Step 1b of Pass 0: detects source and target languages from the base system instruction
     * and sampled subtitle content, setting `this.detectedFrom` and `this.detectedTo`.
     *
     * @param {TimestampEntry[]} head - first N sampled entries
     * @param {TimestampEntry[]} tail - last N sampled entries (may be empty)
     * @returns {Promise<void>}
     */
    async _detectLanguages(head, tail) {
        const sampledContent = tail.length > 0
            ? `First entries:\n${encodeToon({ inputs: head.map(toMsEntry) })}\n\nLast entries:\n${encodeToon({ inputs: tail.map(toMsEntry) })}`
            : encodeToon({ inputs: head.map(toMsEntry) })

        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const messages = [
            {
                role: "system",
                content: `Identify the source language and the target translation language from the content and/or system instruction.\n` +
                    `System instruction: ${this.systemInstruction}\n` +
                    `Return the language names in English (e.g. "Japanese", "English"). ` +
                    `If the source language cannot be determined, return an empty string for "from".`
            },
            { role: "user", content: sampledContent }
        ]

        try {
            await this.services.cooler?.cool()
            const output = await this._streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: this.baseContextBudget
            }, { structure: detectedLanguageSchema, name: "agent_detect_languages" })
            this._accumulatePlanningUsage(output, "detect_languages")
            const parsed = output.choices[0]?.message?.parsed
            if (!parsed || output.choices[0]?.message?.refusal) {
                log.warn("[TranslatorAgent]", "Language detection refusal or empty response")
                return
            }
            this.detectedFrom = parsed.from
            this.detectedTo = parsed.to
            log.debug("[TranslatorAgent]", "Detected languages - from:", this.detectedFrom || "(unknown)", "| to:", this.detectedTo)
        } catch (error) {
            log.warn("[TranslatorAgent]", "Language detection failed:", error?.message)
        }
    }

    /**
     * Step 2 of Pass 0: generates an enhanced agent instruction from the overview.
     * The model decides what to include - it may incorporate subtitle metadata or not.
     *
     * @param {string} overview - content overview from step 1
     * @returns {Promise<string | null>}
     */
    async _generateAgentInstruction(overview) {
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const messages = [
            {
                role: "system",
                content: `Base instruction: ${this.systemInstruction}\n---\n` +
                    `Using the base instruction and the content overview below, produce an enhanced instruction ` +
                    `for yourself to use when scanning and translating this subtitle file.\n\n` +
                    `# Rules:\n` +
                    `1. If the base instruction includes any glossary, dictionary, cast names, or term mappings, reproduce them verbatim in the enhanced instruction.\n` +
                    `2. Carry forward useful metadata from the overview (file identity, duration, entry count, names, genre/tone).\n` +
                    `3. Specify what to watch for: scene boundaries, speaker changes, contextual dependencies, terminology consistency, tone/register shifts.\n`
            },
            { role: "user", content: `# Content overview:\n${overview}` }
        ]

        try {
            await this.services.cooler?.cool()
            const output = await this._streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: this.baseContextBudget
            }, { structure: agentInstructionSchema, name: "agent_instruction" })
            this._accumulatePlanningUsage(output, "instruction")
            const parsed = output.choices[0]?.message?.parsed
            if (!parsed || output.choices[0]?.message?.refusal) {
                log.warn("[TranslatorAgent]", "Agent instruction step refusal or empty response")
                return null
            }
            return parsed.agentInstruction
        } catch (error) {
            log.warn("[TranslatorAgent]", "Agent instruction step failed:", error?.message, "- continuing without")
            return null
        }
    }

    // ────────────────────────────────────────────────────────────────
    //  Pass 1: Planning
    // ────────────────────────────────────────────────────────────────

    /**
     * Pass 1: scans all entries in token-bounded windows (SCAN_WINDOW_BUDGET_FRACTION of useFullContext each),
     * accumulating batch summaries into a final instruction.
     *
     * @param {TimestampEntry[]} entries
     * @param {{ overview: string, agentInstruction: string } | null} [overviewResult]
     * @param {string} [subtitleMeta]
     * @returns {Promise<PlanningResult>}
     */
    async runPlanningPass(entries, overviewResult, subtitleMeta) {
        const scanTokenBudget = this.options.useFullContext > 0
            ? Math.floor(this.options.useFullContext * SCAN_WINDOW_BUDGET_FRACTION)
            : Infinity
        const budget = agentInstructionTokenBudget(this.options.useFullContext)

        log.debug("[TranslatorAgent]", "Pass 1 (Planning): scanning", entries.length,
            "entries | scan token budget:", scanTokenBudget === Infinity ? "unlimited" : scanTokenBudget,
            "| instruction budget:", budget, "tokens")

        let accumulatedBatchSummary = ""

        if (this.options.agentContextSummary) {
            log.debug("[TranslatorAgent]", "Pass 1 skipped: using provided context summary")
            accumulatedBatchSummary = this.options.agentContextSummary
        } else {
            for (let batchStart = 0; batchStart < entries.length;) {
                const batchEnd = computeScanWindowEnd(entries, batchStart, scanTokenBudget)
                const batch = entries.slice(batchStart, batchEnd + 1)

                const scanPct = roundWithPrecision(batchStart / entries.length * 100, 0)
                log.debug("[TranslatorAgent]", `Scanning window ${batchStart}-${batchEnd} (${batch.length} entries) [${scanPct}%]`)

                await this.services.cooler?.cool()

                try {
                    const result = await this._runScanBatch(batch, batchStart, accumulatedBatchSummary, overviewResult?.agentInstruction)
                    if (result) {
                        const newNote = result.batchSummary?.trim()
                        if (newNote) {
                            log.debug("[TranslatorAgent]", "Batch summary from window", batchStart, `(${countTokens(newNote)} tokens):\n`, newNote)
                            const candidate = accumulatedBatchSummary
                                ? `${accumulatedBatchSummary}\n${newNote}`
                                : newNote

                            const accumulatedBatchSummaryTokens = countTokens(candidate)
                            log.debug("[TranslatorAgent]",
                                "Accumulated batch summary length:", candidate.length, `(${accumulatedBatchSummaryTokens}/${budget} tokens)`)
                            if (accumulatedBatchSummaryTokens > budget) {
                                log.debug("[TranslatorAgent]",
                                    "Batch summary accumulator over budget (>", budget, "tokens) - consolidating")
                                await this.services.cooler?.cool()
                                accumulatedBatchSummary = await this._consolidateBatchSummaries(
                                    accumulatedBatchSummary, newNote, budget, overviewResult?.agentInstruction
                                )
                                log.debug("[TranslatorAgent]", "Consolidated batch summary:", accumulatedBatchSummary)
                                log.debug("[TranslatorAgent]",
                                    "Consolidated batch summary length:", accumulatedBatchSummary.length, `(${countTokens(accumulatedBatchSummary)} tokens)`)
                            } else {
                                accumulatedBatchSummary = candidate
                            }
                        }
                    } else {
                        log.warn("[TranslatorAgent]", "Scan batch returned null for range", batchStart, "-", batchEnd)
                    }
                } catch (error) {
                    log.warn("[TranslatorAgent]", "Scan batch error:", error?.message,
                        "for range", batchStart, "-", batchEnd)
                }

                batchStart = batchEnd + 1
            }
        }

        // Final synthesis: consolidate all batch summaries, then produce refined directive
        let finalInstruction = accumulatedBatchSummary
        if (accumulatedBatchSummary) {
            let consolidatedContextSummary
            if (this.options.agentContextSummary) {
                // Provided summary is already consolidated - skip the consolidation API call
                consolidatedContextSummary = accumulatedBatchSummary
            } else {
                await this.services.cooler?.cool()
                consolidatedContextSummary = await this._consolidateBatchSummaries(accumulatedBatchSummary, undefined, budget, overviewResult?.agentInstruction)
            }
            log.debug("[TranslatorAgent]", "Context summary:\n", consolidatedContextSummary)

            let refinedDirective
            if (!this.options.skipRefineInstruction) {
                await this.services.cooler?.cool()
                refinedDirective = await this._refineFinalInstruction(consolidatedContextSummary, budget)
                log.debug("[TranslatorAgent]", "Refined instruction:\n", refinedDirective)
            }

            finalInstruction = [refinedDirective ?? this.systemInstruction, consolidatedContextSummary, subtitleMeta]
                .filter(Boolean).join("\n---\n")
        }

        log.debug("[TranslatorAgent]", "Pass 1 complete.",
            "Final instruction length:", finalInstruction.length,
            `(${countTokens(finalInstruction)} tokens)`)

        return { finalInstruction }
    }

    /**
     * Makes a single non-streaming model call to scan one batch.
     * Returns the parsed planning result or null on failure/refusal.
     *
     * @param {TimestampEntry[]} batch
     * @param {number} batchStart - absolute index of batch[0] in the full entries array
     * @param {string} accumulatedBatchSummary - running context from previous scan batches
     * @param {string} [agentInstruction] - self-instruction from overview pass
     * @returns {Promise<{batchSummary: string} | null>}
     */
    async _runScanBatch(batch, batchStart, accumulatedBatchSummary, agentInstruction) {
        const budget = this.baseContextBudget
        const summaryTokenRange = budget
            ? `5. Keep the summary between ~${Math.floor(budget * SUMMARY_RANGE_LOWER_FRACTION)} and ~${budget} tokens.`
            : ""
        const contextSection = accumulatedBatchSummary
            ? `\n---\nContext from previous segments:\n${accumulatedBatchSummary}\n---\n`
            : "\n---\n"
        const agentSection = agentInstruction
            ? `Scan guidance:\n${agentInstruction}\n\n`
            : ""
        const systemContent = [
            contextSection,
            agentSection,
            `You are scanning a context window of entries ${batchStart} to ${batchStart + batch.length - 1} ` +
            `(${timestampToMilliseconds(batch[0].start)}-${timestampToMilliseconds(batch[batch.length - 1].end)} ms, ` +
            `${batch[0].start}-${batch[batch.length - 1].end}).\n\n` +
            `# Rules for batchSummary:\n` +
            `1. Write in ${this.targetLanguage}.\n` +
            `2. Open with your overall impression of this window's content.\n` +
            `3. Write only what is new or notable here - do not repeat or refine prior context.\n` +
            `4. Cover the 5W1H: who (names, roles, relationships), what (events, terms, objects), ` +
            `where (locations, settings), when (time context), why/how (tone, register, dialect, intent).\n` +
            summaryTokenRange
        ].join("")

        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        const userMessage = { role: "user", content: encodeToon({ inputs: batch.map(toMsEntry) }) }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const messages = [
            { role: "system", content: systemContent },
            userMessage
        ]

        const output = await this._streamParse({
            messages,
            ...this.options.createChatCompletionRequest,
            stream: this.options.createChatCompletionRequest.stream,
            max_tokens: budget
        }, {
            structure: scanBatchSchema,
            name: "agent_scan"
        })
        this._accumulatePlanningUsage(output, "scan")
        const message = output.choices[0]?.message
        if (!message || message.refusal) {
            log.warn("[TranslatorAgent]", "Scan batch refusal or empty response at position", batchStart)
            return null
        }

        const batchSummary = message.parsed?.batchSummary?.trim()
        if (batchSummary && budget) {
            const summaryTokens = countTokens(batchSummary)
            const targetLower = Math.floor(budget * SUMMARY_RANGE_LOWER_FRACTION)
            if (summaryTokens < targetLower || summaryTokens > budget) {
                log.debug("[TranslatorAgent]",
                    `Scan batch summary out of range (${summaryTokens} tokens, target: ${targetLower}-${budget}) - fitting`)
                const scanFitInstructions =
                    `Write in ${this.targetLanguage}.\n` +
                    `Open with your overall impression of this window's content.\n` +
                    `Write only what is new or notable - do not repeat or refine prior context.\n` +
                    `Cover the 5W1H: who (names, roles, relationships), what (events, terms, objects), ` +
                    `where (locations, settings), when (time context), why/how (tone, register, dialect, intent).`
                try {
                    await this.services.cooler?.cool()
                    const result = await summarise(
                        this.services.openai,
                        batchSummary,
                        targetLower,
                        budget,
                        this._summariseOptions({ contextBudget: budget, instructions: scanFitInstructions })
                    )
                    this._accumulateSummariseUsage(result, "scan_fit")
                    log.debug("[TranslatorAgent]",
                        `Scan fit: ${result.tokens} tokens, ${result.attempts} attempts, withinRange: ${result.withinRange}`)
                    return { batchSummary: result.summary }
                } catch (error) {
                    log.warn("[TranslatorAgent]", "Scan batch fit failed:", error?.message, "- using original")
                }
            }
        }

        return message.parsed
    }

    /**
     * Consolidates an over-budget accumulator with a new note into the target token range.
     * Uses two-phase summarisation (draft → fit) for reliable token range enforcement.
     * Falls back to simple truncation if the summarise call fails.
     *
     * @param {string} existing - current accumulated batch summaries
     * @param {string} newNote - newly observed batch summary to merge in; pass `""` for final consolidation
     * @param {number} budget - token budget for the consolidation output
     * @param {string} [agentInstruction] - scan guidance included in the summarisation instructions
     * @returns {Promise<string>}
     */
    async _consolidateBatchSummaries(existing, newNote = "", budget, agentInstruction) {
        const isFinal = !newNote
        const targetTokens = Math.floor(budget * CONSOLIDATION_TARGET_FRACTION)
        const targetLower = Math.floor(targetTokens * SUMMARY_RANGE_LOWER_FRACTION)
        const combined = newNote ? `${existing}\n${newNote}` : existing
        const targetRange = `~${targetLower}-${targetTokens} tokens`
        const agentSection = agentInstruction ? `\nScan guidance:\n${agentInstruction}` : ""
        const consolidationInstructions = agentSection +
            (isFinal
                ? `You are doing a final consolidation of all batch summaries for a subtitle file ` +
                `into a single complete set of notes (target: ${targetRange}). ` +
                `This will be used as the full context for the subtitles - preserve all details.`
                : `You are doing consolidation of all given batch summary windows for a subtitle file ` +
                `into a single condensed set of notes (target: ${targetRange}). ` +
                `More batches will follow - stay concise but keep all unique facts.`) + "\n\n" +
            `# Rules:\n` +
            `1. Write in ${this.targetLanguage}.\n` +
            `2. Open with your overall impression of the content so far.\n` +
            `3. Preserve all unique 5W1H facts (who, what, where, when, why/how - names, locations, terms, tone, dialect).\n` +
            `4. Remove duplicate or contradictory information. ${isFinal ? "Be thorough - this is the last pass." : "Keep it concise - more content is coming."}`
        try {
            const result = await summarise(
                this.services.openai,
                combined,
                targetLower,
                targetTokens,
                this._summariseOptions({ contextBudget: budget, instructions: consolidationInstructions })
            )
            this._accumulateSummariseUsage(result, isFinal ? "consolidate_final" : "consolidate")
            log.debug("[TranslatorAgent]",
                `Consolidation${isFinal ? " (final)" : ""}: ${result.tokens} tokens,`,
                `${result.attempts} attempts, withinRange: ${result.withinRange}`)
            if (result.summary) return result.summary
        } catch (error) {
            log.warn("[TranslatorAgent]", "Consolidation failed:", error?.message, "- truncating")
        }
        // Fallback: keep as much as fits within budget
        if (countTokens(combined) <= budget) return combined
        // Over budget - trim from front of existing to make room for newNote
        const existingLines = existing.split("\n")
        for (let drop = 1; drop < existingLines.length; drop++) {
            const trimmed = existingLines.slice(drop).join("\n") + (newNote ? "\n" + newNote : "")
            if (countTokens(trimmed) <= budget) return trimmed
        }
        // Nothing from existing fits - keep only newNote (or existing if final)
        return newNote || existing
    }

    /**
     * Refines the base system instruction against the scanned context.
     * Only makes changes if the base instruction is redundant or misaligned - otherwise returns it verbatim.
     *
     * @param {string} contextSummary - consolidated context from all scan windows
     * @param {number} budget - max_tokens for the model call
     * @returns {Promise<string | null>}
     */
    async _refineFinalInstruction(contextSummary, budget) {
        const messages = /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */ ([
            {
                role: "system",
                content: `You are a professional translation assistant producing a final translation instruction for a subtitle file. ` +
                    `Your goal is a lean, focused instruction.\n\n` +
                    `# Rules:\n` +
                    `1. Preserve ${this.targetLanguage} as the target language and any stylistic directives that apply to the observed content.\n` +
                    `2. If the base instruction contains a glossary, dictionary, or list of terms/names, ` +
                    `keep it but filter it to only entries that appear in or are directly relevant to the observed content. ` +
                    `3. Remove instructions that are redundant, contradicted, or clearly out of scope given what was observed.\n` +
                    `4. Do not embed narrative facts from the context - keep it as concise translator guidance.\n`
            },
            {
                role: "user",
                content:
                    `# Base instruction:\n${this.systemInstruction}\n\n` +
                    `# Observed content context:\n${contextSummary}`
            }
        ])
        try {
            const output = await this._streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: budget
            }, { structure: finalInstructionSchema, name: "agent_refine_instruction" })
            this._accumulatePlanningUsage(output, "refine_instruction")
            const parsed = output.choices[0]?.message?.parsed
            if (parsed?.finalInstruction) return parsed.finalInstruction
        } catch (error) {
            log.warn("[TranslatorAgent]", "Final instruction refinement failed:", error?.message, "- using base instruction")
        }
        return null
    }

    // ────────────────────────────────────────────────────────────────
    //  Pass 2: Translation
    // ────────────────────────────────────────────────────────────────

    /**
     * Checks whether the first translated output is in the expected target language.
     * Returns true if it matches (or verification could not be determined), false if mismatch detected.
     *
     * @param {string} sampleText - first translated output text to verify
     * @returns {Promise<{detectedLanguage: string, matches: boolean}>}
     */
    async _verifyOutputLanguage(sampleText) {
        const target = this.targetLanguage
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const messages = [
            {
                role: "system",
                content: `Identify the language of the given text and check if it matches the expected target language: "${target}".`
            },
            { role: "user", content: sampleText }
        ]
        try {
            await this.services.cooler?.cool()
            const output = await this._streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: this.baseContextBudget
            }, { structure: outputLanguageSchema, name: "agent_verify_language" })
            this._accumulatePlanningUsage(output, "verify_language")
            const parsed = output.choices[0]?.message?.parsed
            if (!parsed || output.choices[0]?.message?.refusal) {
                log.warn("[TranslatorAgent]", "Output language verification refusal or empty response - skipping")
                return { detectedLanguage: "", matches: true }
            }
            log.debug("[TranslatorAgent]", "Output language verification - detected:", parsed.detectedLanguage, "| matches:", parsed.matches)
            return parsed
        } catch (error) {
            log.warn("[TranslatorAgent]", "Output language verification failed:", error?.message, "- skipping")
            return { detectedLanguage: "", matches: true }
        }
    }

    /**
     * Generates a strong corrective instruction in the target language to enforce output language,
     * and produces a corrected translation of the sample as a few-shot example.
     * Falls back to a hardcoded string if the LLM call fails.
     *
     * @param {string} sample - the mistranslated first output text
     * @param {string} detectedLanguage - the language detected in the mistranslated output
     * @returns {Promise<string>}
     */
    async _generateCorrectiveInstruction(sample, detectedLanguage) {
        const target = this.targetLanguage
        const sourcePart = detectedLanguage ? ` The input is in ${detectedLanguage}.` : ""
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const messages = [
            {
                role: "system",
                content: `Write a single strong instruction in ${target} that firmly directs a translator to produce all output exclusively in ${target}.${sourcePart} Be direct and emphatic.\n` +
                    `Also translate the given sample text into ${target} as a corrected example.`
            },
            { role: "user", content: sample }
        ]
        try {
            await this.services.cooler?.cool()
            const output = await this._streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: this.baseContextBudget
            }, { structure: correctiveInstructionSchema, name: "agent_corrective_instruction" })
            this._accumulatePlanningUsage(output, "corrective_instruction")
            const parsed = output.choices[0]?.message?.parsed
            if (parsed?.correctiveInstruction) {
                log.debug("[TranslatorAgent]", "Corrective instruction:", parsed.correctiveInstruction)
                log.debug("[TranslatorAgent]", "Corrected sample:", parsed.correctedSample)
                const parts = [parsed.correctiveInstruction]
                if (parsed.correctedSample) {
                    parts.push(`Example:\n${sample}\n->\n${parsed.correctedSample}`)
                }
                return parts.join("\n")
            }
        } catch (error) {
            log.warn("[TranslatorAgent]", "Corrective instruction generation failed:", error?.message)
        }
        return `IMPORTANT: All output MUST be in ${target} only.`
    }

    /**
     * Translates a small sample of entries directly (outside the delegate's batch loop)
     * and verifies the output is in the target language. On mismatch, generates a
     * corrective instruction, appends it to the delegate's system instruction, and retries.
     *
     * @param {string[]} sampleTexts - raw text content of sample entries
     * @returns {Promise<void>}
     */
    async _verifyLanguageWithSample(sampleTexts) {
        if (sampleTexts.length === 0) return

        const MAX_ATTEMPTS = 3

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                const text = sampleTexts.map((t, i) => `${i + 1}. ${t}`).join("\n\n")
                /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
                const messages = [
                    { role: "system", content: this.delegate.systemInstruction },
                    ...this.options.initialPrompts,
                    { role: "user", content: text }
                ]

                await this.services.cooler?.cool()
                const response = await this.services.openai.chat.completions.create({
                    messages,
                    ...this.options.createChatCompletionRequest,
                    stream: false,
                    max_tokens: this.baseContextBudget
                })

                const sampleOutput = response.choices[0]?.message?.content ?? ""
                this._accumulatePlanningUsage(response, "sample_verify")

                if (!sampleOutput.trim()) {
                    log.warn("[TranslatorAgent]", "Sample translation empty, attempt:", attempt + 1)
                    continue
                }

                const { detectedLanguage, matches } = await this._verifyOutputLanguage(sampleOutput)

                if (matches) {
                    log.debug("[TranslatorAgent]", "Sample language verification passed",
                        attempt > 0 ? `(attempt ${attempt + 1})` : "")
                    return
                }

                log.warn("[TranslatorAgent]", "Sample language mismatch:",
                    detectedLanguage, "!=", this.targetLanguage, "| attempt:", attempt + 1)

                const corrective = await this._generateCorrectiveInstruction(sampleOutput, detectedLanguage)
                this.delegate.systemInstruction = `${this.delegate.systemInstruction}\n---\n${corrective}`
            } catch (error) {
                log.warn("[TranslatorAgent]", "Sample verification error:", error?.message, "| attempt:", attempt + 1)
            }
        }

        log.warn("[TranslatorAgent]", "Language verification exhausted - proceeding with corrective instructions")
    }

    /**
     * Runs planning then translates SRT entries via the delegate.
     * Entry point for timestamp-based delegates.
     *
     * @param {TimestampEntry[]} entries
     */
    async * translateSrtLines(entries) {
        log.debug("[TranslatorAgent]", "Starting agentic multi-pass translation,",
            entries.length, "total entries")

        const { instruction } = await this._runPlanning(entries)

        // Apply accumulated instruction to delegate
        this.delegate.systemInstruction = instruction

        if (instruction !== this.systemInstruction) {
            log.debug("[TranslatorAgent]", `System instruction updated:\n${instruction}`)
        }

        // Verify output language with a small sample before starting full translation
        const srtSample = entries.slice(0, Math.min(VERIFY_SAMPLE_SIZE, entries.length))
        await this._verifyLanguageWithSample(srtSample.map(e => e.text))

        // Pass 2: delegate handles batching
        log.debug("[TranslatorAgent]", "Pass 2 (Translation): delegating to translateSrtLines")
        const delegate = /** @type {TranslatorStructuredTimestamp} */ (this.delegate)
        yield* delegate.translateSrtLines(entries)
    }

    /**
     * Runs planning then translates lines via the delegate.
     * Entry point for array-based delegates.
     *
     * @param {string[]} lines
     */
    async * translateLines(lines) {
        log.debug("[TranslatorAgent]", "Starting agentic multi-pass translation (array mode),",
            lines.length, "total lines")

        // Convert lines to TimestampEntry for planning (synthesize dummy timestamps)
        const toTimestamp = (s) => {
            const h = Math.floor(s / 3600)
            const m = Math.floor((s % 3600) / 60)
            const sec = s % 60
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},000`
        }
        const entries = lines.map((text, i) => ({
            start: toTimestamp(i),
            end: toTimestamp(i + 1),
            text
        }))

        const { instruction } = await this._runPlanning(entries)

        // Apply accumulated instruction to delegate
        this.delegate.systemInstruction = instruction

        if (instruction !== this.systemInstruction) {
            log.debug("[TranslatorAgent]", `System instruction updated:\n${instruction}`)
        }

        // Verify output language with a small sample before starting full translation
        const lineSample = lines.slice(0, Math.min(VERIFY_SAMPLE_SIZE, lines.length))
        await this._verifyLanguageWithSample(lineSample)

        // Pass 2: delegate handles batching
        log.debug("[TranslatorAgent]", "Pass 2 (Translation): delegating to translateLines")
        const delegate = /** @type {Translator} */ (this.delegate)
        yield* delegate.translateLines(lines)
    }

    /**
     * Common planning logic for both SRT and array modes.
     *
     * @param {TimestampEntry[]} entries - TimestampEntry entries (real or synthesized)
     * @returns {Promise<{ instruction: string }>}
     */
    async _runPlanning(entries) {
        this._planningLastCallTime = Date.now()

        // Build subtitle metadata
        const fileParts = []
        if (this.options.inputFile) fileParts.push(`File: ${this.options.inputFile}`)
        fileParts.push(`Total entries: ${entries.length}`)
        if (entries.length > 0) fileParts.push(`Duration: ${entries[0].start} -> ${entries.at(-1).end}`)
        const subtitleMeta = fileParts.join(" | ")

        // Capture base instruction before planning
        const baseInstruction = this.systemInstruction

        // Pass 0: Overview
        const overviewResult = await this._runOverviewPass(entries, subtitleMeta)

        // Pass 1: Planning
        const { finalInstruction } = await this.runPlanningPass(entries, overviewResult, subtitleMeta)

        const instruction = finalInstruction || baseInstruction

        this.printUsage()
        return { instruction }
    }

}
