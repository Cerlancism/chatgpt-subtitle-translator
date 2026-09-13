import test from 'node:test';
import assert from 'node:assert';

import { toSrt, getLineEndingOverride, getTextLineEnding } from "../src/subtitle.mjs";

/**
 * Runs `fn` with SUBTITLE_LINE_ENDING set to `value`, restoring it afterwards.
 * @param {string | undefined} value
 * @param {() => void} fn
 */
function withOverride(value, fn) {
    const previous = process.env.SUBTITLE_LINE_ENDING
    if (value === undefined) {
        delete process.env.SUBTITLE_LINE_ENDING
    } else {
        process.env.SUBTITLE_LINE_ENDING = value
    }
    try {
        fn()
    } finally {
        if (previous === undefined) {
            delete process.env.SUBTITLE_LINE_ENDING
        } else {
            process.env.SUBTITLE_LINE_ENDING = previous
        }
    }
}

/** @param {string} text */
function entry(text) {
    return [{
        id: "1",
        startTime: "00:00:00,000",
        startSeconds: 0,
        endTime: "00:00:02,000",
        endSeconds: 2,
        text,
    }]
}

test('defaults to CRLF for SRT when the override is unset', () => {
    withOverride(undefined, () => {
        assert.strictEqual(getLineEndingOverride(), undefined)
        assert.strictEqual(
            toSrt(entry("Hello, world!")),
            "1\r\n00:00:00,000 --> 00:00:02,000\r\nHello, world!\r\n\r\n"
        )
    })
})

test('defaults to LF for plain text output when the override is unset', () => {
    withOverride(undefined, () => {
        assert.strictEqual(getTextLineEnding(), "\n")
    })
})

test('forces LF across SRT output when set to lf', () => {
    withOverride("lf", () => {
        const output = toSrt(entry("Hello, world!"))
        assert.strictEqual(output, "1\n00:00:00,000 --> 00:00:02,000\nHello, world!\n\n")
        assert.ok(!output.includes("\r"), 'no carriage returns should remain')
        assert.strictEqual(getTextLineEnding(), "\n")
    })
})

test('forces CRLF for plain text output when set to crlf', () => {
    withOverride("crlf", () => {
        assert.strictEqual(getTextLineEnding(), "\r\n")
    })
})

test('treats auto, blank and mixed case as unset', () => {
    for (const value of ["auto", "", "  ", "AUTO"]) {
        withOverride(value, () => {
            assert.strictEqual(getLineEndingOverride(), undefined, `${JSON.stringify(value)} should be ignored`)
        })
    }
})

test('accepts case-insensitive and padded values', () => {
    withOverride("  LF  ", () => {
        assert.strictEqual(getLineEndingOverride(), "\n")
    })
})

test('ignores an unrecognised value and keeps the default', () => {
    withOverride("crlfx", () => {
        assert.strictEqual(getLineEndingOverride(), undefined)
        assert.strictEqual(
            toSrt(entry("Hello, world!")),
            "1\r\n00:00:00,000 --> 00:00:02,000\r\nHello, world!\r\n\r\n"
        )
    })
})

test('normalises every break in a multi-line cue, not just the first', () => {
    withOverride(undefined, () => {
        const output = toSrt(entry("one\ntwo\nthree"))
        assert.strictEqual(
            output,
            "1\r\n00:00:00,000 --> 00:00:02,000\r\none\r\ntwo\r\nthree\r\n\r\n"
        )
        assert.ok(!/[^\r]\n/.test(output), 'every LF should be preceded by CR')
    })

    withOverride("lf", () => {
        const output = toSrt(entry("one\ntwo\nthree"))
        assert.strictEqual(output, "1\n00:00:00,000 --> 00:00:02,000\none\ntwo\nthree\n\n")
        assert.ok(!output.includes("\r"), 'no carriage returns should remain')
    })
})

test('an explicit lineEnding argument overrides the environment', () => {
    withOverride("crlf", () => {
        assert.strictEqual(
            toSrt(entry("Hello, world!"), "\n"),
            "1\n00:00:00,000 --> 00:00:02,000\nHello, world!\n\n"
        )
    })
})
