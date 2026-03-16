import test from 'node:test';
import assert from 'node:assert';

import { createOpenAIClient, CooldownContext, TranslatorAgent, TranslatorStructuredTimestamp } from '../src/main.mjs';
import 'dotenv/config'

const openai = createOpenAIClient(process.env.OPENAI_API_KEY)
const cooler = new CooldownContext(2, 2000, "ChatGPTAPI")

function makeAgent(systemInstruction) {
    const lang = { from: "Japanese", to: "English" }
    const services = { cooler, openai }
    const options = {
        createChatCompletionRequest: { model: process.env.OPENAI_DEFAULT_MODEL, temperature: 0, stream: false },
        batchSizes: [10, 50],
        useFullContext: 2000,
    }
    const delegate = new TranslatorStructuredTimestamp(lang, services, { ...options })
    const agent = new TranslatorAgent(lang, services, options, delegate)
    agent.systemInstruction = systemInstruction
    return agent
}

test('_refineFinalInstruction: filters glossary to only observed terms', async () => {
    const baseInstruction =
        `Translate Japanese to English.\n\n` +
        `Glossary:\n` +
        `- Tanaka = Tanaka (detective)\n` +
        `- Yamamoto = Yamamoto (police chief)\n` +
        `- Sato = Sato (suspect)\n` +
        `- Miyazaki = Miyazaki (scientist)\n` +
        `- Nakamura = Nakamura (doctor)\n` +
        `- Kobayashi = Kobayashi (lawyer)\n` +
        `- bento = bento box (lunch)\n` +
        `- koban = police box\n` +
        `- senpai = senior colleague`

    const contextSummary =
        `Episode 3 of a crime drama. Detective Tanaka interrogates suspect Sato at the koban. ` +
        `Police chief Yamamoto supervises. No scientists, doctors, or lawyers appear.`

    const agent = makeAgent(baseInstruction)
    const result = await agent._refineFinalInstruction(contextSummary, 500)

    console.log("Refined instruction:\n", result)

    assert.ok(result, "Should return a refined instruction")

    // Terms present in the observed context should be kept
    assert.ok(result.includes("Tanaka"), "Should keep Tanaka (appears in context)")
    assert.ok(result.includes("Sato"), "Should keep Sato (appears in context)")
    assert.ok(result.includes("Yamamoto"), "Should keep Yamamoto (appears in context)")
    assert.ok(result.includes("koban"), "Should keep koban (appears in context)")

    // Terms not in the observed context should be removed
    assert.ok(!result.includes("Miyazaki"), "Should remove Miyazaki (not in context)")
    assert.ok(!result.includes("Nakamura"), "Should remove Nakamura (not in context)")
    assert.ok(!result.includes("Kobayashi"), "Should remove Kobayashi (not in context)")
})

test('_refineFinalInstruction: preserves target language when base is minimal', async () => {
    const baseInstruction = `Translate Japanese to English.`
    const contextSummary = `A short cooking show. Host explains how to make ramen.`
    const agent = makeAgent(baseInstruction)
    const result = await agent._refineFinalInstruction(contextSummary, 500)

    console.log("Refined instruction:\n", result)

    assert.ok(result, "Should return a refined instruction")
    assert.ok(result.toLowerCase().includes("english"), "Should preserve target language")
})
