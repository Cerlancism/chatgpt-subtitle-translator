//@ts-check
import fs from 'node:fs'
import { parser, secondsToTimestamp, splitStringByNumberLabel } from "../src/subtitle.mjs";

const srtString = "1\n00:00:00,000 --> 00:00:02,000\nHello, world!\n";
const parsedSrt = parser.fromSrt(srtString)

parsedSrt[0].id = "100"
console.log(parser.toSrt(parsedSrt))

// const srt = fs.readFileSync("test/test_jpn.srt", 'utf-8').toString()
// const parsed = parser.fromSrt(srt)

// console.log(parsed.map(x => splitStringByNumberLabel(x.text).text).join("\n"));
// console.log(secondsToTimestamp(72.345)); // "00:01:12.345"
// console.log(secondsToTimestamp(3661.987)); // "01:01:01.987"
// console.log(secondsToTimestamp(5.678)); // "00:00:05.678"
