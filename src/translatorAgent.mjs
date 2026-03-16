import path from "path"
import { z } from "zod"
import log from "loglevel"
import { countTokens } from "gpt-tokenizer"
import { encode as encodeToon } from "@toon-format/toon"
import { TranslatorStructuredBase } from "./translatorStructuredBase.mjs"
import { TranslatorStructuredTimestamp, toMsEntry } from "./translatorStructuredTimestamp.mjs"
import { TranslatorStructuredArray } from "./translatorStructuredArray.mjs"
import { Translator } from "./translator.mjs"

const scanBatchSchema = z.object({
    batchSummary: z.string().describe("Translation notes for this scan window.")
})

const consolidateSchema = z.object({
    consolidatedBatchSummary: z.string().describe("Condensed synthesis of the provided batch summaries.")
})

const finalInstructionSchema = z.object({
    finalInstruction: z.string().describe("Final translation system instruction for this subtitle file.")
})


const overviewSchema = z.object({
    overview: z.string().describe("Brief content overview of the subtitle file.")
})

const agentInstructionSchema = z.object({
    agentInstruction: z.string().describe("Enhanced self-instruction for scanning and translating this subtitle file.")
})

/**
 * @typedef {import('./translatorStructuredTimestamp.mjs').TimestampEntry} TimestampEntry
 * @typedef {{ start: number, end: number }} SliceRange
 * @typedef {{ accumulatedBatchSummary: string, customSlices: SliceRange[] }} PlanningResult
 */

/** @param {number} useFullContext @returns {number} */
const agentInstructionTokenBudget = (useFullContext) => Math.floor(useFullContext / 2)

/**
 * @typedef {Object} ModeAdapter
 * @property {() => void} buildContext - Build prompt context from translation history
 * @property {(output: import('./translatorOutput.mjs').TranslationOutput) => any[]} extractOutputs - Extract output entries from TranslationOutput
 * @property {(batch: any[], outputs: any[], output: import('./translatorOutput.mjs').TranslationOutput) => boolean} isMismatch - Check if batch output is a mismatch
 * @property {(batch: any[], outputs: any[], completionTokens: number) => void} recordBatch - Record completed batch to delegate history
 * @property {(batch: any[]) => AsyncGenerator} singleFallback - Single-entry fallback translation
 * @property {(batch: any[], outputs: any[], completionTokens: number) => Generator} yieldResults - Yield translation results
 */

/**
 * Creates a mode adapter for TranslatorStructuredTimestamp delegates.
 * @param {TranslatorAgent} agent
 * @param {TranslatorStructuredTimestamp} delegate
 * @returns {ModeAdapter}
 */
function createTimestampAdapter(agent, delegate) {
    return {
        buildContext() {
            if (agent._agentContextChunks.length === 0) return

            const { includedChunks, tokenCount } = delegate.selectContextChunks(
                agent._agentContextChunks,
                ({ userContent, assistantContent }) => countTokens(userContent) + countTokens(assistantContent)
            )

            if (delegate.options.useFullContext > 0) {
                const totalEntries = agent._agentContextChunks.reduce((s, c) => s + c.size, 0)
                const includedEntries = includedChunks.reduce((s, c) => s + c.size, 0)
                const logMsg = includedEntries < totalEntries
                    ? `sliced ${totalEntries - includedEntries} entries (${includedEntries}/${totalEntries} kept, ${tokenCount} tokens)`
                    : `all (${includedEntries} entries, ${tokenCount} tokens)`
                log.debug("[TranslatorAgent]", "Context:", logMsg)
            }

            delegate.promptContext = /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */ (
                includedChunks.flatMap(({ userContent, assistantContent }) => [
                    { role: "user", content: userContent },
                    { role: "assistant", content: assistantContent }
                ])
            )
        },

        extractOutputs(output) {
            const parsed = /** @type {import('./translatorStructuredTimestamp.mjs').BatchTimestampOutput} */
                (/** @type {unknown} */ (output.content ?? {}))
            return parsed.outputs ?? []
        },

        isMismatch(batch, outputs, output) {
            const parsed = /** @type {import('./translatorStructuredTimestamp.mjs').BatchTimestampOutput} */
                (/** @type {unknown} */ (output.content ?? {}))
            return delegate.evaluateBatchOutput(batch, outputs, parsed.remarksIfContainedMergers ?? "")
        },

        recordBatch(batch, outputs, completionTokens) {
            const completionTokensPerEntry = completionTokens / batch.length
            for (const input of batch) {
                const exactMatch = outputs.find(o => o.start <= input.start && o.end >= input.end)
                if (!exactMatch) {
                    log.warn("[TranslatorAgent]",
                        "No output entry covers input", input.start, "-", input.end,
                        `"${input.text}" - using last output as fallback`)
                }
                const matchedOutput = exactMatch ?? outputs.at(-1)
                delegate.entryHistory.push({ input, output: matchedOutput, completionTokens: completionTokensPerEntry })
            }

            // Record agent context chunk for dynamic context building
            const userContent = encodeToon({ inputs: batch.map(toMsEntry) })
            const assistantContent = JSON.stringify({ outputs: outputs.map(toMsEntry) })
            agent._agentContextChunks.push({ userContent, assistantContent, size: batch.length })
        },

        async * singleFallback(batch) {
            log.debug("[TranslatorAgent]", "Single entry mode (timestamp)")
            for (const entry of batch) {
                this.buildContext()
                const output = await delegate.translatePrompt([entry])
                /** @type {TimestampEntry[]} */
                const outputEntries = /** @type {any} */ (output.content)?.outputs ?? []
                const resultEntry = outputEntries?.[0] ?? entry

                if (!outputEntries?.[0]) {
                    log.warn("[TranslatorAgent]", "Empty output for single entry, using original:", entry.text)
                }

                // Record to both delegate history and agent context chunks
                const userContent = encodeToon({ inputs: [entry].map(toMsEntry) })
                const assistantContent = JSON.stringify({ outputs: [resultEntry].map(toMsEntry) })
                agent._agentContextChunks.push({ userContent, assistantContent, size: 1 })
                delegate.entryHistory.push({ input: entry, output: resultEntry, completionTokens: output.completionTokens })

                yield resultEntry
            }
        },

        * yieldResults(batch, outputs, completionTokens) {
            yield* outputs
        }
    }
}

/**
 * Creates a mode adapter for array-based delegates (TranslatorStructuredArray or Translator).
 * @param {TranslatorAgent} agent
 * @param {Translator} delegate
 * @returns {ModeAdapter}
 */
function createArrayAdapter(agent, delegate) {
    return {
        buildContext() {
            delegate.buildContext()
        },

        extractOutputs(output) {
            return output.content ?? []
        },

        isMismatch(batch, outputs, output) {
            return delegate.evaluateBatchOutput(batch, outputs)
        },

        recordBatch(batch, outputs, completionTokens) {
            const completionTokensPerEntry = completionTokens / outputs.length
            for (let i = 0; i < batch.length; i++) {
                delegate.workingProgress.push({
                    source: batch[i],
                    transform: outputs[i] ?? "",
                    completionTokens: completionTokensPerEntry
                })
            }
        },

        async * singleFallback(batch) {
            yield* delegate.translateSingle(batch)
        },

        * yieldResults(batch, outputs, completionTokens) {
            yield* delegate.yieldOutput(batch, outputs, completionTokens / outputs.length)
        }
    }
}

/**
 * Agentic 2-pass translator using composition.
 *
 * Pass 0 (Overview): Samples first/last entries for content overview and scan guidance.
 * Pass 1 (Planning): Scans all entries in fixed max-batch-size windows, accumulating
 * batch summaries. After scanning, summaries are consolidated and optionally refined
 * into a final instruction. Custom batch slice boundaries are committed per window.
 * Pass 2 (Translation): Uses the accumulated instruction and custom slices,
 * delegating translation to the inner translator via the mode adapter.
 *
 * @extends {TranslatorStructuredBase}
 */
export class TranslatorAgent extends TranslatorStructuredBase {

    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} options
     * @param {TranslatorStructuredTimestamp | Translator} delegate - inner translator instance
     */
    constructor(language, services, options, delegate) {
        super(language, services, options)

        /** @type {TranslatorStructuredTimestamp | Translator} */
        this.delegate = delegate

        /**
         * Pre-serialized context chunks recorded per completed translation batch.
         * Used by the timestamp adapter for dynamic context building.
         * @type {{ userContent: string, assistantContent: string, size: number }[]}
         */
        this._agentContextChunks = []
        this.planningPromptTokens = 0
        this.planningCompletionTokens = 0

        /** @type {ModeAdapter} */
        this._adapter = this._createAdapter()
    }

    /**
     * @returns {ModeAdapter}
     */
    _createAdapter() {
        if (this.delegate instanceof TranslatorStructuredTimestamp) {
            return createTimestampAdapter(this, this.delegate)
        }
        if (this.delegate instanceof TranslatorStructuredArray || this.delegate instanceof Translator) {
            return createArrayAdapter(this, /** @type {Translator} */ (this.delegate))
        }
        throw new Error(`[TranslatorAgent] Unsupported delegate type: ${/** @type {any} */ (this.delegate).constructor.name}`)
    }

    /**
     * Accumulates token usage from a planning-pass streamParse response.
     * @param {import('openai').OpenAI.Chat.ChatCompletion} completion
     */
    _accumulatePlanningUsage(completion) {
        this.planningPromptTokens += completion?.usage?.prompt_tokens ?? 0
        this.planningCompletionTokens += completion?.usage?.completion_tokens ?? 0
    }

    get usage() {
        const base = this.delegate.usage
        const planningPromptTokens = this.planningPromptTokens
        const planningCompletionTokens = this.planningCompletionTokens
        return {
            ...base,
            planningPromptTokens,
            planningCompletionTokens,
        }
    }

    async printUsage() {
        await this.delegate.printUsage()
        if (this.planningPromptTokens > 0 || this.planningCompletionTokens > 0) {
            log.debug(
                `[TranslatorAgent] Planning tokens:`,
                this.planningPromptTokens, "+", this.planningCompletionTokens, "=",
                this.planningPromptTokens + this.planningCompletionTokens
            )
        }
    }

    abort() {
        super.abort()
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
     * Step 2: Feeds the overview to the model to generate an enhanced agent instruction.
     *         The model decides whether to incorporate subtitle metadata into the instruction.
     *
     * @param {TimestampEntry[]} entries
     * @param {string} subtitleMeta - subtitle metadata string (file, entry count, duration)
     * @returns {Promise<{ overview: string, agentInstruction: string } | null>}
     */
    async _runOverviewPass(entries, subtitleMeta) {
        const sampleSize = this.options.batchSizes[0]
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
                    `Rules:\n` +
                    `1. Cover: file name/episode identity, total duration, genre, setting, tone, people names, and any notable linguistic features (dialect, slang, technical jargon).\n` +
                    `2. Retain key subtitle metadata (file name, entry count, duration) in the overview.`
            },
            ...this.options.initialPrompts,
            { role: "user", content: userContent }
        ]

        try {
            await this.services.cooler?.cool()
            const output = await this.streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: undefined
            }, { structure: overviewSchema, name: "agent_overview" })

            this._accumulatePlanningUsage(output)
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
                content: `${this.systemInstruction}\n---\n` +
                    `Based on the content overview below, produce an enhanced instruction ` +
                    `for yourself to use when scanning and translating this subtitle file (3-6 sentences of direct translator guidance).\n\n` +
                    `Rules:\n` +
                    `1. Carry forward useful metadata from the overview (file identity, duration, entry count, names, genre/tone).\n` +
                    `2. Specify what to watch for: scene boundaries, speaker changes, contextual dependencies, terminology consistency, tone/register shifts.`
            },
            ...this.options.initialPrompts,
            { role: "user", content: `# Content overview:\n${overview}` }
        ]

        try {
            await this.services.cooler?.cool()
            const output = await this.streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: undefined
            }, { structure: agentInstructionSchema, name: "agent_instruction" })

            this._accumulatePlanningUsage(output)
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
     * Pass 1: scans all entries in fixed windows of scanBatchSize, accumulating batch summaries.
     * Each window is committed as one translation slice.
     *
     * @param {TimestampEntry[]} entries
     * @param {{ overview: string, agentInstruction: string } | null} [overviewResult]
     * @param {string} [subtitleMeta]
     * @returns {Promise<PlanningResult>}
     */
    async runPlanningPass(entries, overviewResult, subtitleMeta) {
        const scanBatchSize = this.options.batchSizes[this.options.batchSizes.length - 1]
        const budget = agentInstructionTokenBudget(this.options.useFullContext)
        const rawSlices = []

        log.debug("[TranslatorAgent]", "Pass 1 (Planning): scanning", entries.length,
            "entries in batches of", scanBatchSize, "| instruction budget:", budget, "tokens")

        let accumulatedBatchSummary = ""

        if (this.options.agentContextSummary) {
            log.debug("[TranslatorAgent]", "Pass 1 skipped: using provided context summary")
            accumulatedBatchSummary = this.options.agentContextSummary
            for (let batchStart = 0; batchStart < entries.length; batchStart += scanBatchSize) {
                rawSlices.push({ start: batchStart, end: Math.min(batchStart + scanBatchSize - 1, entries.length - 1) })
            }
        } else {
            for (let batchStart = 0; batchStart < entries.length; batchStart += scanBatchSize) {
                const batch = entries.slice(batchStart, batchStart + scanBatchSize)
                const batchEnd = batchStart + batch.length - 1

                log.debug("[TranslatorAgent]", "Scanning window", batchStart, "-", batchEnd)

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
                                    accumulatedBatchSummary, newNote, budget
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

                rawSlices.push({ start: batchStart, end: batchEnd })
            }
        }

        const customSlices = this._normalizeSlices(rawSlices, entries.length)

        // Final synthesis: consolidate all batch summaries, then produce refined directive
        let finalInstruction = accumulatedBatchSummary
        if (accumulatedBatchSummary) {
            let consolidatedContextSummary
            if (this.options.agentContextSummary) {
                // Provided summary is already consolidated — skip the consolidation API call
                consolidatedContextSummary = accumulatedBatchSummary
            } else {
                await this.services.cooler?.cool()
                consolidatedContextSummary = await this._consolidateBatchSummaries(accumulatedBatchSummary, undefined, budget)
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
            `(${countTokens(finalInstruction)} tokens)`,
            "| Custom slices:", customSlices.length,
            "| Batch sizes:", customSlices.map(s => s.end - s.start + 1).join(", "))

        return { accumulatedBatchSummary: finalInstruction, customSlices }
    }

    /**
     * Sorts slices by start index, merges overlaps, and ensures full coverage of [0, totalEntries).
     * Any gap not covered by any slice is filled by extending the adjacent slice.
     *
     * @param {SliceRange[]} slices
     * @param {number} totalEntries
     * @returns {SliceRange[]}
     */
    _normalizeSlices(slices, totalEntries) {
        if (slices.length === 0) return []

        // Sort by start
        const sorted = [...slices].sort((a, b) => a.start - b.start)

        // Merge overlaps
        const merged = [sorted[0]]
        for (let i = 1; i < sorted.length; i++) {
            const prev = merged.at(-1)
            const cur = sorted[i]
            if (cur.start <= prev.end) {
                // Overlapping - extend to cover both
                if (cur.end > prev.end) {
                    prev.end = cur.end
                    log.debug("[TranslatorAgent]", "Merged overlapping slices at", cur.start)
                }
            } else if (cur.start > prev.end + 1) {
                // Gap - insert a filler slice to cover the unclaimed entries
                log.debug("[TranslatorAgent]",
                    "Gap between slices", prev.end, "and", cur.start, "- inserting filler slice")
                merged.push({ start: prev.end + 1, end: cur.start - 1 })
                merged.push(cur)
            } else {
                // Adjacent (cur.start === prev.end + 1) - keep as separate slice
                merged.push(cur)
            }
        }

        // Ensure first slice starts at 0
        if (merged[0].start > 0) {
            log.debug("[TranslatorAgent]",
                "Extending first slice to cover entries 0 -", merged[0].start - 1)
            merged[0].start = 0
        }

        // Ensure last slice covers up to totalEntries - 1
        if (merged.at(-1).end < totalEntries - 1) {
            merged.at(-1).end = totalEntries - 1
            log.debug("[TranslatorAgent]",
                "Extended last slice to cover remaining entries up to", totalEntries - 1)
        }

        return merged
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
        const contextSection = accumulatedBatchSummary
            ? `\n---\nContext from previous segments:\n${accumulatedBatchSummary}\n---\n`
            : "\n---\n"
        const agentSection = agentInstruction
            ? `Scan guidance:\n${agentInstruction}\n\n`
            : ""
        const systemContent = [
            this.systemInstruction,
            contextSection,
            agentSection,
            `You are scanning a context window of entries ${batchStart} to ${batchStart + batch.length - 1} ` +
            `(timestamps ${batch[0].start}–${batch[batch.length - 1].end} ms).\n\n` +
            `Rules for batchSummary:\n` +
            `1. Write in the translated language.\n` +
            `2. Open with your overall impression of this window's content.\n` +
            `3. Write only what is new or notable here - do not repeat or refine prior context.\n` +
            `4. Cover the 5W1H: who (names, roles, relationships), what (events, terms, objects), ` +
            `where (locations, settings), when (time context), why/how (tone, register, dialect, intent).`
        ].join("")

        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        const userMessage = { role: "user", content: encodeToon({ inputs: batch.map(toMsEntry) }) }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const messages = [
            { role: "system", content: systemContent },
            ...this.options.initialPrompts,
            userMessage
        ]

        const output = await this.streamParse({
            messages,
            ...this.options.createChatCompletionRequest,
            stream: this.options.createChatCompletionRequest.stream,
            max_tokens: undefined
        }, {
            structure: scanBatchSchema,
            name: "agent_scan"
        })

        this._accumulatePlanningUsage(output)
        const message = output.choices[0]?.message
        if (!message || message.refusal) {
            log.warn("[TranslatorAgent]", "Scan batch refusal or empty response at position", batchStart)
            return null
        }

        return message.parsed
    }

    /**
     * Calls the model to consolidate an over-budget accumulator with a new note.
     * Falls back to simple truncation if the model call fails.
     *
     * @param {string} existing - current accumulated batch summaries
     * @param {string} newNote - newly observed batch summary to merge in (optional)
     * @param {number} budget - token budget; also used as max_tokens for the model call
     * @returns {Promise<string>}
     */
    async _consolidateBatchSummaries(existing, newNote = "", budget, budgetFactor = 0.5) {
        const isFinal = !newNote
        const targetTokens = Math.floor(budget * budgetFactor)
        const messages = /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */ ([
            {
                role: "system",
                content: (isFinal
                    ? `You are doing a final consolidation of all batch summaries for a subtitle file ` +
                      `into a single complete set of notes (target: ~${targetTokens} tokens). ` +
                      `This will be used as the full context for the subtitles - preserve all details.`
                    : `You are doing consolidation of all given batch summary windows for a subtitle file ` +
                      `into a single condensed set of notes (target: ~${targetTokens} tokens). ` +
                      `More batches will follow - stay concise but keep all unique facts.`) +
                    `\n\nRules:\n` +
                    `1. Write in the translated language.\n` +
                    `2. Open with your overall impression of the content so far.\n` +
                    `3. Preserve all unique 5W1H facts (who, what, where, when, why/how - names, locations, terms, tone, dialect).\n` +
                    `4. Remove duplicate or contradictory information. ${isFinal ? "Be thorough - this is the last pass." : "Keep it concise - more content is coming."}`
            },
            {
                role: "user",
                content: `Batch summaries:\n${existing}`
            }
        ])
        try {
            const output = await this.streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: Math.floor(targetTokens * 1.5)
            }, { structure: consolidateSchema, name: "agent_consolidate" })

            this._accumulatePlanningUsage(output)
            const result = output.choices[0]?.message?.parsed?.consolidatedBatchSummary?.trim()
            if (result) return result
        } catch (error) {
            log.warn("[TranslatorAgent]", "Consolidation failed:", error?.message, "- truncating")
        }
        // Fallback: keep as much as fits within budget
        const combined = `${existing}\n${newNote}`
        if (countTokens(combined) <= budget) return combined
        // Over budget - trim from front of existing to make room for newNote
        const existingLines = existing.split("\n")
        for (let drop = 1; drop < existingLines.length; drop++) {
            const trimmed = existingLines.slice(drop).join("\n") + "\n" + newNote
            if (countTokens(trimmed) <= budget) return trimmed
        }
        // Nothing from existing fits - keep only newNote
        return newNote
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
                    `Rules:\n` +
                    `1. Preserve the target language and any stylistic directives that apply to the observed content.\n` +
                    `2. If the base instruction contains a glossary, dictionary, or list of terms/names, ` +
                    `filter it to only entries that appear in or are directly relevant to the observed content. ` +
                    `Remove any entries not encountered in this file.\n` +
                    `3. Remove instructions that are redundant, contradicted, or clearly out of scope given what was observed.\n` +
                    `4. Do not embed narrative facts from the context - keep it as clean translator guidance.\n`
            },
            {
                role: "user",
                content:
                    `# Base instruction:\n${this.systemInstruction}\n\n` +
                    `# Observed content context:\n${contextSummary}`
            }
        ])
        try {
            const output = await this.streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens: budget
            }, { structure: finalInstructionSchema, name: "agent_refine_instruction" })

            this._accumulatePlanningUsage(output)
            const parsed = output.choices[0]?.message?.parsed
            if (parsed?.finalInstruction) return parsed.finalInstruction
        } catch (error) {
            log.warn("[TranslatorAgent]", "Final instruction refinement failed:", error?.message, "- using base instruction")
        }
        return null
    }

    // ────────────────────────────────────────────────────────────────
    //  Pass 2: Translation orchestration
    // ────────────────────────────────────────────────────────────────

    /**
     * Runs planning then translates SRT entries via the delegate.
     * Entry point for timestamp-based delegates.
     *
     * @param {TimestampEntry[]} entries
     */
    async * translateSrtLines(entries) {
        log.debug("[TranslatorAgent]", "Starting agentic 2-pass translation,",
            entries.length, "total entries")

        const { instruction, customSlices } = await this._runPlanning(entries)

        // Apply accumulated instruction to delegate
        this.delegate.systemInstruction = instruction

        if (instruction !== this.systemInstruction) {
            log.debug("[TranslatorAgent]", `System instruction updated:\n${instruction}`)
        }

        // Fall back to delegate's standard behavior if planning produced no slices
        if (customSlices.length === 0) {
            log.warn("[TranslatorAgent]",
                "Pass 1 produced no slices - falling back to delegate translateSrtLines")
            yield* /** @type {TranslatorStructuredTimestamp} */ (/** @type {unknown} */ (this.delegate)).translateSrtLines(entries)
            return
        }

        // Pass 2: Translation with custom slices
        log.debug("[TranslatorAgent]", "Pass 2 (Translation): using",
            customSlices.length, "custom slices")
        yield* this._translateWithCustomSlices(entries, customSlices)
    }

    /**
     * Runs planning then translates lines via the delegate.
     * Entry point for array-based delegates.
     *
     * @param {string[]} lines
     */
    async * translateLines(lines) {
        log.debug("[TranslatorAgent]", "Starting agentic 2-pass translation (array mode),",
            lines.length, "total lines")

        // Convert lines to TimestampEntry for planning (synthesize dummy timestamps)
        const entries = lines.map((text, i) => ({
            start: `00:00:${String(i).padStart(2, '0')},000`,
            end: `00:00:${String(i + 1).padStart(2, '0')},000`,
            text
        }))

        const { instruction, customSlices } = await this._runPlanning(entries)

        // Apply accumulated instruction to delegate
        this.delegate.systemInstruction = instruction

        // Set up delegate state for array mode
        const arrayDelegate = /** @type {Translator} */ (this.delegate)
        arrayDelegate.workingLines = lines

        if (instruction !== this.systemInstruction) {
            log.debug("[TranslatorAgent]", `System instruction updated:\n${instruction}`)
        }

        // Fall back to delegate's standard behavior if planning produced no slices
        if (customSlices.length === 0) {
            log.warn("[TranslatorAgent]",
                "Pass 1 produced no slices - falling back to delegate translateLines")
            yield* arrayDelegate.translateLines(lines)
            return
        }

        // Pass 2: Translation with custom slices
        log.debug("[TranslatorAgent]", "Pass 2 (Translation): using",
            customSlices.length, "custom slices")
        yield* this._translateWithCustomSlices(lines, customSlices)
    }

    /**
     * Common planning logic for both SRT and array modes.
     *
     * @param {TimestampEntry[]} entries - TimestampEntry entries (real or synthesized)
     * @returns {Promise<{ instruction: string, customSlices: SliceRange[] }>}
     */
    async _runPlanning(entries) {
        // Build subtitle metadata
        const fileParts = []
        if (this.options.inputFile) fileParts.push(`File: ${path.basename(this.options.inputFile)}`)
        fileParts.push(`Total entries: ${entries.length}`)
        if (entries.length > 0) fileParts.push(`Duration: ${entries[0].start} -> ${entries.at(-1).end}`)
        const subtitleMeta = fileParts.join(" | ")

        // Capture base instruction before planning
        const baseInstruction = this.systemInstruction

        // Pass 0: Overview
        const overviewResult = await this._runOverviewPass(entries, subtitleMeta)

        // Pass 1: Planning
        const { accumulatedBatchSummary, customSlices } = await this.runPlanningPass(entries, overviewResult, subtitleMeta)

        const instruction = accumulatedBatchSummary || baseInstruction

        return { instruction, customSlices }
    }

    /**
     * Pass 2 loop: iterates over custom slices from Pass 1.
     * Uses the mode adapter to handle delegate-specific operations.
     * On mismatch: steps down through batchSizes to re-split the failed slice, then falls to single-entry.
     *
     * @param {any[]} allEntries - full entries array (TimestampEntry[] or string[])
     * @param {SliceRange[]} customSlices - mutable; split in-place on mismatch
     */
    async * _translateWithCustomSlices(allEntries, customSlices) {
        this.delegate.aborted = false
        let sliceIndex = 0

        while (sliceIndex < customSlices.length) {
            const slice = customSlices[sliceIndex]
            const batch = allEntries.slice(slice.start, slice.end + 1)  // end is inclusive

            if (batch.length === 0) {
                log.warn("[TranslatorAgent]", "Empty batch for slice", slice, "- skipping")
                sliceIndex++
                continue
            }

            this._adapter.buildContext()
            const output = await this.delegate.translatePrompt(/** @type {any} */ (batch))

            if (this.delegate.aborted) {
                log.debug("[TranslatorAgent]", "Aborted")
                return
            }

            const outputs = this._adapter.extractOutputs(output)
            const isMismatch = this._adapter.isMismatch(batch, outputs, output)

            if (isMismatch || (batch.length > 1 && output.refusal)) {
                this.delegate.promptTokensWasted += output.promptTokens
                this.delegate.completionTokensWasted += output.completionTokens

                if (output.refusal) {
                    log.debug("[TranslatorAgent]", "Refusal on slice", slice)
                }

                // Step down to the next smaller batch size from batchSizes option
                const nextSize = [...this.options.batchSizes].reverse().find(s => s < batch.length)
                if (nextSize !== undefined) {
                    // Split the failed slice into sub-slices of nextSize
                    const subSlices = []
                    for (let i = slice.start; i <= slice.end; i += nextSize) {
                        subSlices.push({ start: i, end: Math.min(i + nextSize - 1, slice.end) })
                    }
                    customSlices.splice(sliceIndex, 1, ...subSlices)
                    log.debug("[TranslatorAgent]",
                        "Mismatch on slice", slice, "- re-splitting into", subSlices.length,
                        "sub-slices of size", nextSize)
                    // Do NOT increment sliceIndex; retry with first sub-slice
                } else {
                    // Already at minimum batch size: fall back to entry-by-entry mode
                    yield* this._adapter.singleFallback(batch)
                    sliceIndex++
                }
            } else {
                this._adapter.recordBatch(batch, outputs, output.completionTokens)
                yield* this._adapter.yieldResults(batch, outputs, output.completionTokens)
                sliceIndex++
            }

            this.printUsage()
        }
    }
}
