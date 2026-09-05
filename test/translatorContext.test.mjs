import test from 'node:test';
import assert from 'node:assert/strict';

import { Translator, CACHE_WINDOW_BATCH_CYCLES } from '../src/translator.mjs';
import { CONTEXT_HEADROOM_FRACTION, HISTORY_COST_RATIO_PRIOR } from '../src/translatorBase.mjs';

/** History chunks with the given token costs. */
const chunks = (...tokens) => tokens.map(t => ({ tokens: t }));

function makeTranslator(useFullContext) {
    return new Translator({ from: 'English', to: 'Finnish' }, { openai: null }, { useFullContext });
}

test('context window: includes everything under budget, last chunk only when disabled', () => {
    const t = makeTranslator(1000);
    const all = chunks(100, 100, 100);
    assert.deepEqual(t.selectContextChunks(all), { includedChunks: all, tokenCount: 300 });
    assert.equal(t.contextAnchor, 0);
    assert.deepEqual(makeTranslator(0).selectContextChunks(all), { includedChunks: all.slice(-1), tokenCount: 0 });
    assert.deepEqual(makeTranslator(1000).selectContextChunks([]), { includedChunks: [], tokenCount: 0 });
});

test('context window: anchor holds still while history grows, within budget, as a contiguous suffix', () => {
    const t = makeTranslator(1000);
    const history = [];
    const anchors = [];
    for (let i = 0; i < 40; i++) {
        history.push({ tokens: 150 });
        const { includedChunks, tokenCount } = t.selectContextChunks(history);
        assert.ok(tokenCount <= 1000, `budget exceeded at step ${i}: ${tokenCount}`);
        assert.deepEqual(includedChunks, history.slice(history.length - includedChunks.length));
        assert.ok(t.contextAnchor >= (anchors.at(-1) ?? 0), `anchor regressed at step ${i}`);
        anchors.push(t.contextAnchor);
    }
    // the anchor only jumps on overflow, so it holds the same value across several batches
    assert.ok(new Set(anchors).size < anchors.length / 2, `anchor moved too often: ${anchors}`);
});

test('context window: overflow trims to the headroom target, keeping an oversized chunk', () => {
    const t = makeTranslator(1000);
    const { tokenCount } = t.selectContextChunks(chunks(200, 200, 200, 200, 200, 200));
    assert.ok(tokenCount <= 1000 && tokenCount >= 1000 * CONTEXT_HEADROOM_FRACTION, `trimmed to ${tokenCount}`);
    // a chunk larger than the headroom target is kept rather than trimming down to the tail
    const coarse = chunks(2900, 2900, 567);
    assert.deepEqual(makeTranslator(4000).selectContextChunks(coarse), { includedChunks: coarse.slice(1), tokenCount: 3467 });
});

test('history chunks: one byte-stable pair per batch as sent, flagged entries masked', () => {
    const t = makeTranslator(4000);
    t.workingLines = ['a', 'b', 'c', 'd', 'e'];
    t.moderatorFlags.set(1, { remarks: 'Label Mismatch' });
    const first = ['1. a', '2. b', '3. c'];
    [...t.yieldOutput(first, ['1. x', '2. y', '3. z'])];
    const firstMessages = structuredClone(t.historyChunks[0].messages);
    [...t.yieldOutput(['4. d', '5. e'], ['4. w', '5. v'])];

    assert.deepEqual(t.historyChunks.map(c => c.size), [3, 2]);
    assert.deepEqual(t.historyChunks[0].messages, firstMessages, 'earlier chunk reshaped by a later batch');
    assert.equal(firstMessages[0].content, ['1. a', '2. -', '3. c'].join('\n\n'), 'user content must match the prompt as sent');
    assert.equal(firstMessages[1].role, 'assistant');
    t.buildContext();
    assert.deepEqual(t.promptContext, t.historyChunks.flatMap(c => c.messages));
});

test('history chunks: resumed progress is recorded in batches on first context build', () => {
    const t = makeTranslator(2000);
    t.workingLines = Array.from({ length: 60 }, (_, i) => `resumed subtitle line ${i}`);
    for (let i = 0; i < 60; i++) {
        t.workingProgress.push({ source: `${i + 1}. resumed subtitle line ${i}`, transform: `${i + 1}. rivi ${i}` });
    }
    t.buildContext();
    assert.equal(t.historyLength, 60);
    assert.ok(t.historyChunks.length > 1, 'resumed history must be split into batch-sized chunks');
    assert.ok(t.promptContext.length > 0);
});

test('dynamic batch budget: derived from the cache window span and the measured history cost ratio', () => {
    const t = makeTranslator(6000);
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    assert.equal(t.dynamicBatchBudget, Math.floor(6000 * (1 - CONTEXT_HEADROOM_FRACTION) / CACHE_WINDOW_BATCH_CYCLES / HISTORY_COST_RATIO_PRIOR));
    const priorSize = t.computeDynamicBatchSize(lines, 0);
    // recorded history costing 4x its input tokens halves the budget against the 2x prior
    t.historyChunks.push({ messages: [], size: 10, tokens: 400, inputTokens: 100 });
    assert.equal(t.historyCostRatio, 4);
    assert.equal(t.dynamicBatchBudget, Math.floor(6000 * (1 - CONTEXT_HEADROOM_FRACTION) / CACHE_WINDOW_BATCH_CYCLES / 4));
    assert.ok(t.computeDynamicBatchSize(lines, 0) < priorSize);
});
