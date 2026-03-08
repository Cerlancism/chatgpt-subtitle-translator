import { z } from "zod"
import log from "loglevel"
import { countTokens } from "gpt-tokenizer"
import { encode as encodeToon } from "@toon-format/toon"
import { TranslatorStructuredTimestamp, toMsEntry } from "./translatorStructuredTimestamp.mjs"

const scanBatchSchema = z.object({
    refinedInstruction: z.string().describe(
        "Refined translation instructions observed from this subtitle segment. " +
        "Add character names, genre/tone, recurring terms, or dialect notes. " +
        "Leave empty string if nothing notable."
    ),
    slices: z.array(
        z.object({
            start: z.int().describe("Inclusive start index within this scan batch (0-based)"),
            end: z.int().describe("Inclusive end index within this scan batch (0-based)")
        })
    ).describe(
        "Suggested translation batch boundaries as index ranges within this scan batch, " +
        "grouping entries that belong together thematically or structurally. " +
        "You may omit trailing entries that lack enough context to form a complete batch — " +
        "they will be deferred to the next scan batch automatically. " +
        "Slices must not overlap."
    )
})

const consolidateSchema = z.object({
    consolidatedInstruction: z.string().describe(
        "A condensed, non-redundant synthesis of the provided translation notes. " +
        "Preserve all unique facts (character names, tone, terminology, dialect). " +
        "Remove duplicate or contradictory information. Keep it concise."
    )
})

const finalInstructionSchema = z.object({
    systemInstructionAddendum: z.string().describe(
        "A concise addendum to append to the base translation system instruction. " +
        "Written as direct translator guidance. Cover: confirmed character names, " +
        "genre/tone, recurring terms, dialect or register notes. " +
        "Do not repeat the base instruction. Leave empty string if nothing was observed."
    )
})

/**
 * @typedef {import('./translatorStructuredTimestamp.mjs').TimestampEntry} TimestampEntry
 * @typedef {{ start: number, end: number }} SliceRange
 * @typedef {{ accumulatedInstruction: string, customSlices: SliceRange[] }} PlanningResult
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
     * Pass 1: scans all entries in max-batch-size chunks to collect refined instructions
     * and custom slice boundaries.
     *
     * The model may omit trailing entries from a scan batch when it lacks enough context
     * to commit to a boundary — those uncovered entries are prepended to the next scan batch
     * so the model sees them with more surrounding context.
     *
     * After all scan batches are processed, slices are sorted and any overlaps are merged.
     *
     * @param {TimestampEntry[]} entries
     * @returns {Promise<PlanningResult>}
     */
    async runPlanningPass(entries) {
        const scanBatchSize = this.options.batchSizes[this.options.batchSizes.length - 1]
        const budget = agentInstructionTokenBudget(this.options.useFullContext)
        const rawSlices = []

        log.debug("[TranslatorAgent]", "Pass 1 (Planning): scanning", entries.length,
            "entries in batches of", scanBatchSize, "| instruction budget:", budget, "tokens")

        // Running accumulator for refined instructions across scan batches.
        // Consolidated in-place whenever it exceeds the character budget.
        let accumulatedInstruction = ""

        // deferredStart: absolute index of the first entry not yet covered by any slice.
        // When the model omits trailing entries, those entries are used as the start of
        // the next scan batch so the model sees them again with more surrounding context.
        let deferredStart = 0

        for (let batchStart = 0; batchStart < entries.length; batchStart = deferredStart) {
            const batch = entries.slice(batchStart, batchStart + scanBatchSize)
            const batchEnd = batchStart + batch.length - 1

            log.debug("[TranslatorAgent]", "Scanning batch", batchStart, "-", batchEnd)

            await this.services.cooler?.cool()

            /** @type {SliceRange[]} */
            let batchSlices = []
            let scanOk = false

            try {
                const result = await this._runScanBatch(batch, batchStart, accumulatedInstruction)
                if (result) {
                    const newNote = result.refinedInstruction?.trim()
                    if (newNote) {
                        log.debug("[TranslatorAgent]", "Refined instruction from batch", batchStart, ":\n", newNote)
                        const candidate = accumulatedInstruction
                            ? `${accumulatedInstruction}\n${newNote}`
                            : newNote

                        if (countTokens(candidate) > budget) {
                            // Over budget — consolidate before adding new note
                            log.debug("[TranslatorAgent]",
                                "Instruction accumulator over budget (>", budget, "tokens) — consolidating")
                            await this.services.cooler?.cool()
                            accumulatedInstruction = await this._consolidateInstruction(
                                accumulatedInstruction, newNote, budget
                            )
                            log.debug("[TranslatorAgent]",
                                "Consolidated instruction length:", accumulatedInstruction.length)
                        } else {
                            accumulatedInstruction = candidate
                        }
                    }
                    batchSlices = (result.slices ?? []).map(s => ({
                        start: batchStart + s.start,
                        end: batchStart + s.end
                    }))
                    scanOk = true
                } else {
                    log.warn("[TranslatorAgent]",
                        "Scan batch returned null, using default single slice for range",
                        batchStart, "-", batchEnd)
                }
            } catch (error) {
                log.warn("[TranslatorAgent]", "Scan batch error:", error?.message,
                    "— falling back to default slice for range", batchStart, "-", batchEnd)
            }

            if (!scanOk || batchSlices.length === 0) {
                // Fallback: treat entire batch as one slice
                rawSlices.push({ start: batchStart, end: batchEnd })
                deferredStart = batchEnd + 1
            } else {
                rawSlices.push(...batchSlices)
                const coveredEnd = batchSlices.at(-1).end

                if (coveredEnd < batchEnd) {
                    // Model intentionally omitted trailing entries — defer them
                    deferredStart = coveredEnd + 1
                    log.debug("[TranslatorAgent]",
                        "Deferring entries", deferredStart, "-", batchEnd,
                        "to next scan batch")
                } else {
                    deferredStart = batchEnd + 1
                }
            }
        }

        const customSlices = this._normalizeSlices(rawSlices, entries.length)

        // Final synthesis: turn accumulated notes into a polished system instruction addendum
        if (accumulatedInstruction) {
            await this.services.cooler?.cool()
            accumulatedInstruction = await this._synthesizeFinalInstruction(accumulatedInstruction, budget)
        }

        log.debug("[TranslatorAgent]", "Pass 1 complete.",
            "Final instruction length:", accumulatedInstruction.length,
            "| Custom slices:", customSlices.length)

        return { accumulatedInstruction, customSlices }
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
            if (cur.start <= prev.end + 1) {
                // Overlapping or adjacent — extend
                if (cur.end > prev.end) {
                    prev.end = cur.end
                    log.debug("[TranslatorAgent]", "Merged overlapping slices at", cur.start)
                }
            } else {
                // Gap detected — fill by extending the previous slice to cover the gap
                log.debug("[TranslatorAgent]",
                    "Gap between slices", prev.end, "and", cur.start, "— extending previous slice")
                prev.end = cur.start - 1
                merged.push(cur)
            }
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
     * @param {string} accumulatedInstruction - running context from previous scan batches
     * @returns {Promise<{refinedInstruction: string, slices: SliceRange[]} | null>}
     */
    async _runScanBatch(batch, batchStart, accumulatedInstruction) {
        const contextSection = accumulatedInstruction
            ? `\n---\nContext from previous segments:\n${accumulatedInstruction}\n---\n`
            : "\n---\n"
        const systemContent = [
            this.systemInstruction,
            contextSection,
            `Analyze subtitle entries at positions ${batchStart} to ${batchStart + batch.length - 1}.`,
            `Provide refined translation instructions based on what you observe,`,
            `and suggest grouping boundaries (as index ranges within this batch) for the translation pass.`
        ].join(" ")

        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        const userMessage = { role: "user", content: encodeToon({ inputs: batch.map(toMsEntry) }) }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const messages = [
            { role: "system", content: systemContent },
            ...this.options.initialPrompts,
            userMessage
        ]

        // stream: false overrides any CLI --stream flag; scan results are binary (whole object or nothing)
        const output = await this.streamParse({
            messages,
            ...this.options.createChatCompletionRequest,
            stream: false,
            max_tokens: undefined
        }, {
            structure: scanBatchSchema,
            name: "agent_scan"
        })

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
     * @param {string} existing - current accumulated instruction
     * @param {string} newNote - newly observed instruction fragment to merge in
     * @param {number} budget - token budget; also used as max_tokens for the model call
     * @returns {Promise<string>}
     */
    async _consolidateInstruction(existing, newNote, budget) {
        const messages = /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */ ([
            {
                role: "system",
                content: `${this.systemInstruction}\n---\nYou are consolidating translation notes for a subtitle file.`
            },
            {
                role: "user",
                content: `Existing notes:\n${existing}\n\nNew observation:\n${newNote}`
            }
        ])
        try {
            const output = await this.streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: false,
                max_tokens: budget
            }, { structure: consolidateSchema, name: "agent_consolidate" })

            const result = output.choices[0]?.message?.parsed?.consolidatedInstruction?.trim()
            if (result) return result
        } catch (error) {
            log.warn("[TranslatorAgent]", "Consolidation failed:", error?.message, "— truncating")
        }
        // Fallback: keep as much as fits within budget (drop from front of existing)
        const combined = `${existing}\n${newNote}`
        if (countTokens(combined) <= budget) return combined
        // Drop existing, keep only newNote (guaranteed to be smaller than a full scan batch)
        return newNote
    }

    /**
     * Calls the model to synthesize the final accumulated notes into a polished
     * system instruction addendum. Falls back to the raw accumulator on failure.
     *
     * @param {string} accumulated - full accumulated instruction notes
     * @param {number} budget - token budget; also used as max_tokens for the model call
     * @returns {Promise<string>}
     */
    async _synthesizeFinalInstruction(accumulated, budget) {
        const messages = /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */ ([
            {
                role: "system",
                content: `${this.systemInstruction}\n---\nYou are finalizing translation guidance for a subtitle file based on observed notes.`
            },
            {
                role: "user",
                content: `Accumulated notes from scanning the full subtitle file:\n${accumulated}`
            }
        ])
        try {
            const output = await this.streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: false,
                max_tokens: budget
            }, { structure: finalInstructionSchema, name: "agent_finalize" })

            const result = output.choices[0]?.message?.parsed?.systemInstructionAddendum?.trim()
            if (result) return result
        } catch (error) {
            log.warn("[TranslatorAgent]", "Final synthesis failed:", error?.message, "— using raw accumulation")
        }
        return accumulated
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

        // Capture base instruction before planning (preserves any --system-instruction override)
        const baseInstruction = this.systemInstruction

        // Pass 1: Planning
        const { accumulatedInstruction, customSlices } = await this.runPlanningPass(entries)

        // Apply accumulated instruction
        this.systemInstruction = accumulatedInstruction
            ? `${baseInstruction}\n${accumulatedInstruction}`
            : baseInstruction

        if (accumulatedInstruction) {
            log.debug("[TranslatorAgent]", "System instruction updated:\n", this.systemInstruction)
        }

        // Fall back to standard behavior if planning produced no slices
        if (customSlices.length === 0) {
            log.warn("[TranslatorAgent]",
                "Pass 1 produced no slices — falling back to standard translateSrtLines")
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
                log.warn("[TranslatorAgent]", "Empty batch for slice", slice, "— skipping")
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

            const isMismatch = this.evaluateBatchOutput(batch, outputEntries, parsed.mergedRemarks ?? "")

            if (isMismatch || (batch.length > 1 && output.refusal)) {
                this.promptTokensWasted += output.promptTokens
                this.completionTokensWasted += output.completionTokens

                if (output.refusal) {
                    log.debug("[TranslatorAgent]", "Refusal on slice", slice)
                }

                if (batch.length > 1) {
                    // Halve the slice and retry — avoids mutating global currentBatchSize
                    const mid = slice.start + Math.floor(batch.length / 2) - 1
                    const leftSlice = { start: slice.start, end: mid }
                    const rightSlice = { start: mid + 1, end: slice.end }
                    customSlices.splice(sliceIndex, 1, leftSlice, rightSlice)
                    log.debug("[TranslatorAgent]",
                        "Mismatch on slice", slice, "— splitting into", leftSlice, "and", rightSlice)
                    // Do NOT increment sliceIndex; retry with leftSlice next iteration
                } else {
                    // Single entry: fall back to entry-by-entry mode
                    yield* this.translateSingleSrt(batch)
                    sliceIndex++
                }
            } else {
                const completionTokensPerEntry = output.completionTokens / batch.length
                for (const input of batch) {
                    const matchedOutput = outputEntries.find(o => o.start <= input.start && o.end >= input.end)
                        ?? outputEntries.at(-1)
                    this.entryHistory.push({ input, output: matchedOutput, completionTokens: completionTokensPerEntry })
                }

                yield* outputEntries
                sliceIndex++
            }

            this.printUsage()
        }
    }
}
