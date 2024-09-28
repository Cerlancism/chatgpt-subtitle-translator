import { zodResponseFormat } from "openai/helpers/zod.mjs";
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
        super(language, services, options)

        this.optionsBackup = optionsBackup
    }

    /**
     * @param {string[]} lines 
     */
    async translateBaseFallback(lines)
    {
        console.error("[TranslatorStructuredBase]", "Fallback to base mode")
        const optionsRestore = {}
        optionsRestore.stream = this.options.createChatCompletionRequest?.stream

        this.options.createChatCompletionRequest.stream = this.optionsBackup.stream

        const output = await super.translatePrompt(lines)

        this.options.createChatCompletionRequest.stream = optionsRestore.stream

        return output
    }

    /**
     * @template T
     * @param {import('openai').OpenAI.ChatCompletionCreateParams} params
     * @param {{structure: import('zod').ZodType<T>, name: string}} zFormat
     */
    async streamParse(params, zFormat)
    {
        if (params.stream)
        {
            const runner = this.services.openai.beta.chat.completions.stream({
                ...params,
                response_format: zodResponseFormat(zFormat.structure, zFormat.name),
                stream: true,
                stream_options: {
                    include_usage: true
                }
            })

            runner.on("content.delta", (e) =>
            {
                this.services.onStreamChunk?.(e.delta)
            })

            await runner.done()

            this.services.onStreamEnd?.()

            const final = await runner.finalChatCompletion()

            return final
        } else
        {
            const output = await this.services.openai.beta.chat.completions.parse({
                ...params,
                response_format: zodResponseFormat(zFormat.structure, zFormat.name),
                stream: false
            })
            return output
        }
    }
}
