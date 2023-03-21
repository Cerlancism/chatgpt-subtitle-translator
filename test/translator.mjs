//@ts-check
import { lineLabeler, parser } from "../src/subtitle.mjs"
import { Translator } from "../src/translator.mjs"
import fs from 'node:fs'
import { wrapQuotes } from "../src/helpers.mjs"

const fileContent = fs.readFileSync('./test/data/test_ja.srt', 'utf-8')
const srtParsed = parser.fromSrt(fileContent).map(x => x.text)

const translator = new Translator({ from: "Japanese", to: "Chinese zh-cn" }, { batchSizes: [2, 10], createChatCompletionRequest: { temperature: 0.2 } })

for await (const output of translator.translateLines(srtParsed))
{
    console.log(output.index, wrapQuotes(output.source), "->", wrapQuotes(output.transform))
}