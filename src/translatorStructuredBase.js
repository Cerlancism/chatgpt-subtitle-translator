import { APIUserAbortError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import log from "loglevel"
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
        log.debug(`[TranslatorStructuredBase]`, "Structured Mode:", options.structuredMode)
        const optionsBackup = {}
        optionsBackup.stream = options.createChatCompletionRequest?.stream
        if (options.prefixNumber)
        {
            log.warn("[TranslatorStructuredBase]", "--no-prefix-number must be used in structured mode, overriding.")
        }
        options.prefixNumber = false
        super(language, services, options)

        this.optionsBackup = optionsBackup
    }

    /**
     * @param {string[]} lines 
     * @param {Error} error
     */
    async translateBaseFallback(lines, error)
    {
        if (error && error instanceof APIUserAbortError)
        {
            return
        }
        log.warn("[TranslatorStructuredBase]", "Fallback to base mode")
        const output = await super.translatePrompt(lines)
        return output
    }

    /**
     * @template {import('zod').ZodType} ZodInput
     * @param {import('openai').OpenAI.ChatCompletionCreateParams} params
     * @param {{structure: ZodInput, name: string}} zFormat
     * @param {boolean} jsonStream
     */
    async streamParse(params, zFormat, jsonStream = false)
    {
        if (params.stream)
        {
            const runner = this.services.openai.chat.completions.stream({
                ...params,
                response_format: zodResponseFormat(zFormat.structure, zFormat.name),
                stream: true,
                stream_options: {
                    include_usage: true,
                },
            })

            this.streamController = runner.controller

            if (jsonStream)
            {
                this.jsonStreamParse(runner)
            }
            else
            {
                runner.on("content.delta", (e) =>
                {
                    this.services.onStreamChunk?.(e.delta)
                })
            }
            await runner.done()

            this.services.onStreamEnd?.()

            const final = await runner.finalChatCompletion()

            return final

        } else
        {
            const output = await this.services.openai.chat.completions.parse({
                ...params,
                response_format: zodResponseFormat(zFormat.structure, zFormat.name),
                stream: false,
            })
            return output
        }
    }

    /**
     * @abstract
     * @template T
     * @param {import('openai/lib/ChatCompletionStream').ChatCompletionStream<T>} runner 
     */
    jsonStreamParse(runner)
    {

    }
}
