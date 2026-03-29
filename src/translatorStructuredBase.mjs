import { APIUserAbortError } from "openai/error.mjs";
import log from "loglevel"
import { Translator } from "./translator.mjs";
import { TranslationOutput } from "./translatorOutput.mjs";

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
        const optionsBackup = {}
        optionsBackup.stream = options.createChatCompletionRequest?.stream
        if (options.prefixNumber) {
            log.warn("[TranslatorStructuredBase]", "--no-prefix-number must be used in structured mode, overriding.")
        }
        options.prefixNumber = false
        super(language, services, options)

        this.optionsBackup = optionsBackup
    }

    /**
     * @param {Error} error
     * @param {number} lineCount
     * @returns {TranslationOutput | undefined}
     */
    handleTranslateError(error, lineCount) {
        if (error instanceof APIUserAbortError) {
            return undefined
        }
        if (lineCount > 1) {
            return new TranslationOutput([], 0, 0, 0, 0)
        }
        throw error
    }

}
