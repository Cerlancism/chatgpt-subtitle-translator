import { PassThrough } from "stream";
import { z } from "zod";
import { JSONParser } from "@streamparser/json-node";
import log from "loglevel"

import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.mjs";

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
     * @param {string[]} lines
     * @returns {Promise<TranslationOutput<string[]>>}
     */
    async doTranslatePrompt(lines) {
        const messages = this.buildPromptMessages(JSON.stringify({ inputs: lines }))

        const structuredArray = z.object({
            outputs: z.array(z.string())
        })

        try {
            const output = await this.requestStructured(lines, messages, {
                structure: structuredArray,
                name: "translation_array"
            }, {
                jsonStream: true,
                onJsonStream: (runner) => this.jsonStreamParse(runner),
            })

            /** @type {import("openai/resources/chat/completions.mjs").ParsedChatCompletionMessage<{ outputs?: string[]; }>} */
            const translation = output.choices[0].message
            const linesOut = translation.refusal ? [translation.refusal] : translation.parsed.outputs

            return TranslationOutput.fromCompletion(linesOut, output)
        } catch (error) {
            return this.logAndHandleTranslateError(error, lines.length)
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
        let passThroughEnded = false
        let writeBuffer = ''
        let contentBuffer = ''
        passThroughStream.on("error", (/** @type {Error} */ err) => {
            log.debug("[TranslatorStructuredArray]", "stream buffer error:", err.message)
        })
        runner.on("content.delta", (e) => {
            if (passThroughEnded || passThroughStream.destroyed || passThroughStream.writableEnded) {
                return
            }
            writeBuffer += e.delta
            contentBuffer += e.delta
            passThroughStream.write(e.delta)
            if (writeBuffer) {
                this.services.onStreamChunk?.(writeBuffer)
                writeBuffer = ''
            }
            const pattern = this.checkRepetition(contentBuffer)
            if (pattern) {
                this.abortOnRepetition(pattern, runner, contentBuffer)
            }
        })
        runner.on("content.done", () => {
            if (passThroughEnded) return
            passThroughEnded = true
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
