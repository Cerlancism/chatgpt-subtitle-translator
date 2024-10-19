export class TranslationOutput
{
    /**
     * @param {string[]} content
     * @param {number} promptTokens
     * @param {number} completionTokens
     * @param {number} cachedTokens
     * @param {number} [totalTokens]
     */
    constructor(content, promptTokens, completionTokens, cachedTokens, totalTokens, refusal = "")
    {
        this.content = content
        this.promptTokens = promptTokens ?? 0
        this.completionTokens = completionTokens ?? 0
        this.cachedTokens = cachedTokens
        this.totalTokens = totalTokens ?? (this.promptTokens + this.completionTokens)
        this.refusal = refusal
    }
}
