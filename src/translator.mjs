import log from "loglevel"
import { openaiRetryWrapper, completeChatStream } from './openai.mjs';
import { checkModeration } from './moderator.mjs';
import { splitStringByNumberLabel } from './subtitle.mjs';
import { TranslatorBase, DefaultOptions } from './translatorBase.mjs';
import { TranslationOutput } from './translatorOutput.mjs';

export { DefaultOptions }

/**
 * @typedef {import('./translatorBase.mjs').TranslationServiceContext} TranslationServiceContext
 * @typedef {import('./translatorBase.mjs').TranslatorOptions} TranslatorOptions
 */

/**
 * @template [T=string]
 * @template {T[]} [TLines=T[]]
 * @extends {TranslatorBase<T, TLines>}
 * Translator using ChatGPT — string-array implementation.
 */
export class Translator extends TranslatorBase {
    /**
     * @param {{from?: string, to: string}} language
     * @param {TranslationServiceContext} services
     * @param {Partial<TranslatorOptions>} [options]
     */
    constructor(language, services, options) {
        super(language, services, options)

        /**
         * @type {{ source: string; transform: string; completionTokens?: number; }[]}
         * token counts are the total request cost averaged per entry for batch requests
         */
        this.workingProgress = []
        this.offset = 0
        this.end = undefined
        this.moderatorFlags = new Map()

        this.thinkTags = {
            start: "<think>",
            end: "</think>"
        }
    }

    /**
     * @param {any[]} inputLines
     * @param {string} rawContent
     */
    getOutput(inputLines, rawContent) {
        rawContent = rawContent.trim()
        if (rawContent.startsWith(this.thinkTags.start)) {
            const endTagIndex = rawContent.indexOf(this.thinkTags.end)
            if (endTagIndex > 0) {
                const endIndex = endTagIndex + this.thinkTags.end.length
                const thinkBlock = rawContent.slice(0, endIndex).trim()
                if (thinkBlock) {
                    log.debug("[Translator]", "[ThinkBlock] Detected\n", thinkBlock)
                }
                rawContent = rawContent.slice(endIndex)
            }
        }
        if (inputLines.length === 1) {
            return [rawContent.split("\n").join(" ")]
        }
        else {
            return rawContent.split("\n").filter(x => x.trim().length > 0)
        }
    }

    /**
     * @override
     * @param {TLines} lines
     * @returns {Promise<TranslationOutput>}
     */
    async doTranslatePrompt(lines) {
        const text = lines.join("\n\n")
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        const userMessage = { role: "user", content: `${text}` }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const systemMessage = this.systemInstruction ? [{ role: "system", content: `${this.systemInstruction}` }] : []
        const messages = [...systemMessage, ...this.options.initialPrompts, ...this.promptContext, userMessage]
        const max_tokens = this.getMaxToken(lines)

        const streamMode = this.options.createChatCompletionRequest.stream
        return openaiRetryWrapper(async () => {
            await this.services.cooler?.cool()
            if (!streamMode) {
                const promptResponse = await this.services.openai.chat.completions.create({
                    messages,
                    ...this.options.createChatCompletionRequest,
                    stream: false,
                    max_tokens
                })
                const rawContent = promptResponse.choices[0].message.content
                return TranslationOutput.fromUsage(this.getOutput(lines, rawContent), promptResponse.usage)
            }
            else {
                const promptResponse = await this.services.openai.chat.completions.create({
                    messages,
                    ...this.options.createChatCompletionRequest,
                    stream: true,
                    stream_options: {
                        include_usage: true
                    },
                    max_tokens
                })

                this.streamController = promptResponse.controller

                let writeQueue = ''
                /** @type {import('openai').OpenAI.Completions.CompletionUsage} */
                let usage
                const streamOutput = await completeChatStream(promptResponse, /** @param {string} data */(data) => {
                    const hasNewline = data.includes("\n")
                    if (writeQueue.length === 0 && !hasNewline) {
                        // process.stdout.write(data)
                        this.services.onStreamChunk?.(data)
                    }
                    else if (hasNewline) {
                        writeQueue += data
                        writeQueue = writeQueue.replaceAll("\n\n", "\n")
                    }
                    else {
                        writeQueue += data
                        // process.stdout.write(writeQueue)
                        this.services.onStreamChunk?.(writeQueue)
                        writeQueue = ''
                    }
                }, (u) => {
                    usage = u
                    // process.stdout.write("\n")
                    this.services.onStreamEnd?.()
                })
                return TranslationOutput.fromUsage(this.getOutput(lines, streamOutput), usage)
            }
        }, 3, "TranslationPrompt")
    }

    /**
     * @param {string[]} batch
     */
    async * translateSingle(batch) {
        log.debug(`[Translator]`, "Single line mode")
        batch = batch.slice(-this.currentBatchSize)
        for (let x = 0; x < batch.length; x++) {
            const input = batch[x]
            this.buildContext()
            const output = await this.translatePrompt(/** @type {any} */ ([input]))
            const writeOut = output.content[0]
            yield* this.yieldOutput([batch[x]], [writeOut], output.completionTokens)
        }
    }

    /**
     * @param {string[]} lines
     */
    async * translateLines(lines) {
        log.debug("[Translator]", "System Instruction:", this.systemInstruction)
        this.aborted = false
        this.workingLines = lines
        const theEnd = this.end ?? lines.length

        for (let index = this.offset, reducedBatchSessions = 0; index < theEnd; index += this.currentBatchSize) {
            let batch = lines.slice(index, index + this.currentBatchSize).map((x, i) => this.preprocessLine(x, i, index))

            if (this.options.useModerator && !this.services.moderationService) {
                log.warn("[Translator]", "Moderation service requested but not configured, no moderation applied")
            }

            if (this.options.useModerator && this.services.moderationService) {
                const inputForModeration = batch.join("\n\n")
                const moderationData = await checkModeration(inputForModeration, this.services.moderationService, this.options.moderationModel)
                if (moderationData.flagged) {
                    if (!this.changeBatchSize('decrease')) // Already at smallest batch size
                    {
                        yield* this.translateSingle(batch)
                    }
                    else {
                        index -= this.currentBatchSize
                    }
                    continue
                }
            }
            this.buildContext()
            const output = await this.translatePrompt(/** @type {any} */ (batch))

            if (this.aborted) {
                log.debug("[Translator]", "Aborted")
                return
            }

            let outputs = output.content

            if ((this.options.lineMatching && batch.length !== outputs.length) || (batch.length > 1 && output.refusal)) {
                this.promptTokensWasted += output.promptTokens
                this.completionTokensWasted += output.completionTokens

                if (output.refusal) {
                    log.debug(`[Translator]`, "Refusal: ", output.refusal)
                }
                else {
                    log.debug(`[Translator]`, "Lines count mismatch", batch.length, outputs.length)
                }

                log.debug(`[Translator]`, "batch", batch)
                log.debug(`[Translator]`, "transformed", outputs)

                if (this.changeBatchSize("decrease")) {
                    index -= this.currentBatchSize
                }
                else {
                    yield* this.translateSingle(batch)
                }
            }
            else {
                // Lines are translated in batches but the model returns a single token count
                // for the whole batch request. Since workingProgress is stored per entry and
                // buildContext() slices and sums costs per entry, we divide evenly so that
                // summing any subset of entries approximates the proportional token cost.
                yield* this.yieldOutput(batch, outputs, output.completionTokens / outputs.length)
            }

            this.printUsage()

            if (this.batchSizeThreshold && reducedBatchSessions++ >= this.batchSizeThreshold) {
                reducedBatchSessions = 0
                const old = this.currentBatchSize
                this.changeBatchSize("increase")
                index -= (this.currentBatchSize - old)
            }
        }
    }

    /**
     * @param {string[]} promptSources
     * @param {string[]} promptTransforms
     * @param {number} [completionTokensPerEntry] Completion token cost per entry from the model response, for context budget tracking
     */
    * yieldOutput(promptSources, promptTransforms, completionTokensPerEntry) {
        for (let index = 0; index < promptSources.length; index++) {
            const promptSource = promptSources[index];
            const promptTransform = promptTransforms[index] ?? ""
            const workingIndex = this.workingProgress.length
            const originalSource = this.workingLines[workingIndex]
            let finalTransform = promptTransform
            let outTransform = promptTransform

            if (this.moderatorFlags.has(workingIndex)) {
                finalTransform = `[Flagged][Moderator] ${originalSource} -> ${finalTransform} `
            }
            else if (this.options.prefixNumber) {
                const splits = this.postprocessNumberPrefixedLine(finalTransform)
                finalTransform = splits.text
                outTransform = splits.text
                const expectedLabel = workingIndex + 1
                if (expectedLabel !== splits.number) {
                    log.warn("[Translator]", "Label mismatch", expectedLabel, splits.number)
                    this.moderatorFlags.set(workingIndex, { remarks: "Label Mismatch", outIndex: splits.number })
                    finalTransform = `[Flagged][Model] ${originalSource} -> ${finalTransform}`
                }
            }
            else {
                finalTransform = this.postprocessLine(finalTransform)
            }
            this.workingProgress.push({ source: promptSource, transform: promptTransform, completionTokens: completionTokensPerEntry })
            const output = { index: this.workingProgress.length, source: originalSource, transform: outTransform, finalTransform }
            yield output
        }
    }

    /**
     * @param {string} line
     * @param {number} index
     * @param {number} offset
     */
    preprocessLine(line, index, offset) {
        line = line.replaceAll("\n", " \\N ")
        if (this.options.prefixNumber) {
            line = `${offset + index + 1}. ${line}`
        }
        return line
    }

    /**
     * @param {string} line
     */
    postprocessNumberPrefixedLine(line) {
        const splits = splitStringByNumberLabel(line.trim())
        splits.text = this.postprocessLine(splits.text)
        return splits
    }

    /**
     * @param {string} line
     */
    postprocessLine(line) {
        line = line.replaceAll(" \\N ", "\n")
        line = line.replaceAll("\\N", "\n")
        return line
    }

    buildContext() {
        if (this.workingProgress.length === 0) {
            return;
        }

        const { sliced, tokenCount } = this.sliceByTokenBudget(
            this.workingProgress,
            e => e.completionTokens,
            this.options.batchSizes[this.options.batchSizes.length - 1]
        )

        if (this.options.useFullContext > 0) {
            const logSliceContext = sliced.length < this.workingProgress.length
                ? `sliced ${this.workingProgress.length - sliced.length} entries (${sliced.length}/${this.workingProgress.length} kept, ~${Math.round(tokenCount)} tokens)`
                : `all (${sliced.length} entries, ~${Math.round(tokenCount)} tokens)`
            log.debug("[Translator]", "Context:", logSliceContext)
        }

        const offset = this.workingProgress.length - sliced.length;

        /**
         * @param {string} text
         * @param {number} index
         */
        const checkFlaggedMapper = (text, index) => {
            const id = index + (offset < 0 ? 0 : offset);
            if (this.moderatorFlags.has(id)) {
                // log.warn("[Translator]", "Prompt Flagged", id, text)
                return this.preprocessLine("-", id, 0);
            }
            return text;
        };

        const checkedSource = sliced.map((x, i) => checkFlaggedMapper(x.source, i));
        const checkedTransform = sliced.map((x, i) => checkFlaggedMapper(x.transform, i));
        this.promptContext = this.getContext(checkedSource, checkedTransform);
    }

    /**
     * @param {string[]} sourceLines
     * @param {string[]} transformLines
     */
    getContext(sourceLines, transformLines) {
        const chunks = [];
        const chunkSize = this.options.batchSizes[this.options.batchSizes.length - 1];
        for (let i = 0; i < sourceLines.length; i += chunkSize) {
            const sourceChunk = sourceLines.slice(i, i + chunkSize);
            const transformChunk = transformLines.slice(i, i + chunkSize);
            chunks.push({
                role: "user",
                content: this.getContextLines(sourceChunk, "user")
            });
            chunks.push({
                role: "assistant",
                content: this.getContextLines(transformChunk, "assistant")
            });
        }
        return /** @type {import('openai').OpenAI.Chat.ChatCompletionMessage[]}*/ (chunks);
    }


    /**
     * @param {string[]} lines
     * @param {"user" | "assistant" } role
     * @returns {string}
     */
    getContextLines(lines, role) {
        return lines.join("\n\n")
    }
}
