/**
 * @template [TContent=string[]]
 */
export class TranslationOutput {
    /**
     * @param {TContent} content
     * @param {number} promptTokens
     * @param {number} completionTokens
     * @param {number} cachedTokens
     * @param {number} [totalTokens]
     * @param {string} [refusal]
     */
    constructor(content, promptTokens, completionTokens, cachedTokens, totalTokens, refusal = "") {
        this.content = content
        this.promptTokens = promptTokens ?? 0
        this.completionTokens = completionTokens ?? 0
        this.cachedTokens = cachedTokens
        this.totalTokens = totalTokens ?? (this.promptTokens + this.completionTokens)
        this.refusal = refusal
    }

    /**
     * Creates a TranslationOutput from a full ChatCompletion response (structured output).
     * @template [C=string[]]
     * @param {C} content
     * @param {import('openai').OpenAI.Chat.ChatCompletion} completion
     * @returns {TranslationOutput<C>}
     */
    static fromCompletion(content, completion) {
        const usage = completion.usage
        return new TranslationOutput(
            content,
            usage?.prompt_tokens,
            usage?.completion_tokens,
            usage?.prompt_tokens_details?.cached_tokens,
            usage?.total_tokens,
            completion.choices[0]?.message?.refusal ?? undefined
        )
    }

    /**
     * Creates a TranslationOutput from a CompletionUsage object (plain/stream response).
     * @template [C=string[]]
     * @param {C} content
     * @param {import('openai').OpenAI.Completions.CompletionUsage | undefined} usage
     * @returns {TranslationOutput<C>}
     */
    static fromUsage(content, usage) {
        return new TranslationOutput(
            content,
            usage?.prompt_tokens,
            usage?.completion_tokens,
            usage?.prompt_tokens_details?.cached_tokens,
            usage?.total_tokens
        )
    }
}
