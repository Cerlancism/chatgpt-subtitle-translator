import { Translator } from "./translator.mjs";

export class TranslatorStructuredBase extends Translator
{
    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options)
    {
        console.error(`[TranslatorStructuredBase]`, "Structured Mode:", options.structuredMode)
        const optionsBackup = {}
        optionsBackup.stream = options.createChatCompletionRequest?.stream
        if (options.prefixNumber)
        {
            console.warn("[TranslatorStructuredBase]", "--no-prefix-number must be used in structured mode, overriding.")
            options.prefixNumber = false
        }

        if (options.createChatCompletionRequest.stream)
        {
            console.warn("[TranslatorStructuredBase]", "--stream is not applicable in structured mode, disabling, expect long time waits for indications of progress. Stream mode will still be applied when falling back to base mode.")
            options.createChatCompletionRequest.stream = false
        }
        super(language, services, options)

        this.optionsBackup = optionsBackup
    }
}