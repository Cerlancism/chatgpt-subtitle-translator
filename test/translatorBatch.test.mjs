import test from 'node:test';
import assert from 'node:assert/strict';

import { Translator, AUTO_BATCH_MIN, AUTO_BATCH_MAX, computeEvenBatchSize } from '../src/translator.mjs';

test('dynamic batch reduction falls back to minimum batch size when budget rounds to zero', () => {
    const translator = new Translator({ from: 'English', to: 'Finnish' }, { openai: null }, {
        useFullContext: 2000,
    });
    const lines = Array.from({ length: 1476 }, (_, index) => `Subtitle line ${index}`);

    const batchSize = translator.computeDynamicBatchSize(lines, 272, Number.MAX_SAFE_INTEGER);

    assert.equal(batchSize, AUTO_BATCH_MIN);
});

test('dynamic batch reduction does not exceed remaining line count', () => {
    const translator = new Translator({ from: 'English', to: 'Finnish' }, { openai: null }, {
        useFullContext: 2000,
    });
    const lines = ['one', 'two'];

    const batchSize = translator.computeDynamicBatchSize(lines, 0, Number.MAX_SAFE_INTEGER);

    assert.equal(batchSize, 2);
});

test('dynamic batch size is capped at AUTO_BATCH_MAX and evened under the cap', () => {
    const weights = Array(250).fill(10);
    // huge token budget: the cap alone bounds the batch, and the remainder is spread evenly
    assert.equal(computeEvenBatchSize(weights, 0, 1_000_000), 83);
    assert.equal(computeEvenBatchSize(weights, 83, 1_000_000), 83);
    assert.equal(computeEvenBatchSize(weights, 166, 1_000_000), 84);
    // no token limit: same cap-only evening
    assert.equal(computeEvenBatchSize(weights, 0, 0), 83);
    // under the cap, a single batch takes everything
    assert.equal(computeEvenBatchSize(weights, 200, 0), 50);
    // the token budget still wins when it is the tighter limit
    assert.equal(computeEvenBatchSize(weights, 0, 500), 50);
    // the translator walks the whole file without ever exceeding the cap
    const translator = new Translator({ from: 'English', to: 'Finnish' }, { openai: null }, { useFullContext: 1_000_000 });
    const lines = Array.from({ length: 1000 }, (_, i) => `Subtitle line ${i}`);
    const sizes = [];
    for (let index = 0; index < lines.length;) {
        const size = translator.computeDynamicBatchSize(lines, index);
        assert.ok(size > 0 && size <= AUTO_BATCH_MAX, `batch of ${size} at ${index}`);
        sizes.push(size);
        index += size;
    }
    assert.equal(sizes.reduce((a, b) => a + b, 0), lines.length);
    assert.ok(sizes.every(s => s === 100), `uneven batches: ${sizes}`);
    // context budget disabled: still capped
    const unbounded = new Translator({ from: 'English', to: 'Finnish' }, { openai: null }, { useFullContext: 0 });
    assert.equal(unbounded.computeDynamicBatchSize(lines, 0), 100);
});
