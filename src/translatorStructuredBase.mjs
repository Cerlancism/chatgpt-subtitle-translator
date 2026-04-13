import { APIUserAbortError } from "openai/error.mjs";
import log from "loglevel"
import { Translator } from "./translator.mjs";
import { TranslationOutput } from "./translatorOutput.mjs";
import { ChatStreamRepetitionError } from "./openai.mjs";

/**
 * @abstract
 * @template [T=string]
 * @template {T[]} [TLines=T[]]
 * @extends {Translator<T, TLines>}
 */
export class TranslatorStructuredBase extends Translator {
    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options) {
        log.debug(`[TranslatorStructuredBase]`, "Structured Mode:", options.structuredMode)
        options.prefixNumber = false
        super(language, services, options)
        /** @protected */
        this._repetitionDetected = false
    }

    /**
     * Mark repetition detected and abort the runner (for jsonStream subclasses).
     * @param {string} pattern
     * @param {import('openai/lib/ChatCompletionStream').ChatCompletionStream<any>} runner
     */
    abortOnRepetition(pattern, runner) {
        log.warn(`[${this.constructor.name}]`, `Repetition detected: "${pattern.slice(0, 50)}" - retrying (use --guard-repetition 0 to disable)`)
        this._repetitionDetected = true
        runner.controller.abort()
    }

    /**
     * @param {Error} error
     * @param {number} lineCount
     * @returns {TranslationOutput | undefined}
     */
    handleTranslateError(error, lineCount) {
        if (error instanceof ChatStreamRepetitionError || this._repetitionDetected) {
            const pattern = error instanceof ChatStreamRepetitionError ? error.pattern : ''
            log.warn(`[${this.constructor.name}]`, `Retrying after repetition abort${pattern ? `: "${pattern.slice(0, 50)}"` : ''} (use --guard-repetition 0 to disable)`)
            this._repetitionDetected = false
            return new TranslationOutput([], 0, 0, 0, 0)
        }
        if (error instanceof APIUserAbortError) {
            return undefined
        }
        if (lineCount > 1) {
            return new TranslationOutput([], 0, 0, 0, 0)
        }
        throw error
    }

}
