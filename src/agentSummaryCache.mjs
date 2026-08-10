import fs from 'node:fs'

import log from 'loglevel'

/**
 * Sidecar cache for agent planning summaries.
 *
 * Agent mode's planning pass scans the whole input before translating, which is
 * expensive. The consolidated context summary it produces is persisted next to
 * the input file so an interrupted run can skip the scan on the next attempt.
 * The cache is only reused while the input and the prompt-shaping options still
 * match, since a summary produced for a different file, model or instruction is
 * not valid context.
 */

export const AGENT_SUMMARY_CACHE_VERSION = 1

/**
 * @param {Record<string, any>} opts
 */
function getBaseSystemInstruction(opts) {
    return opts.systemInstruction ?? `Translate ${opts.from ? opts.from + " " : ""}to ${opts.to}`
}

/**
 * @param {string} inputFile
 */
export function getAgentSummaryFile(inputFile) {
    return `${inputFile}.agent-summary.json`
}

/**
 * @param {Record<string, any>} opts
 * @param {Partial<import("./translator.mjs").TranslatorOptions>} options
 */
export function getAgentSummaryMetadata(opts, options) {
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
 * @param {Partial<import("./translator.mjs").TranslatorOptions>} options
 */
export function loadAgentSummary(opts, options) {
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
            log.warn("[AgentSummaryCache]", `Ignoring stale agent summary cache ${summaryFile}`)
            return undefined
        }

        log.debug("[AgentSummaryCache]", `Using agent summary cache ${summaryFile}`)
        return cache.contextSummary
    } catch (error) {
        log.warn("[AgentSummaryCache]", `Could not read agent summary cache ${summaryFile}:`, error?.message ?? error)
        return undefined
    }
}

/**
 * @param {Record<string, any>} opts
 * @param {Partial<import("./translator.mjs").TranslatorOptions>} options
 * @param {{ contextSummary?: string, finalInstruction?: string }} result
 */
export function saveAgentSummary(opts, options, result) {
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
        log.debug("[AgentSummaryCache]", `Saved agent summary cache ${summaryFile}`)
    } catch (error) {
        log.warn("[AgentSummaryCache]", `Could not save agent summary cache for ${opts.input}:`, error?.message ?? error)
    }
}
