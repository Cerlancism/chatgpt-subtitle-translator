import log from "loglevel"

import { parser, millisecondsToTimestamp, offsetSrt } from "./subtitle.mjs"

/**
 * Subtitle format conversions.
 *
 * The translation pipeline works on SRT, so files of other formats are
 * converted to SRT on the way in and converted back on the way out. Only the
 * timing and the text content survive a conversion, styling and positioning
 * information that SRT cannot represent is dropped.
 *
 * @typedef {"srt" | "vtt" | "ass"} SubtitleFormatId
 */

/**
 * @typedef SubtitleFormat
 * @property {SubtitleFormatId} id
 * @property {string} label
 * @property {string} extension Default extension used for output files
 * @property {string[]} extensions All extensions recognised as this format
 */

/** @type {SubtitleFormat[]} */
export const subtitleFormats = [
    { id: "srt", label: "SRT", extension: ".srt", extensions: [".srt"] },
    { id: "vtt", label: "WebVTT", extension: ".vtt", extensions: [".vtt"] },
    { id: "ass", label: "ASS/SSA", extension: ".ass", extensions: [".ass", ".ssa"] },
]

const endOfLine = "\r\n"

/**
 * @typedef SubtitleCue
 * @property {number} start milliseconds
 * @property {number} end milliseconds
 * @property {string} text
 */

/**
 * @param {SubtitleFormatId | string} id
 * @returns {SubtitleFormat}
 */
export function getSubtitleFormat(id) {
    return subtitleFormats.find(x => x.id === id) ?? subtitleFormats[0]
}

/**
 * True when the file name carries an extension of a subtitle format that is
 * understood, so callers can tell subtitle files from plain text files.
 * @param {string} fileName
 */
export function isSubtitleFile(fileName) {
    return subtitleFormatFromFileName(fileName) !== undefined
}

/**
 * The format a file name's extension denotes, or undefined when the extension
 * is not one of the supported subtitle formats.
 * @param {string} fileName
 * @returns {SubtitleFormat | undefined}
 */
export function subtitleFormatFromFileName(fileName) {
    const extension = fileName.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1]
    if (!extension) {
        return undefined
    }
    return subtitleFormats.find(x => x.extensions.includes(extension))
}

/** @param {string} text */
function normalizeNewlines(text) {
    return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n")
}

/**
 * Parses the `HH:MM:SS,mmm`, `H:MM:SS.cc` and `MM:SS.mmm` timestamp shapes used
 * across the supported formats.
 * @param {string} timestamp
 * @returns {number | null} milliseconds, or null when unparseable
 */
function parseTimestamp(timestamp) {
    const matches = timestamp.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/)
    if (!matches) {
        return null
    }
    const [, hours, minutes, seconds, fraction] = matches
    return Number(hours ?? 0) * 3600000
        + Number(minutes) * 60000
        + Number(seconds) * 1000
        + Number(fraction.padEnd(3, "0"))
}

/** @param {number} totalMilliseconds */
function formatVttTimestamp(totalMilliseconds) {
    return millisecondsToTimestamp(Math.max(0, Math.round(totalMilliseconds))).replace(",", ".")
}

/**
 * ASS timestamps carry centiseconds and a single hour digit.
 * @param {number} totalMilliseconds
 */
function formatAssTimestamp(totalMilliseconds) {
    const total = Math.max(0, Math.round(totalMilliseconds / 10) * 10)
    const hours = Math.floor(total / 3600000)
    const minutes = Math.floor((total % 3600000) / 60000)
    const seconds = Math.floor((total % 60000) / 1000)
    const centiseconds = Math.floor((total % 1000) / 10)
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${centiseconds.toString().padStart(2, "0")}`
}

/**
 * Splits a comma delimited line into at most `count` fields, keeping every
 * remaining comma inside the last field, as ASS event text may contain commas.
 * @param {string} value
 * @param {number} count
 */
function splitFields(value, count) {
    const fields = []
    let rest = value
    for (let i = 0; i < count - 1; i++) {
        const index = rest.indexOf(",")
        if (index < 0) {
            break
        }
        fields.push(rest.slice(0, index))
        rest = rest.slice(index + 1)
    }
    fields.push(rest)
    return fields
}

/**
 * Detects the format of subtitle content, preferring the file extension and
 * falling back to sniffing the content.
 * @param {string} text
 * @param {string} [fileName]
 * @returns {SubtitleFormatId}
 */
export function detectSubtitleFormat(text, fileName) {
    const byExtension = fileName ? subtitleFormatFromFileName(fileName) : undefined
    if (byExtension) {
        return byExtension.id
    }
    const head = normalizeNewlines(text).slice(0, 1000)
    if (/^WEBVTT/.test(head)) {
        return "vtt"
    }
    if (/^\s*\[(?:Script Info|V4\+? Styles|Events)\]/im.test(head)) {
        return "ass"
    }
    return "srt"
}

/**
 * @param {ReturnType<typeof parser.fromSrt>[number]} entry
 * @returns {SubtitleCue}
 */
export function cueFromSrtEntry(entry) {
    return {
        start: parseTimestamp(entry.startTime) ?? Math.round(entry.startSeconds * 1000),
        end: parseTimestamp(entry.endTime) ?? Math.round(entry.endSeconds * 1000),
        text: entry.text,
    }
}

/**
 * @param {string} srtText
 * @returns {SubtitleCue[]}
 */
function cuesFromSrt(srtText) {
    return parser.fromSrt(srtText).map(cueFromSrtEntry)
}

/**
 * Writes a cue block in the `index`, `start --> end`, text layout shared by SRT
 * and WebVTT.
 * @param {SubtitleCue} cue
 * @param {number | string} index
 * @param {(milliseconds: number) => string} formatTime
 */
function toCueBlock(cue, index, formatTime) {
    return [
        `${index}`,
        `${formatTime(cue.start)} --> ${formatTime(cue.end)}`,
        cue.text.split("\n").join(endOfLine),
        "",
        "",
    ].join(endOfLine)
}

/**
 * Removes cue payload markup that has no SRT equivalent, keeping the basic
 * `<i>`, `<b>` and `<u>` tags both formats share.
 * @param {string} text
 */
function stripVttMarkup(text) {
    return text
        .replace(/<(\d{1,3}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}>/g, "")
        .replace(/<\/?(?!\/?[ibu]\s*>)[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .trim()
}

/**
 * @param {string} vttText
 * @returns {SubtitleCue[]}
 */
function cuesFromVtt(vttText) {
    /** @type {SubtitleCue[]} */
    const cues = []
    for (const block of normalizeNewlines(vttText).split(/\n{2,}/)) {
        const lines = block.split("\n").filter(x => x.trim().length > 0)
        const timingIndex = lines.findIndex(x => x.includes("-->"))
        if (timingIndex < 0) {
            continue
        }
        const [startPart, endPart] = lines[timingIndex].split("-->")
        const start = parseTimestamp(startPart)
        // Cue settings such as `align:start position:10%` trail the end timestamp
        const end = parseTimestamp(endPart?.trim().split(/\s+/)[0] ?? "")
        if (start === null || end === null) {
            continue
        }
        const text = stripVttMarkup(lines.slice(timingIndex + 1).join("\n"))
        if (!text) {
            continue
        }
        cues.push({ start, end, text })
    }
    return cues
}

const assHeaderLines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
]

const assDefaultEventFields = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"]

/**
 * Removes override blocks and drawing commands that have no SRT equivalent, and
 * converts ASS line breaks into plain newlines.
 * @param {string} text
 */
function stripAssMarkup(text) {
    if (/\\p[1-9]/.test(text)) {
        // Vector drawing rather than dialogue, there is nothing to translate
        return ""
    }
    return text
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\[Nn]/g, "\n")
        .replace(/\\h/g, " ")
        .split("\n")
        .map(x => x.trim())
        .filter(x => x.length > 0)
        .join("\n")
}

/**
 * @param {string} assText
 * @returns {SubtitleCue[]}
 */
function cuesFromAss(assText) {
    let eventFields = assDefaultEventFields
    let inEvents = false
    /** @type {SubtitleCue[]} */
    const cues = []
    for (const line of normalizeNewlines(assText).split("\n")) {
        const trimmed = line.trim()
        if (/^\[.*\]$/.test(trimmed)) {
            inEvents = /^\[events\]$/i.test(trimmed)
            continue
        }
        if (!inEvents) {
            continue
        }
        if (/^Format\s*:/i.test(trimmed)) {
            eventFields = trimmed.slice(trimmed.indexOf(":") + 1).split(",").map(x => x.trim())
            continue
        }
        // Comment events are not displayed, so they are not translated either
        if (!/^Dialogue\s*:/i.test(trimmed)) {
            continue
        }
        const values = splitFields(trimmed.slice(trimmed.indexOf(":") + 1).trim(), eventFields.length)
        const entry = Object.fromEntries(eventFields.map((field, i) => [field.toLowerCase(), values[i] ?? ""]))
        const start = parseTimestamp(entry.start ?? "")
        const end = parseTimestamp(entry.end ?? "")
        if (start === null || end === null) {
            continue
        }
        const text = stripAssMarkup(entry.text ?? "")
        if (!text) {
            continue
        }
        cues.push({ start, end, text })
    }
    return cues
}

/**
 * @param {SubtitleCue} cue
 */
function toAssEvent(cue) {
    const text = cue.text.split("\n").map(x => x.trim()).join("\\N")
    return `Dialogue: 0,${formatAssTimestamp(cue.start)},${formatAssTimestamp(cue.end)},Default,,0,0,0,,${text}`
}

/**
 * Leading content a file of this format needs before any cue, empty for SRT.
 * Lets output be streamed entry by entry.
 * @param {SubtitleFormatId} format
 */
export function subtitleHeader(format) {
    if (format === "vtt") {
        return `WEBVTT${endOfLine}${endOfLine}`
    }
    if (format === "ass") {
        return assHeaderLines.join(endOfLine) + endOfLine
    }
    return ""
}

/**
 * Serialises a single cue in the given format, for appending after
 * {@link subtitleHeader}.
 * @param {SubtitleFormatId} format
 * @param {SubtitleCue} cue
 * @param {number | string} index entry number, used by the indexed formats
 */
export function formatSubtitleCue(format, cue, index) {
    if (format === "vtt") {
        return toCueBlock(cue, index, formatVttTimestamp)
    }
    if (format === "ass") {
        return toAssEvent(cue) + endOfLine
    }
    return toCueBlock(cue, index, x => millisecondsToTimestamp(Math.max(0, Math.round(x))))
}

/**
 * Converts subtitle content of any supported format into SRT.
 * @param {string} text
 * @param {SubtitleFormatId} format
 */
export function convertToSrt(text, format) {
    if (format === "srt") {
        return text
    }
    const cues = format === "vtt" ? cuesFromVtt(text) : cuesFromAss(text)
    if (cues.length === 0) {
        throw new Error(`No subtitle entries found in the ${getSubtitleFormat(format).label} content.`)
    }
    log.debug("[SubtitleFormats]", "Converted to SRT from", format, cues.length, "entries")
    return cues.map((cue, i) => formatSubtitleCue("srt", cue, i + 1)).join("")
}

/**
 * Converts SRT content into the requested format.
 * @param {string} srtText
 * @param {SubtitleFormatId} format
 */
export function convertFromSrt(srtText, format) {
    if (format === "srt") {
        return srtText
    }
    const cues = cuesFromSrt(srtText)
    return subtitleHeader(format) + cues.map((cue, i) => formatSubtitleCue(format, cue, i + 1)).join("")
}

/**
 * Offsets all timestamps in subtitle content of any supported format, returning
 * content of the same format.
 * @param {string} text
 * @param {number} seconds
 * @param {SubtitleFormatId} format
 */
export function offsetSubtitle(text, seconds, format) {
    return convertFromSrt(offsetSrt(convertToSrt(text, format), seconds), format)
}

/**
 * Concatenates subtitle content of any supported formats into a single file of
 * the requested output format, renumbering entries in order.
 * @param {string[]} texts
 * @param {SubtitleFormatId[]} formats format of each entry in `texts`
 * @param {SubtitleFormatId} outputFormat
 */
export function mergeSubtitles(texts, formats, outputFormat) {
    const cues = texts.flatMap((text, i) => cuesFromSrt(convertToSrt(text, formats[i])))
    return subtitleHeader(outputFormat) + cues.map((cue, i) => formatSubtitleCue(outputFormat, cue, i + 1)).join("")
}
