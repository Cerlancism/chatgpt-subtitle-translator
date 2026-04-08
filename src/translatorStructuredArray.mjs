import { PassThrough } from "stream";
import { z } from "zod";
import { JSONParser } from "@streamparser/json-node";
import log from "loglevel"

import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.mjs";
import { streamParse } from "./openai.mjs";

export class TranslatorStructuredArray extends TranslatorStructuredBase {
    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options) {
        super(language, services, options)
    }

    /**
     * @override
     * @param {[string]} lines
     * @returns {Promise<TranslationOutput>}
     */
    async doTranslatePrompt(lines) {
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

        try {
            await this.services.cooler?.cool()

            const output = await streamParse(this.services, {
                messages,
                ...this.options.createChatCompletionRequest,
                stream: this.options.createChatCompletionRequest.stream,
                max_tokens
            }, {
                structure: structuredArray,
                name: "translation_array"
            }, {
                jsonStream: true,
                onJsonStream: (runner) => this.jsonStreamParse(runner),
                onController: (c) => { this.streamController = c },
            })

            // log.debug("[TranslatorStructuredArray]", output.choices[0].message.content)

            const translationCandidate = output.choices[0].message

            const getLinesOutput = async (/** @type {import("openai/resources/chat/completions.mjs").ParsedChatCompletionMessage<{ outputs?: string[]; }>} */ translation) => {
                if (translation.refusal) {
                    return [translation.refusal]
                }

                return translation.parsed.outputs
            }

            const linesOut = await getLinesOutput(translationCandidate)

            return TranslationOutput.fromCompletion(linesOut, output)
        } catch (error) {
            if (!this._repetitionDetected) {
                log.error("[TranslatorStructuredArray]", `Error ${error?.constructor?.name}`, error?.message)
            }
            return this.handleTranslateError(error, lines.length)
        }
    }

    /**
     * @override
     * @param {string[]} lines 
     * @param {"user" | "assistant" } role
     */
    getContextLines(lines, role) {
        if (role === "user") {
            return JSON.stringify({ inputs: lines })
        }
        else {
            return JSON.stringify({ outputs: lines })
        }
    }

    /**
     * @param {import('openai/lib/ChatCompletionStream').ChatCompletionStream<any>} runner
     */
    jsonStreamParse(runner) {
        this.services.onStreamChunk?.("\n")
        const passThroughStream = new PassThrough()
        let writeBuffer = ''
        let contentBuffer = ''
        runner.on("content.delta", (e) => {
            writeBuffer += e.delta
            contentBuffer += e.delta
            passThroughStream.write(e.delta)
            if (writeBuffer) {
                this.services.onStreamChunk?.(writeBuffer)
                writeBuffer = ''
            }
            const pattern = this.checkRepetition(contentBuffer)
            if (pattern) {
                this.abortOnRepetition(pattern, runner)
            }
        })
        runner.on("content.done", () => {
            passThroughStream.end()
            this.services.onClearLine?.()
        })
        const pipeline = passThroughStream
            .pipe(new JSONParser({ paths: ['$.outputs.*'], keepStack: false }))
        pipeline.on("data", (/** @type {{ value: string }} */ { value: output }) => {
            try {
                this.services.onClearLine?.()
                writeBuffer = `${output}\n`
            } catch (err) {
                log.error("[TranslatorStructuredArray]", "Parsing error:", err)
            }
        })
        pipeline.on("error", (/** @type {Error} */ err) => {
            log.error("[TranslatorStructuredArray]", "stream-json parsing error:", err)
        })
    }
}
