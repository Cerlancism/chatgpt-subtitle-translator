import test from 'node:test';
import assert from 'node:assert/strict';

import { Translator } from '../src/translator.mjs';

/** Chunks are plain numbers; cost is the number itself. */
const cost = (c) => c;

function makeTranslator(useFullContext) {
    return new Translator({ from: 'English', to: 'Finnish' }, { openai: null }, { useFullContext });
}

test('context window: includes all chunks while under budget (anchor stays 0)', () => {
    const t = makeTranslator(1000);
    const { includedChunks, tokenCount } = t.selectContextChunks([100, 100, 100], cost);
    assert.deepEqual(includedChunks, [100, 100, 100]);
    assert.equal(tokenCount, 300);
    assert.equal(t.contextAnchor, 0);
});

test('context window: budget disabled keeps only the most recent chunk', () => {
    const t = makeTranslator(0);
    const { includedChunks, tokenCount } = t.selectContextChunks([100, 200, 300], cost);
    assert.deepEqual(includedChunks, [300]);
    assert.equal(tokenCount, 0);
});

test('context window: empty chunks yields empty context', () => {
    const t = makeTranslator(1000);
    const { includedChunks, tokenCount } = t.selectContextChunks([], cost);
    assert.deepEqual(includedChunks, []);
    assert.equal(tokenCount, 0);
});

test('context window: anchor is stable across growing history (no per-batch slide)', () => {
    const t = makeTranslator(1000);
    const chunks = [];
    // grow history one chunk at a time; record anchor after each selection
    const anchors = [];
    for (let i = 0; i < 12; i++) {
        chunks.push(200);
        t.selectContextChunks(chunks, cost);
        anchors.push(t.contextAnchor);
    }
    // anchor must be monotonically non-decreasing (prefix-stable between jumps)
    for (let i = 1; i < anchors.length; i++) {
        assert.ok(anchors[i] >= anchors[i - 1], `anchor regressed at step ${i}: ${anchors}`);
    }
    // anchor must hold still between jumps: fewer distinct values than steps
    const distinct = new Set(anchors).size;
    assert.ok(distinct < anchors.length / 2, `anchor moved too often: ${anchors}`);
});

test('context window: overflow jumps anchor and lands within [headroom, budget]', () => {
    const t = makeTranslator(1000);
    // 6 chunks of 200 = 1200 > 1000 budget
    const chunks = [200, 200, 200, 200, 200, 200];
    const { includedChunks, tokenCount } = t.selectContextChunks(chunks, cost);
    assert.ok(tokenCount <= 1000, 'budget respected');
    assert.ok(tokenCount >= 500, 'does not shed below headroom target');
    assert.ok(includedChunks.length >= 1, 'keeps at least most recent chunk');
    // window is a contiguous suffix ending at the latest chunk
    assert.deepEqual(includedChunks, chunks.slice(chunks.length - includedChunks.length));
});

test('context window: coarse chunks larger than headroom do not collapse the window', () => {
    // regression: chunk cost > maxTokens/2 must not shed down to the partial chunk only
    const t = makeTranslator(4000);
    const chunks = [2900, 2900, 567];
    const { includedChunks, tokenCount } = t.selectContextChunks(chunks, cost);
    assert.deepEqual(includedChunks, [2900, 567]);
    assert.equal(tokenCount, 3467);
});

test('context window: dynamic-mode context chunk size is constant across batch size changes', () => {
    const t = makeTranslator(4000); // no batchSizes -> dynamic mode
    const first = t.contextChunkSize;
    t.currentBatchSize = 83;
    assert.equal(t.contextChunkSize, first);
    t.currentBatchSize = 37;
    assert.equal(t.contextChunkSize, first);
    assert.ok(first > 0);
});

test('context window: never exceeds budget across a long run', () => {
    const t = makeTranslator(1000);
    const chunks = [];
    for (let i = 0; i < 50; i++) {
        chunks.push(150);
        const { tokenCount, includedChunks } = t.selectContextChunks(chunks, cost);
        assert.ok(tokenCount <= 1000, `budget exceeded at step ${i}: ${tokenCount}`);
        assert.ok(includedChunks.length >= 1, `context lost at step ${i}`);
        assert.deepEqual(includedChunks, chunks.slice(chunks.length - includedChunks.length),
            'window must be a contiguous suffix of history');
    }
});

test('context window: single oversized chunk is still included', () => {
    const t = makeTranslator(100);
    const { includedChunks } = t.selectContextChunks([5000], cost);
    assert.deepEqual(includedChunks, [5000]);
});

test('context window: oversized latest chunk alone survives overflow', () => {
    const t = makeTranslator(100);
    const { includedChunks } = t.selectContextChunks([50, 50, 5000], cost);
    assert.deepEqual(includedChunks, [5000]);
});

test('context window: anchor clamps and refills when chunk count shrinks (boundary shift)', () => {
    const t = makeTranslator(1000);
    // drive anchor forward with many small chunks
    const many = Array.from({ length: 20 }, () => 150);
    t.selectContextChunks(many, cost);
    assert.ok(t.contextAnchor > 0);
    // simulate chunk boundaries reshaping into fewer, larger chunks
    const fewer = [300, 300, 300];
    const { includedChunks, tokenCount } = t.selectContextChunks(fewer, cost);
    assert.ok(tokenCount <= 1000);
    assert.ok(includedChunks.length >= 1);
    // clamped refill: should recover up to the full budget, not stay clamped at 1 chunk
    assert.deepEqual(includedChunks, [300, 300, 300]);
    assert.equal(tokenCount, 900);
});

test('context window: no oscillation after a jump (anchor does not creep back)', () => {
    const t = makeTranslator(1000);
    const chunks = Array.from({ length: 10 }, () => 200);
    t.selectContextChunks(chunks, cost);
    const afterJump = t.contextAnchor;
    assert.ok(afterJump > 0);
    // immediate re-selection with identical history must not move the anchor
    t.selectContextChunks(chunks, cost);
    assert.equal(t.contextAnchor, afterJump);
});

test('dynamic batch cap: engages once context cost per entry is measured', () => {
    const t = makeTranslator(4000);
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const uncapped = t.computeDynamicBatchSize(lines, 0);
    t.contextCostPerEntry = 31; // ~measured per-entry context tokens
    const capped = t.computeDynamicBatchSize(lines, 0);
    // growth budget = 4000/2/3 = 666 tokens -> cap = floor(666/31) = 21
    assert.equal(capped, 21);
    assert.ok(capped < uncapped, `expected cap below uncapped size ${uncapped}`);
});

test('dynamic batch cap: inactive before first context build (cold start)', () => {
    const t = makeTranslator(4000);
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    assert.equal(t.contextCostPerEntry, 0);
    const size = t.computeDynamicBatchSize(lines, 0);
    assert.ok(size > 21, `cold-start batch should be uncapped, got ${size}`);
});

test('dynamic batch cap: no effect when context budget is generous', () => {
    const t = makeTranslator(24000);
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const uncapped = t.computeDynamicBatchSize(lines, 0);
    t.contextCostPerEntry = 31; // cap = floor(24000/2/3/31) = 129
    const capped = t.computeDynamicBatchSize(lines, 0);
    assert.equal(capped, Math.min(uncapped, 129));
});

test('dynamic batch cap: never below AUTO_BATCH_MIN', () => {
    const t = makeTranslator(4000);
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    t.contextCostPerEntry = 100000; // absurd cost -> raw cap would be 0
    const size = t.computeDynamicBatchSize(lines, 0);
    assert.ok(size >= 3, `size ${size} must respect AUTO_BATCH_MIN`);
});

test('context cost per entry: measured by logContextSelection', () => {
    const t = makeTranslator(4000);
    t.logContextSelection(50, 100, 1550);
    assert.equal(t.contextCostPerEntry, 31);
    // budget disabled: no measurement
    const t2 = makeTranslator(0);
    t2.logContextSelection(50, 100, 1550);
    assert.equal(t2.contextCostPerEntry, 0);
});
