//@ts-check
import fs from 'node:fs'
import { parser } from "../src/subtitle.mjs"
import { Translator } from "../src/translator.mjs"
import { wrapQuotes } from "../src/helpers.mjs"

const fileContent = fs.readFileSync('./test/data/test_ja_small.srt', 'utf-8')
const srtParsed = parser.fromSrt(fileContent).map(x => x.text)

const translator = new Translator({ from: "Japanese", to: "Chinese zh-cn" }, {
    createChatCompletionRequest: {
        temperature: 0
    },
    batchSizes: [2, 3],
})

for await (const output of translator.translateLines(srtParsed))
{
    console.log(output.index, wrapQuotes(output.source), "->", wrapQuotes(output.transform))
}