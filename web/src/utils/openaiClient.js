import { createOpenAIClient } from "chatgpt-subtitle-translator"

/**
 * Anthropic rejects requests coming from a browser origin unless this header is
 * present, and other providers ignore unknown headers, so it is always sent.
 */
const BrowserAccessHeaders = { "anthropic-dangerous-direct-browser-access": "true" }

/**
 * Creates an OpenAI compatible client for use from the browser.
 *
 * @param {string} apiKey
 * @param {string} [baseURL]
 * @param {Partial<import('openai').ClientOptions>} [options]
 */
export function createBrowserOpenAIClient(apiKey, baseURL = undefined, options = undefined) {
  return createOpenAIClient(apiKey, true, baseURL).withOptions({
    defaultHeaders: BrowserAccessHeaders,
    ...options,
  })
}
