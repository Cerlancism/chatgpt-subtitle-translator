import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TranslatorStructuredArray } from '../src/translatorStructuredArray.mjs';
import { TranslatorStructuredTimestamp } from '../src/translatorStructuredTimestamp.mjs';

function makeRunner() {
    const runner = /** @type {any} */ (new EventEmitter());
    runner.controller = { abort() { } };
    return runner;
}

/**
 * @param {() => void | Promise<void>} fn
 */
async function captureProcessErrors(fn) {
    const errors = [];
    const onError = (/** @type {unknown} */ error) => {
        errors.push(error);
    };
    process.prependListener('uncaughtException', onError);
    process.prependListener('unhandledRejection', onError);
    try {
        await fn();
        await setImmediate();
    } finally {
        process.removeListener('uncaughtException', onError);
        process.removeListener('unhandledRejection', onError);
    }
    return errors;
}

test('structured array stream parser ignores late content delta after done', async () => {
    const chunks = [];
    let clearCount = 0;
    const translator = new TranslatorStructuredArray({ from: 'English', to: 'Finnish' }, {
        openai: null,
        onStreamChunk: (data) => chunks.push(data),
        onClearLine: () => { clearCount++ },
    }, {
        createChatCompletionRequest: { model: 'fake', stream: true },
        logLevel: 'silent',
    });
    const runner = makeRunner();

    const errors = await captureProcessErrors(() => {
        translator.jsonStreamParse(runner);
        runner.emit('content.delta', { delta: '{"outputs":["Hei"]}' });
        runner.emit('content.done');
        runner.emit('content.delta', { delta: ' late data' });
        runner.emit('content.done');
    });

    assert.deepEqual(errors, []);
    assert.ok(chunks.some(chunk => chunk.includes('Hei')));
    assert.ok(!chunks.some(chunk => chunk.includes('late data')));
    assert.equal(clearCount, 2);
});

test('structured timestamp stream parser ignores late content delta after done', async () => {
    const chunks = [];
    const translator = new TranslatorStructuredTimestamp({ from: 'English', to: 'Finnish' }, {
        openai: null,
        onStreamChunk: (data) => chunks.push(data),
    }, {
        createChatCompletionRequest: { model: 'fake', stream: true },
        logLevel: 'silent',
    });
    const runner = makeRunner();

    const errors = await captureProcessErrors(() => {
        translator.jsonStreamParse(runner);
        runner.emit('content.delta', { delta: '{"outputs":[{"start":0,"end":1000,"text":"Hei"}]}' });
        runner.emit('content.done');
        runner.emit('content.delta', { delta: ' late data' });
        runner.emit('content.done');
    });

    assert.deepEqual(errors, []);
    assert.ok(chunks.some(chunk => chunk.includes('Hei')));
    assert.ok(!chunks.some(chunk => chunk.includes('late data')));
});
