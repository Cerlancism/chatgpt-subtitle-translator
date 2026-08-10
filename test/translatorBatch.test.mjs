import test from 'node:test';
import assert from 'node:assert/strict';

import { Translator, AUTO_BATCH_MIN } from '../src/translator.mjs';

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
