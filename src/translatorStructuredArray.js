import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { Translator } from "./translator.mjs";
import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.js";

export class TranslatorStructuredArray extends TranslatorStructuredBase
{
    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options)
    {
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
        const userMessage = { role: "user", content: JSON.stringify({ inputs: lines }) }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const systemMessage = this.systemInstruction ? [{ role: "system", content: `${this.systemInstruction}` }] : []
        const messages = [...systemMessage, ...this.options.initialPrompts, ...this.promptContext, userMessage]
        const max_tokens = this.getMaxToken(lines)

        const structuredArray = z.object({
            outputs: z.array(z.string())
        })

        try
        {
            let startTime = 0, endTime = 0
            startTime = Date.now()

            await this.services.cooler?.cool()

            const output = await this.streamParse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens
            }, {
                structure: structuredArray,
                name: "translation_array"
            })

            // console.log("[TranslatorStructuredArray]", output.choices[0].message.content)

            endTime = Date.now()

            const translationCandidate = output.choices[0].message

            const getLinesOutput = async (/** @type {import("openai/resources/beta/chat/completions.mjs").ParsedChatCompletionMessage<{ outputs?: string[]; }>} */ translation) =>
            {
                if (lines.length === 1 && translation.refusal && this.options.fallbackModel)
                {
                    console.log("[TranslatorStructuredArray] Refusal Fallback", this.options.fallbackModel)
                    const requestOptions = { ...this.options.createChatCompletionRequest }
                    requestOptions.model = this.options.fallbackModel
                    const fallBackOutput = await this.streamParse({
                        messages,
                        ...requestOptions,
                        stream: requestOptions.stream,
                        max_tokens
                    }, {
                        structure: structuredArray,
                        name: "translation_array"
                    })
                    translation = fallBackOutput.choices[0].message
                }

                if (translation.refusal)
                {
                    return [translation.refusal]
                }

                return translation.parsed.outputs
            }

            const linesOut = await getLinesOutput(translationCandidate)

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
            console.error("[TranslatorStructuredArray]", `Error ${error?.constructor?.name}`, error?.message)
            return await this.translateBaseFallback(lines)
        }
    }

    /**
     * @param {string[]} lines 
     * @param {"user" | "assistant" } role
     */
    getContextLines(lines, role)
    {
        if (role === "user")
        {
            return JSON.stringify({ inputs: lines })
        }
        else
        {
            return JSON.stringify({ outputs: lines })
        }
    }
}
