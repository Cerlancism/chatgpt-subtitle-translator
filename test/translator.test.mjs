import fs from 'node:fs';

import test from 'node:test';
import assert from 'node:assert';

import { subtitleParser, Translator, CooldownContext, createOpenAIClient } from '../src/main.mjs';
import { wrapQuotes } from '../src/helpers.mjs';

import 'dotenv/config'
import { TranslatorStructuredArray } from '../src/translatorStructuredArray.js';
const openai = createOpenAIClient(process.env.OPENAI_API_KEY)
const coolerChatGPTAPI = new CooldownContext(2, 2000, "ChatGPTAPI")
const coolerOpenAIModerator = new CooldownContext(2, 2000, "OpenAIModerator")

test('should output subtitles', async () =>
{
    const fileContent = fs.readFileSync('./test/data/test_ja_small.srt', 'utf-8')
    const srtParsed = subtitleParser.fromSrt(fileContent).map(x => x.text);

    const translator = new TranslatorStructuredArray({ from: "Japanese", to: "Chinese zh-cn" }, {
        cooler: coolerChatGPTAPI,
        openai,
        onStreamChunk: (data) => process.stdout.write(data),
        onStreamEnd: () => process.stdout.write("\n"),
        moderationService: {
            cooler: coolerOpenAIModerator,
            openai,
        }
    }, {
        createChatCompletionRequest: {
            temperature: 0,
            stream: true
        },
        batchSizes: [2, 3],
    });

    const outputsLines = []

    for await (const output of translator.translateLines(srtParsed))
    {
        console.log(output.index, wrapQuotes(output.source), "->", wrapQuotes(output.transform))
        outputsLines.push(output)
        assert.notStrictEqual(output.transform, null, 'Translation output should not be null');
    }

    assert.strictEqual(srtParsed.length, outputsLines.length, "Translation Lines should be equal");
});
