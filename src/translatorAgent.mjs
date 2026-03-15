import path from "path"
import { z } from "zod"
import log from "loglevel"
import { countTokens } from "gpt-tokenizer"
import { encode as encodeToon } from "@toon-format/toon"
import { TranslatorStructuredTimestamp, toMsEntry } from "./translatorStructuredTimestamp.mjs"

const scanBatchSchema = z.object({
    batchSummary: z.string().describe("Translation notes for this scan window."),
    batchSize: z.int().describe("Number of entries from the start of this window to commit as one translation batch.")
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
 * Agentic 2-pass subtitle translator.
 *
 * Pass 1 (Planning): Scans all entries in max-batch-size chunks. Each chunk produces
 * refined translation instructions and custom batch slice boundaries for that segment.
 * Results are aggregated into a final system instruction and a global slice list.
 *
 * Pass 2 (Translation): Uses the accumulated instruction and custom slices from Pass 1,
 * otherwise delegating all translation logic to TranslatorStructuredTimestamp.
 *
 * @extends {TranslatorStructuredTimestamp}
 */
export class TranslatorAgent extends TranslatorStructuredTimestamp {

    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options) {
        super(language, services, options)
        /**
         * Pre-serialized context chunks recorded per completed translation batch.
         * Each chunk uses the actual batch size from the agent's dynamic slicing,
         * not a fixed re-grouping of entryHistory.
         * @type {{ userContent: string, assistantContent: string, size: number }[]}
         */
        this._agentContextChunks = []
        this.planningPromptTokens = 0
        this.planningCompletionTokens = 0
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
        const base = super.usage
        const planningPromptTokens = this.planningPromptTokens
        const planningCompletionTokens = this.planningCompletionTokens
        return {
            ...base,
            planningPromptTokens,
            planningCompletionTokens,
        }
    }

    async printUsage() {
        await super.printUsage()
        if (this.planningPromptTokens > 0 || this.planningCompletionTokens > 0) {
            log.debug(
                `[TranslatorAgent] Planning tokens:`,
                this.planningPromptTokens, "+", this.planningCompletionTokens, "=",
                this.planningPromptTokens + this.planningCompletionTokens
            )
        }
    }

    /**
     * Records a completed translation batch as a serialized context chunk.
     * Both batch (inputs) and outputEntries are TimestampEntry (string timestamps).
     *
     * @param {import('./translatorStructuredTimestamp.mjs').TimestampEntry[]} batch
     * @param {import('./translatorStructuredTimestamp.mjs').TimestampEntry[]} outputEntries
     */
    _recordContextChunk(batch, outputEntries) {
        const userContent = encodeToon({ inputs: batch.map(toMsEntry) })
        const assistantContent = JSON.stringify({ outputs: outputEntries.map(toMsEntry) })
        this._agentContextChunks.push({ userContent, assistantContent, size: batch.length })
    }

    /**
     * @override
     * Uses _agentContextChunks (actual dynamic batch boundaries) instead of re-grouping
     * entryHistory by a fixed batchSizes[last] chunk size.
     */
    buildTimestampContext() {
        if (this._agentContextChunks.length === 0) return

        const { includedChunks, tokenCount } = this.selectContextChunks(
            this._agentContextChunks,
            ({ userContent, assistantContent }) => countTokens(userContent) + countTokens(assistantContent)
        )

        if (this.options.useFullContext > 0) {
            const totalEntries = this._agentContextChunks.reduce((s, c) => s + c.size, 0)
            const includedEntries = includedChunks.reduce((s, c) => s + c.size, 0)
            const logMsg = includedEntries < totalEntries
                ? `sliced ${totalEntries - includedEntries} entries (${includedEntries}/${totalEntries} kept, ${tokenCount} tokens)`
                : `all (${includedEntries} entries, ${tokenCount} tokens)`
            log.debug("[TranslatorAgent]", "Context:", logMsg)
        }

        this.promptContext = /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */ (
            includedChunks.flatMap(({ userContent, assistantContent }) => [
                { role: "user", content: userContent },
                { role: "assistant", content: assistantContent }
            ])
        )
    }

    /**
     * @override
     * Single-entry fallback: records each entry as a size-1 context chunk.
     *
     * @param {import('./translatorStructuredTimestamp.mjs').TimestampEntry[]} entries
     */
    async * translateSingleSrt(entries) {
        log.debug("[TranslatorAgent]", "Single entry mode")
        for (const entry of entries) {
            this.buildTimestampContext()
            const output = await this.translatePrompt([entry])
            /** @type {import('./translatorStructuredTimestamp.mjs').TimestampEntry[]} */
            const outputEntries = /** @type {any} */ (output.content)?.outputs ?? []
            const resultEntry = outputEntries?.[0] ?? entry

            if (!outputEntries?.[0]) {
                log.warn("[TranslatorAgent]", "Empty output for single entry, using original:", entry.text)
            }

            this._recordContextChunk([entry], [resultEntry])
            this.entryHistory.push({ input: entry, output: resultEntry, completionTokens: output.completionTokens })

            yield resultEntry
        }
    }

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

    /**
     * Pass 1: scans all entries using a sliding window of size scanBatchSize.
     * Each scan call returns a batchSize - the number of entries from the front of the
     * window to commit as one translation slice. The window then advances by batchSize,
     * so the next scan always sees fresh context ahead of the committed entries.
     *
     * After all scan batches are processed, slices are sorted and any overlaps are merged.
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

        // windowStart: the leading edge of the current scan window.
        // Advances by batchSize each iteration - the model commits batchSize entries from
        // the front of the window as one translation slice, then the window slides forward.
        let windowStart = 0

        for (let batchStart = 0; batchStart < entries.length; batchStart = windowStart) {
            const batch = entries.slice(batchStart, batchStart + scanBatchSize)
            const batchEnd = batchStart + batch.length - 1

            log.debug("[TranslatorAgent]", "Scanning window", batchStart, "-", batchEnd)

            await this.services.cooler?.cool()

            /** @type {SliceRange[]} */
            let batchSlices = []
            let scanOk = false

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
                            // Over budget - consolidate before adding new note
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
                    // Commit exactly one slice of batchSize entries from the front of the window.
                    // The window advances by batchSize, so the next scan sees fresh context ahead.
                    const size = Math.max(1, Math.min(result.batchSize ?? batch.length, batch.length))
                    batchSlices = [{ start: batchStart, end: batchStart + size - 1 }]
                    scanOk = true
                } else {
                    log.warn("[TranslatorAgent]",
                        "Scan batch returned null, using default single slice for range",
                        batchStart, "-", batchEnd)
                }
            } catch (error) {
                log.warn("[TranslatorAgent]", "Scan batch error:", error?.message,
                    "- falling back to default slice for range", batchStart, "-", batchEnd)
            }

            if (!scanOk || batchSlices.length === 0) {
                // Fallback: treat entire window as one slice and advance past it
                rawSlices.push({ start: batchStart, end: batchEnd })
                windowStart = batchEnd + 1
            } else {
                const slice = batchSlices[0]
                const sliceSize = slice.end - slice.start + 1
                const minProgress = Math.max(1, Math.floor(scanBatchSize / 2))

                if (sliceSize < minProgress) {
                    // batchSize was too small - force progress to avoid O(n) scan calls
                    log.warn("[TranslatorAgent]",
                        "batchSize", sliceSize, "below minimum progress", minProgress,
                        "- forcing full window coverage")
                    rawSlices.push({ start: batchStart, end: batchEnd })
                    windowStart = batchEnd + 1
                } else {
                    rawSlices.push(slice)
                    windowStart = slice.end + 1
                    log.debug("[TranslatorAgent]",
                        "Committed slice", slice.start, "-", slice.end,
                        "| next window starts at", windowStart)
                }
            }
        }

        const customSlices = this._normalizeSlices(rawSlices, entries.length)

        // Final synthesis: consolidate all batch summaries, then produce refined directive
        let finalInstruction = accumulatedBatchSummary
        if (accumulatedBatchSummary) {
            await this.services.cooler?.cool()
            // Final consolidation: collapse all per-window batch summaries into one contextSummary
            const consolidatedContextSummary = await this._consolidateBatchSummaries(accumulatedBatchSummary, undefined, budget)
            log.debug("[TranslatorAgent]", "Context summary:\n", consolidatedContextSummary)

            await this.services.cooler?.cool()
            const refinedDirective = await this._refineFinalInstruction(consolidatedContextSummary, budget)
            log.debug("[TranslatorAgent]", "Refined instruction:\n", refinedDirective)

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
     * @returns {Promise<{batchSummary: string, batchSize: number} | null>}
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
            `1. Open with your overall impression of this window's content.\n` +
            `2. Write only what is new or notable here - do not repeat or refine prior context.\n` +
            `3. Cover the 5W1H: who (names, roles, relationships), what (events, terms, objects), ` +
            `where (locations, settings), when (time context), why/how (tone, register, dialect, intent).\n\n` +
            `Rules for batchSize:\n` +
            `1. Decide how many entries from the start of this window (position ${batchStart}) ` +
            `to commit as one translation batch - this sets where the next scan window begins.\n` +
            `2. Must be between 1 and ${batch.length} (the current window size).\n` +
            `3. Use the full window size if entries flow naturally together, ` +
            `or a smaller number to break at a scene or topic boundary.`
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

        const parsed = message.parsed
        if (parsed?.batchSize != null) {
            parsed.batchSize = Math.max(1, Math.min(parsed.batchSize, batch.length))
        }
        return parsed
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
                      `This will be used as the full context for a translator - preserve all details.`
                    : `You are doing a mid-pass consolidation of batch summaries for a subtitle file ` +
                      `into a single condensed set of notes (target: ~${targetTokens} tokens). ` +
                      `More batches will follow - stay concise but keep all unique facts.`) +
                    `\n\nRules:\n` +
                    `1. Open with your overall impression of the content so far.\n` +
                    `2. Preserve all unique 5W1H facts (who, what, where, when, why/how - names, locations, terms, tone, dialect).\n` +
                    `3. Remove duplicate or contradictory information. ${isFinal ? "Be thorough - this is the last pass." : "Keep it concise - more content is coming."}`
            },
            {
                role: "user",
                content: isFinal
                    ? `# Batch summaries:\n${existing}`
                    : `# Existing batch summaries:\n${existing}\n\n# New batch summary:\n${newNote}`
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

    /**
     * @override
     * Orchestrates Pass 1 (planning) then Pass 2 (translation).
     *
     * @param {TimestampEntry[]} entries
     */
    async * translateSrtLines(entries) {
        log.debug("[TranslatorAgent]", "Starting agentic 2-pass translation,",
            entries.length, "total entries")

        // Build subtitle metadata - only passed to the overview call, not baked into systemInstruction.
        // The model decides what metadata flows through to agent instruction and final instruction.
        const fileParts = []
        if (this.options.inputFile) fileParts.push(`File: ${path.basename(this.options.inputFile)}`)
        fileParts.push(`Total entries: ${entries.length}`)
        if (entries.length > 0) fileParts.push(`Duration: ${entries[0].start} -> ${entries.at(-1).end}`)
        const subtitleMeta = fileParts.join(" | ")

        // Capture base instruction before planning (preserves any --system-instruction override)
        const baseInstruction = this.systemInstruction

        // Pass 0: Overview - sample first/last entries for content overview and scan guidance
        const overviewResult = await this._runOverviewPass(entries, subtitleMeta)

        // Pass 1: Planning
        const { accumulatedBatchSummary, customSlices } = await this.runPlanningPass(entries, overviewResult, subtitleMeta)

        // Apply accumulated instruction: use as full replacement, or fall back to base
        this.systemInstruction = accumulatedBatchSummary || baseInstruction

        if (accumulatedBatchSummary) {
            log.debug("[TranslatorAgent]", "System instruction updated:\n", this.systemInstruction)
        }

        // Fall back to standard behavior if planning produced no slices
        if (customSlices.length === 0) {
            log.warn("[TranslatorAgent]",
                "Pass 1 produced no slices - falling back to standard translateSrtLines")
            yield* super.translateSrtLines(entries)
            return
        }

        // Pass 2: Translation with custom slices
        log.debug("[TranslatorAgent]", "Pass 2 (Translation): using",
            customSlices.length, "custom slices")
        yield* this._translateWithCustomSlices(entries, customSlices)
    }

    /**
     * Pass 2 loop: iterates over custom slices from Pass 1 instead of fixed batchSize steps.
     * Mirrors the retry/fallback logic from TranslatorStructuredTimestamp.translateSrtLines,
     * with slice-halving on mismatch instead of global batch size decrease.
     *
     * @param {TimestampEntry[]} entries
     * @param {SliceRange[]} customSlices - mutable; halved in-place on mismatch
     */
    async * _translateWithCustomSlices(entries, customSlices) {
        this.aborted = false
        let sliceIndex = 0

        while (sliceIndex < customSlices.length) {
            const slice = customSlices[sliceIndex]
            const batch = entries.slice(slice.start, slice.end + 1)  // end is inclusive

            if (batch.length === 0) {
                log.warn("[TranslatorAgent]", "Empty batch for slice", slice, "- skipping")
                sliceIndex++
                continue
            }

            this.buildTimestampContext()
            const output = await this.translatePrompt(batch)

            if (this.aborted) {
                log.debug("[TranslatorAgent]", "Aborted")
                return
            }

            const parsed = /** @type {import('./translatorStructuredTimestamp.mjs').BatchTimestampOutput} */
                (/** @type {unknown} */ (output.content ?? {}))
            const outputEntries = parsed.outputs ?? []

            const isMismatch = this.evaluateBatchOutput(batch, outputEntries, parsed.remarksIfContainedMergers ?? "")

            if (isMismatch || (batch.length > 1 && output.refusal)) {
                this.promptTokensWasted += output.promptTokens
                this.completionTokensWasted += output.completionTokens

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
                    yield* this.translateSingleSrt(batch)
                    sliceIndex++
                }
            } else {
                const completionTokensPerEntry = output.completionTokens / batch.length
                for (const input of batch) {
                    const exactMatch = outputEntries.find(o => o.start <= input.start && o.end >= input.end)
                    if (!exactMatch) {
                        log.warn("[TranslatorAgent]",
                            "No output entry covers input", input.start, "-", input.end,
                            `"${input.text}" - using last output as fallback`)
                    }
                    const matchedOutput = exactMatch ?? outputEntries.at(-1)
                    this.entryHistory.push({ input, output: matchedOutput, completionTokens: completionTokensPerEntry })
                }

                this._recordContextChunk(batch, outputEntries)
                yield* outputEntries
                sliceIndex++
            }

            this.printUsage()
        }
    }
}
