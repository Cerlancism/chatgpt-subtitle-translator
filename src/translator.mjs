import log from "loglevel"
import { countTokens } from "gpt-tokenizer"
import { openaiRetryWrapper, completeChatStream } from './openai.mjs';
import { checkModeration } from './moderator.mjs';
import { splitStringByNumberLabel } from './subtitle.mjs';
import { TranslatorBase, DefaultOptions } from './translatorBase.mjs';
import { TranslationOutput } from './translatorOutput.mjs';

export { DefaultOptions }

export const AUTO_BATCH_MIN = 3
export const AUTO_BATCH_REDUCTION = 3

/**
 * @typedef {import('./translatorBase.mjs').TranslationServiceContext} TranslationServiceContext
 * @typedef {import('./translatorBase.mjs').TranslatorOptions} TranslatorOptions
 */

/**
 * @template [T=string]
 * @template {T[]} [TLines=T[]]
 * @extends {TranslatorBase<T, TLines>}
 * Translator using ChatGPT - string-array implementation.
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
     * @param {any[]} batch
     * @param {any[]} outputs
     * @returns {boolean}
     */
    evaluateBatchOutput(batch, outputs) {
        const isMismatch = this.options.lineMatching && batch.length !== outputs.length
        if (isMismatch) {
            log.debug(`[Translator]`, "Lines count mismatch", batch.length, outputs.length)
            log.debug(`[Translator]`, "batch", batch)
            log.debug(`[Translator]`, "transformed", outputs)
        }
        return isMismatch
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
     * Computes how many lines starting at startIndex fit within 15% of the context token budget.
     * Returns at least 3.
     * @param {any[]} lines
     * @param {number} startIndex
     * @returns {number}
     */
    computeDynamicBatchSize(lines, startIndex) {
        const useFullContext = this.options.useFullContext
        if (!useFullContext) {
            return lines.length - startIndex
        }
        const budget = Math.floor(useFullContext * 0.15)
        let tokensSoFar = 0
        let count = 0
        for (let i = startIndex; i < lines.length; i++) {
            const lineTokens = countTokens(String(lines[i]))
            if (count > 0 && tokensSoFar + lineTokens > budget) break
            tokensSoFar += lineTokens
            count++
        }
        return Math.max(AUTO_BATCH_MIN, count)
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
            if (this.isDynamicBatch) {
                const computed = this.computeDynamicBatchSize(lines, index)
                this.currentBatchSize = Math.max(AUTO_BATCH_MIN, Math.floor(computed / this.dynamicReductionFactor))
                log.debug("[Translator]", "Dynamic batch size:", this.currentBatchSize,
                    this.dynamicReductionFactor > 1 ? `(reduction x${this.dynamicReductionFactor})` : `(budget: ${Math.floor(this.options.useFullContext * 0.15)} tokens)`)
            }

            let batch = lines.slice(index, index + this.currentBatchSize).map((x, i) => this.preprocessLine(x, i, index))

            if (this.options.useModerator && !this.services.moderationService) {
                log.warn("[Translator]", "Moderation service requested but not configured, no moderation applied")
            }

            if (this.options.useModerator && this.services.moderationService) {
                const inputForModeration = batch.join("\n\n")
                const moderationData = await checkModeration(inputForModeration, this.services.moderationService, this.options.moderationModel)
                if (moderationData.flagged) {
                    if (this.isDynamicBatch) {
                        if (this.currentBatchSize <= AUTO_BATCH_MIN) {
                            yield* this.translateSingle(batch)
                            this.dynamicReductionFactor = 1
                        } else {
                            this.dynamicReductionFactor *= AUTO_BATCH_REDUCTION
                            index -= this.currentBatchSize
                        }
                    } else {
                        if (!this.changeBatchSize('decrease')) {
                            yield* this.translateSingle(batch)
                        } else {
                            index -= this.currentBatchSize
                        }
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

            if (this.evaluateBatchOutput(batch, outputs) || (batch.length > 1 && output.refusal)) {
                this.promptTokensWasted += output.promptTokens
                this.completionTokensWasted += output.completionTokens

                if (output.refusal) {
                    log.debug(`[Translator]`, "Refusal: ", output.refusal)
                }

                if (this.isDynamicBatch) {
                    if (this.currentBatchSize <= AUTO_BATCH_MIN) {
                        yield* this.translateSingle(batch)
                        this.dynamicReductionFactor = 1
                    } else {
                        this.dynamicReductionFactor *= AUTO_BATCH_REDUCTION
                        index -= this.currentBatchSize
                    }
                } else {
                    if (this.changeBatchSize("decrease")) {
                        index -= this.currentBatchSize
                    } else {
                        yield* this.translateSingle(batch)
                    }
                }
            }
            else {
                // Lines are translated in batches but the model returns a single token count
                // for the whole batch request. Since workingProgress is stored per entry and
                // buildContext() slices and sums costs per entry, we divide evenly so that
                // summing any subset of entries approximates the proportional token cost.
                yield* this.yieldOutput(batch, outputs, output.completionTokens / outputs.length)

                if (this.isDynamicBatch) {
                    this.dynamicReductionFactor = 1
                } else {
                    if (this.batchSizeThreshold && reducedBatchSessions++ >= this.batchSizeThreshold) {
                        reducedBatchSessions = 0
                        const old = this.currentBatchSize
                        this.changeBatchSize("increase")
                        index -= (this.currentBatchSize - old)
                    }
                }
            }

            this.printUsage()
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

        const chunkSize = this.options.batchSizes?.[this.options.batchSizes.length - 1] ?? this.currentBatchSize

        // Group all history into fixed-size chunks of batchSizes[last]
        const allChunks = []
        for (let i = 0; i < this.workingProgress.length; i += chunkSize) {
            allChunks.push(this.workingProgress.slice(i, i + chunkSize))
        }

        const { includedChunks, tokenCount } = this.selectContextChunks(allChunks, chunk => {
            const messages = this.getContext(chunk.map(e => e.source), chunk.map(e => e.transform))
            return messages.reduce((sum, m) => sum + countTokens(String(m.content ?? "")), 0)
        })

        const sliced = includedChunks.flat()

        if (this.options.useFullContext > 0) {
            const logSliceContext = sliced.length < this.workingProgress.length
                ? `sliced ${this.workingProgress.length - sliced.length} entries (${sliced.length}/${this.workingProgress.length} kept, ${tokenCount} tokens)`
                : `all (${sliced.length} entries, ${tokenCount} tokens)`
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
        const chunkSize = this.options.batchSizes?.[this.options.batchSizes.length - 1] ?? this.currentBatchSize;
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
