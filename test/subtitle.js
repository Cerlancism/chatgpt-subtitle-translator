//@ts-check

import { srtFileToNumberLabledLines, srtToNumberLabledLines, parser, splitStringByNumberLabel } from "../src/subtitle.js";
import fs from 'fs'

// const srtString = "1\n00:00:00,000 --> 00:00:02,000\nHello, world!\n";
// const parsedSrt = srtToLines(srtString)

const srt = fs.readFileSync("test/test_jpn.srt", 'utf-8').toString()
const parsed = parser.fromSrt(srt)

console.log(parsed.map(x => splitStringByNumberLabel(x.text).text).join("\n"));
