import test from 'node:test';
import assert from 'node:assert';

import { TranslatorStructuredTimestamp } from '../src/translatorStructuredTimestamp.mjs';

const entries = [
    { start: "00:00:00,000", end: "00:00:02,000", text: "おはようございます。" },
    { start: "00:00:02,000", end: "00:00:05,000", text: "お元気ですか？" },
    { start: "00:00:05,000", end: "00:00:07,000", text: "はい、元気です。" },
    { start: "00:00:08,000", end: "00:00:12,000", text: "今日は天気がいいですね。" },
    { start: "00:00:12,000", end: "00:00:16,000", text: "はい、とてもいい天気です。" },
]

/**
 * Builds a stub OpenAI client: moderation flags per `flaggedFn`, and the chat
 * completion echoes each toon input row back as a translated output.
 * @param {(input: string) => boolean} flaggedFn
 * @param {{moderationInputs: string[], parseBatchSizes: number[]}} calls
 */
function makeFakeOpenai(flaggedFn, calls) {
    return {
        moderations: {
            create: async ({ input }) => {
                calls.moderationInputs.push(input)
                const flagged = flaggedFn(input)
                return { results: [{ flagged, categories: { violence: flagged }, category_scores: { violence: flagged ? 0.99 : 0 } }] }
            }
        },
        chat: {
            completions: {
                parse: async (params) => {
                    const userContent = params.messages.at(-1).content
                    const rows = [...userContent.matchAll(/^(\d+)\|(\d+)\|(.+)$/gm)]
                    calls.parseBatchSizes.push(rows.length)
                    const outputs = rows.map(m => ({ start: Number(m[1]), end: Number(m[2]), text: `EN:${m[3]}` }))
                    return {
                        choices: [{ message: { parsed: { outputs }, refusal: null } }],
                        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
                    }
                }
            }
        }
    }
}

/**
 * Runs a timestamp translation over the test entries with a stubbed client.
 * @param {(input: string) => boolean} flaggedFn
 */
async function runModerated(flaggedFn) {
    const calls = { moderationInputs: [], parseBatchSizes: [] }
    const openai = makeFakeOpenai(flaggedFn, calls)
    const translator = new TranslatorStructuredTimestamp({ to: "English" }, {
        openai: /** @type {any} */ (openai),
        moderationService: { openai: /** @type {any} */ (openai) }
    }, {
        createChatCompletionRequest: { model: "fake", temperature: 0, stream: false },
        batchSizes: [2, 3],
        useModerator: true,
        logLevel: "warn",
    })
    const results = []
    for await (const out of translator.translateLines(entries)) {
        results.push(out)
    }
    return { calls, results }
}

test('timestamp moderation: flagged batches shrink to single-entry fallback', async () => {
    const { calls, results } = await runModerated(() => true)

    for (const input of calls.moderationInputs) {
        assert.ok(!input.includes("[object"), `moderation input must be text, got: ${input}`)
        assert.ok(/おはよう|元気|天気/.test(input), `moderation input should contain entry text, got: ${input}`)
    }

    assert.ok(calls.parseBatchSizes.every(n => n === 1),
        `flagged batches must reach the model only as single entries, got [${calls.parseBatchSizes}]`)

    assert.strictEqual(results.length, entries.length, "all entries should still be translated")
    results.forEach((r, i) => {
        assert.strictEqual(r.start, entries[i].start, "start timestamp preserved")
        assert.strictEqual(r.end, entries[i].end, "end timestamp preserved")
        assert.strictEqual(r.text, `EN:${entries[i].text}`)
    })
})

test('timestamp moderation: clean input keeps normal batching', async () => {
    const { calls, results } = await runModerated(() => false)

    assert.deepStrictEqual(calls.parseBatchSizes, [3, 2], "batches should follow batchSizes untouched")
    assert.strictEqual(calls.moderationInputs.length, 2, "one moderation call per batch")
    assert.strictEqual(results.length, entries.length)
    results.forEach((r, i) => assert.strictEqual(r.text, `EN:${entries[i].text}`))
})

test('timestamp moderation: partially flagged input recovers and translates everything', async () => {
    const { calls, results } = await runModerated((input) => input.includes("天気がいい"))

    assert.strictEqual(results.length, entries.length)
    results.forEach((r, i) => assert.strictEqual(r.text, `EN:${entries[i].text}`))
    assert.ok(calls.moderationInputs.length >= 2, "flagged batch should be re-moderated after shrinking")
})
