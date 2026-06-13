import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TranslatorAgent } from '../src/translatorAgent.mjs';

process.env.OPENAI_API_KEY ??= 'test-key';

const {
    getAgentSummaryFile,
    loadAgentSummary,
    saveAgentSummary,
} = await import('../cli/translator.mjs');

function makeInputFile() {
    const dir = mkdtempSync(join(tmpdir(), 'agent-summary-cache-'));
    const input = join(dir, 'movie.en.srt');
    writeFileSync(input, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
    return input;
}

function makeCacheInputs(input) {
    return {
        opts: {
            input,
            from: 'English',
            to: 'Finnish',
            systemInstruction: 'Translate English to Finnish',
        },
        options: /** @type {Partial<import('../src/translator.mjs').TranslatorOptions>} */ ({
            structuredMode: 'array',
            createChatCompletionRequest: { model: 'fake-model' },
        }),
    };
}

test('agent summary cache saves and reloads compatible sidecar', () => {
    const input = makeInputFile();
    const { opts, options } = makeCacheInputs(input);

    saveAgentSummary(opts, options, {
        contextSummary: 'cached movie summary',
        finalInstruction: 'final instruction',
    });

    const summaryFile = getAgentSummaryFile(input);
    const payload = JSON.parse(readFileSync(summaryFile, 'utf-8'));

    assert.equal(summaryFile, `${input}.agent-summary.json`);
    assert.equal(payload.contextSummary, 'cached movie summary');
    assert.equal(payload.finalInstruction, 'final instruction');
    assert.equal(loadAgentSummary(opts, options), 'cached movie summary');
});

test('agent summary cache rejects stale sidecar when prompt metadata changes', () => {
    const input = makeInputFile();
    const { opts, options } = makeCacheInputs(input);

    saveAgentSummary(opts, options, {
        contextSummary: 'cached movie summary',
        finalInstruction: 'final instruction',
    });

    assert.equal(loadAgentSummary({
        ...opts,
        systemInstruction: 'Translate English to Finnish more formally',
    }, options), undefined);

    assert.equal(loadAgentSummary({
        ...opts,
        to: 'Swedish',
    }, options), undefined);

    assert.equal(loadAgentSummary(opts, {
        ...options,
        createChatCompletionRequest: { model: 'different-model' },
    }), undefined);

    assert.equal(loadAgentSummary(opts, {
        ...options,
        useFullContext: 4000,
    }), undefined);
});

test('agent summary cache save failures do not throw', () => {
    const input = makeInputFile();
    const { opts, options } = makeCacheInputs(input);
    unlinkSync(input);

    assert.doesNotThrow(() => {
        saveAgentSummary(opts, options, {
            contextSummary: 'cached movie summary',
            finalInstruction: 'final instruction',
        });
    });
});

test('agent planning emits reusable context summary callback', async () => {
    let saved = null;
    const delegate = /** @type {any} */ ({
        systemInstruction: 'Translate English to Finnish',
        translateLines: async function* () { },
    });
    const agent = new TranslatorAgent({ from: 'English', to: 'Finnish' }, {
        openai: null,
        onAgentPlanningResult: (result) => { saved = result; },
    }, {
        createChatCompletionRequest: { model: 'fake-model', stream: false },
        useFullContext: 2000,
    }, delegate);

    const testAgent = /** @type {any} */ (agent);
    testAgent._runOverviewPass = async () => ({ overview: 'overview', agentInstruction: 'scan carefully' });
    testAgent.runPlanningPass = async () => ({
        finalInstruction: 'final instruction',
        contextSummary: 'cached movie summary',
    });
    testAgent._verifyLanguageWithSample = async () => { };

    await testAgent._planAndVerify([
        { start: '00:00:00,000', end: '00:00:01,000', text: 'Hello' },
    ], ['Hello']);

    assert.deepEqual(saved, {
        contextSummary: 'cached movie summary',
        finalInstruction: 'final instruction',
    });
    assert.equal(delegate.systemInstruction, 'final instruction');
});
