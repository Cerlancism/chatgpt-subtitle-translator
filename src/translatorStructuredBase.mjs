import { APIUserAbortError } from "openai/error.mjs";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import log from "loglevel"
import { Translator } from "./translator.mjs";
import { TranslationOutput } from "./translatorOutput.mjs";

/**
 * @abstract
 * @template {any[]} [TLines=string[]]
 * @extends {Translator<TLines>}
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

    /**
     * @template {import('zod').ZodType} ZodInput
     * @param {import('openai').OpenAI.ChatCompletionCreateParams} params
     * @param {{structure: ZodInput, name: string}} zFormat
     * @param {boolean} jsonStream
     */
    async streamParse(params, zFormat, jsonStream = false) {
        const zodResponseFormatOutput = zodResponseFormat(zFormat.structure, zFormat.name)
        if (params.stream) {
            const runner = this.services.openai.chat.completions.stream({
                ...params,
                response_format: zodResponseFormatOutput,
                stream: true,
                stream_options: {
                    include_usage: true,
                },
            })

            this.streamController = runner.controller

            if (jsonStream) {
                this.jsonStreamParse(runner)
            }
            else {
                runner.on("content.delta", (e) => {
                    this.services.onStreamChunk?.(e.delta)
                })
            }
            await runner.done()

            this.services.onStreamEnd?.()

            const final = await runner.finalChatCompletion()

            return final

        } else {
            const output = await this.services.openai.chat.completions.parse({
                ...params,
                response_format: zodResponseFormatOutput,
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
    jsonStreamParse(runner) {

    }
}
