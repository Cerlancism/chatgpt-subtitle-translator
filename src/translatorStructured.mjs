import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { Translator } from "./translator.mjs";
import { TranslationOutput } from "./translatorOutput.mjs";

export class TranslatorStructured extends Translator
{
    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options)
    {
        console.error(`[TranslatorStructured]`, "Structured Mode")

        if (options.prefixNumber)
        {
            console.warn("[TranslatorStructured]", "--no-prefix-number must be used in structured mode, overriding.")
            options.prefixNumber = false
        }

        if (options.createChatCompletionRequest.stream)
        {
            console.warn("[TranslatorStructured]", "--stream is not applicable in structured mode, disabling, expect long indications of progress.")
            options.createChatCompletionRequest.stream = false
        }

        super(language, services, options)
    }

    /**
     * @param {[string]} lines
     * @returns {Promise<TranslationOutput>}
     */
    async translatePrompt(lines)
    {
        // const text = lines.join("\n\n")
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        // const userMessage = { role: "user", content: `Translate from given schema` }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const systemMessage = this.systemInstruction ? [{ role: "system", content: `${this.systemInstruction}` }] : []
        const messages = [...systemMessage, ...this.options.initialPrompts, ...this.promptContext]

        const structuredObject = {}
        for (const key in lines)
        {
            if (Object.prototype.hasOwnProperty.call(lines, key))
            {
                const value = lines[key]
                structuredObject[value] = z.string()
            }
        }
        const translationBatch = z.object({ ...structuredObject });

        try
        {
            let startTime = 0, endTime = 0
            startTime = Date.now()

            const output = await this.services.openai.beta.chat.completions.parse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: false,
                response_format: zodResponseFormat(translationBatch, "translation_batch"),
            })

            // console.log("[TranslatorStructured]", output.choices[0].message.content)

            endTime = Date.now()

            const parsed = output.choices[0].message.parsed
            const linesOut = []

            let expectedIndex = 0
            for (const key in parsed)
            {
                if (Object.prototype.hasOwnProperty.call(parsed, key))
                {
                    const expectedKey = lines[expectedIndex]
                    if (key != expectedKey)
                    {
                        console.warn("[TranslatorStructured]", "Unexpected key", "Expected", expectedKey, "Received", key)
                    }
                    const element = parsed[key];
                    linesOut.push(element)
                    expectedIndex++
                }
            }

            const translationOutput = new TranslationOutput(
                linesOut,
                output.usage.prompt_tokens,
                output.usage.completion_tokens,
                output.usage.total_tokens,
                output.choices[0].message.refusal
            )

            this.promptTokensUsed += translationOutput.promptTokens
            this.completionTokensUsed += translationOutput.completionTokens
            this.tokensProcessTimeMs += (endTime - startTime)

            return translationOutput
        } catch (error)
        {
            console.error("[TranslatorStructured]", "Error", error)
            console.error("[TranslatorStructured]", "Fallback to base mode")
            return super.translatePrompt(lines)
        }
    }
}
