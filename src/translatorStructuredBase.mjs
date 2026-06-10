import { APIUserAbortError } from "openai/error.mjs";
import log from "loglevel"
import { Translator } from "./translator.mjs";
import { TranslationOutput } from "./translatorOutput.mjs";
import { ChatStreamRepetitionError, streamParse } from "./openai.mjs";

/**
 * @abstract
 * @template [T=string] Input entry type
 * @template [TOut=import('./translatorBase.mjs').LineOutput] Output type yielded by translateLines
 * @extends {Translator<T, TOut>}
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
     * @param {string} [buffer] Buffer in which the pattern was detected, used to count occurrences.
     */
    abortOnRepetition(pattern, runner, buffer) {
        const threshold = this._effectiveGuardRepetition ?? this.options.guardRepetition
        let count = 0
        if (buffer) {
            let idx = buffer.indexOf(pattern)
            while (idx !== -1) {
                count++
                idx = buffer.indexOf(pattern, idx + pattern.length)
            }
        }
        log.warn(`[${this.constructor.name}]`, `Repetition detected: "${pattern.slice(0, 50)}" (count=${count}, chars=${pattern.length}, threshold=${threshold}) - retrying (use --guard-repetition 0 to disable)`)
        this._repetitionDetected = true
        runner.controller.abort()
    }

    /**
     * Shared structured-output request: cooldown, request parameter spread,
     * and stream controller binding. Subclasses pass mode-specific stream options.
     * @template {import('zod').ZodType} S
     * @param {T[]} lines
     * @param {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} messages
     * @param {{structure: S, name: string}} zFormat
     * @param {Parameters<typeof streamParse>[3]} [streamOptions]
     */
    async requestStructured(lines, messages, zFormat, streamOptions = {}) {
        await this.services.cooler?.cool()
        return streamParse(this.services, {
            messages,
            ...this.options.createChatCompletionRequest,
            stream: this.options.createChatCompletionRequest.stream,
            max_tokens: this.getMaxToken(lines)
        }, zFormat, {
            onController: (c) => { this.streamController = c },
            ...streamOptions
        })
    }

    /**
     * Logs the error (unless it is a repetition abort, which is already reported)
     * and delegates to {@link handleTranslateError}.
     * @param {Error} error
     * @param {number} lineCount
     * @returns {TranslationOutput<T[]> | undefined}
     */
    logAndHandleTranslateError(error, lineCount) {
        if (!this._repetitionDetected && !(error instanceof ChatStreamRepetitionError)) {
            log.error(`[${this.constructor.name}]`, `Error ${error?.constructor?.name}`, error?.message)
        }
        return this.handleTranslateError(error, lineCount)
    }

    /**
     * @param {Error} error
     * @param {number} lineCount
     * @returns {TranslationOutput<T[]> | undefined}
     */
    handleTranslateError(error, lineCount) {
        const emptyOutput = () => /** @type {TranslationOutput<T[]>} */ (new TranslationOutput([], 0, 0, 0, 0))
        if (error instanceof ChatStreamRepetitionError || this._repetitionDetected) {
            const pattern = error instanceof ChatStreamRepetitionError ? error.pattern : ''
            log.warn(`[${this.constructor.name}]`, `Retrying after repetition abort${pattern ? `: "${pattern.slice(0, 50)}"` : ''}`)
            this._repetitionDetected = false
            return emptyOutput()
        }
        if (error instanceof APIUserAbortError) {
            return undefined
        }
        if (lineCount > 1) {
            return emptyOutput()
        }
        throw error
    }

}
