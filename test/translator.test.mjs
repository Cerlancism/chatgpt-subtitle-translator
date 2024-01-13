import fs from 'node:fs';

import test from 'node:test';
import assert from 'node:assert';

import { parser } from '../src/subtitle.mjs';
import { Translator } from '../src/translator.mjs';
import { wrapQuotes } from '../src/helpers.mjs';

test('should output subtitles', async () =>
{
    const fileContent = fs.readFileSync('./test/data/test_ja_small.srt', 'utf-8')
    const srtParsed = parser.fromSrt(fileContent).map(x => x.text);

    const translator = new Translator({ from: "Japanese", to: "Chinese zh-cn" }, {
        createChatCompletionRequest: {
            temperature: 0
        },
        batchSizes: [2, 3],
    });

    const outputsLines = []

    for await (const output of translator.translateLines(srtParsed))
    {
        console.log(output.index, wrapQuotes(output.source), "->", wrapQuotes(output.transform))
        outputsLines.push(output)
        // Here you can add assertions to check the translation output
        // For example, assert that the output is not null, or matches expected values
        assert.notStrictEqual(output.transform, null, 'Translation output should not be null');
        // Add more specific assertions as per your test requirements
    }

    assert.strictEqual(srtParsed.length, outputsLines.length, "Translation Lines should be equal");
});