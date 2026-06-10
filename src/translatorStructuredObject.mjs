import { z } from "zod";
import log from "loglevel"

import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.mjs";

const NestedPlaceholder = "nested_"

export class TranslatorStructuredObject extends TranslatorStructuredBase {
    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options) {
        if (options.batchSizes?.some(x => x > 100)) {
            throw new Error("[TranslatorStructuredObject] Batch sizes should not exceed 100")
        }

        super(language, services, options)
    }

    /**
     * @override
     * @param {string[]} lines
     * @returns {Promise<TranslationOutput<string[]>>}
     */
    async doTranslatePrompt(lines) {
        // No user message - the response schema itself conveys the input lines
        const messages = this.buildPromptMessages()

        const structuredObject = {}
        for (const [key, value] of lines.entries()) {
            if (value.includes("\\N")) {
                const nestedObject = {}
                for (const [nestedKey, nestedValue] of value.split("\\N").entries()) {
                    nestedObject[nestedValue.replaceAll("\\", "").trim()] = z.string()
                }
                structuredObject[NestedPlaceholder + key] = z.object({ ...nestedObject })
            }
            else {
                structuredObject[value.replaceAll("\\", "")] = z.string()
            }
        }
        const translationBatch = z.object({ ...structuredObject })

        try {
            const output = await this.requestStructured(lines, messages, {
                structure: translationBatch,
                name: "translation_object"
            }, {
                shouldAbort: (buffer) => this.checkRepetition(buffer),
            })

            // log.debug("[TranslatorStructuredObject]", output.choices[0].message.content)

            const translation = output.choices[0].message

            function getLinesOutput() {
                if (translation.refusal) {
                    return [translation.refusal]
                }
                else {
                    const parsed = output.choices[0].message.parsed
                    const linesOut = []

                    let expectedIndex = 0
                    for (const [key, value] of Object.entries(parsed)) {
                        if (key.startsWith(NestedPlaceholder)) {
                            let multilineOutput = []
                            for (const [nestedKey, nestedValue] of Object.entries(value)) {
                                multilineOutput.push(nestedValue)
                            }
                            linesOut.push(multilineOutput.join("\\N"))
                        }
                        else {
                            const expectedKey = lines[expectedIndex]
                            if (key != expectedKey) {
                                log.warn("[TranslatorStructuredObject]", "Unexpected key", "Expected", expectedKey, "Received", key)
                            }
                            const element = parsed[key]
                            linesOut.push(element)
                        }
                        expectedIndex++
                    }
                    return linesOut
                }
            }

            const linesOut = getLinesOutput()

            return TranslationOutput.fromCompletion(linesOut, output)
        } catch (error) {
            return this.logAndHandleTranslateError(error, lines.length)
        }
    }


    /**
     * @override
     * @param {string[]} sourceLines
     * @param {string[]} transformLines
     */
    getContext(sourceLines, transformLines) {
        const output = {}

        for (let index = 0; index < sourceLines.length; index++) {
            const source = sourceLines[index]
            const transform = transformLines[index]
            output[source] = transform
        }

        return  /** @type {import('openai').OpenAI.Chat.ChatCompletionMessage[]}*/ ([
            { role: "assistant", content: JSON.stringify(output) }
        ])
    }
}
