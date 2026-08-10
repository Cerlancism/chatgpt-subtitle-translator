import test from 'node:test';
import assert from 'node:assert';

import {
    subtitleParser,
    detectSubtitleFormat,
    isSubtitleFile,
    subtitleFormatFromFileName,
    getSubtitleFormat,
    convertToSrt,
    convertFromSrt,
    subtitleHeader,
    formatSubtitleCue,
    cueFromSrtEntry
} from "../src/main.mjs";

const srtSample = "1\r\n00:00:01,000 --> 00:00:03,500\r\nFirst line\r\n\r\n"
    + "2\r\n00:00:04,000 --> 00:00:06,000\r\nSecond line one\r\nSecond line two\r\n\r\n"

const vttSample = `WEBVTT

NOTE a comment block that is not a cue

intro
00:00:01.000 --> 00:00:03.500 align:start position:10%
<v Speaker>First &amp; only</v>

00:00:04.000 --> 00:00:06.000
Second <b>line</b> one
Second line two

STYLE
::cue { color: peachpuff; }

00:00:07.250 --> 00:00:09.000
<00:00:07.500>Third line
`

const assSample = `[Script Info]
Title: Fixture
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,48

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}First, with a comma{\\i0}
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Second line one\\NSecond line two
Comment: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Commented out
Dialogue: 0,0:00:07.25,0:00:09.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Third\\hline
`

test('detects format from the file extension', () => {
    assert.strictEqual(detectSubtitleFormat("", "movie.srt"), "srt")
    assert.strictEqual(detectSubtitleFormat("", "movie.vtt"), "vtt")
    assert.strictEqual(detectSubtitleFormat("", "movie.ass"), "ass")
    assert.strictEqual(detectSubtitleFormat("", "movie.ssa"), "ass")
    assert.strictEqual(detectSubtitleFormat("", "MOVIE.VTT"), "vtt")
})

test('detects format from the content when the extension is not conclusive', () => {
    assert.strictEqual(detectSubtitleFormat(vttSample), "vtt")
    assert.strictEqual(detectSubtitleFormat(assSample), "ass")
    assert.strictEqual(detectSubtitleFormat(srtSample), "srt")
    assert.strictEqual(detectSubtitleFormat(vttSample, "movie.txt"), "vtt")
})

test('recognises subtitle file names', () => {
    assert.ok(isSubtitleFile("movie.srt"))
    assert.ok(isSubtitleFile("movie.ssa"))
    assert.ok(!isSubtitleFile("movie.txt"))
    assert.ok(!isSubtitleFile("movie"))
    assert.strictEqual(subtitleFormatFromFileName("movie.vtt")?.id, "vtt")
    assert.strictEqual(subtitleFormatFromFileName("movie.txt"), undefined)
    assert.strictEqual(getSubtitleFormat("ass").extension, ".ass")
    assert.strictEqual(getSubtitleFormat("unknown").id, "srt", "unknown ids fall back to srt")
})

test('converts WebVTT to SRT, dropping cue markup and non cue blocks', () => {
    const srt = convertToSrt(vttSample, "vtt")
    const entries = subtitleParser.fromSrt(srt)

    assert.strictEqual(entries.length, 3)
    assert.deepStrictEqual(entries.map(x => x.text), [
        "First & only",
        // <b>, <i> and <u> are shared with SRT, so they are kept
        "Second <b>line</b> one\nSecond line two",
        "Third line",
    ])
    assert.strictEqual(entries[0].startTime, "00:00:01,000")
    assert.strictEqual(entries[0].endTime, "00:00:03,500", "cue settings after the end timestamp are ignored")
    assert.strictEqual(entries[2].startTime, "00:00:07,250")
})

test('converts ASS to SRT, skipping comments and drawings', () => {
    const srt = convertToSrt(assSample, "ass")
    const entries = subtitleParser.fromSrt(srt)

    assert.strictEqual(entries.length, 3, "the comment event and the vector drawing are not entries")
    assert.deepStrictEqual(entries.map(x => x.text), [
        "First, with a comma",
        "Second line one\nSecond line two",
        "Third line",
    ])
    assert.strictEqual(entries[0].startTime, "00:00:01,000")
    assert.strictEqual(entries[2].endTime, "00:00:12,000")
})

test('honours a per file ASS event field order', () => {
    const reordered = `[Events]
Format: Start, End, Text
Dialogue: 0:00:02.00,0:00:04.00,Reordered fields
`
    const entries = subtitleParser.fromSrt(convertToSrt(reordered, "ass"))
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0].text, "Reordered fields")
    assert.strictEqual(entries[0].startTime, "00:00:02,000")
})

test('converting content without entries reports the format', () => {
    assert.throws(() => convertToSrt("WEBVTT\n\n", "vtt"), /WebVTT/)
    assert.throws(() => convertToSrt("[Events]\n", "ass"), /ASS\/SSA/)
})

test('SRT conversions are pass through', () => {
    assert.strictEqual(convertToSrt(srtSample, "srt"), srtSample)
    assert.strictEqual(convertFromSrt(srtSample, "srt"), srtSample)
})

test('converts SRT to WebVTT', () => {
    const vtt = convertFromSrt(srtSample, "vtt")

    assert.ok(vtt.startsWith("WEBVTT\r\n\r\n"))
    assert.ok(vtt.includes("00:00:01.000 --> 00:00:03.500"), "milliseconds are dot separated")
    assert.ok(vtt.includes("Second line one\r\nSecond line two"))
})

test('converts SRT to ASS', () => {
    const ass = convertFromSrt(srtSample, "ass")

    assert.ok(ass.includes("[Script Info]"))
    assert.ok(ass.includes("[V4+ Styles]"))
    assert.ok(ass.includes("[Events]"))
    assert.ok(ass.includes("Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,First line"))
    assert.ok(ass.includes("Second line one\\NSecond line two"), "line breaks use the ASS escape")
})

test('round trips every format back to the same SRT', () => {
    for (const format of /** @type {const} */(["vtt", "ass"])) {
        const converted = convertFromSrt(srtSample, format)
        assert.strictEqual(convertToSrt(converted, format), srtSample, `${format} round trip`)
    }
})

test('streaming a file entry by entry matches a whole file conversion', () => {
    for (const format of /** @type {const} */(["srt", "vtt", "ass"])) {
        const entries = subtitleParser.fromSrt(srtSample)
        let streamed = subtitleHeader(format)
        for (let index = 0; index < entries.length; index++) {
            streamed += formatSubtitleCue(format, cueFromSrtEntry(entries[index]), index + 1)
        }
        assert.strictEqual(streamed, convertFromSrt(srtSample, format), `${format} streaming`)
    }
})
