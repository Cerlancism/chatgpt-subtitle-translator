/**
 * Subtitle format conversions for the web interface.
 *
 * The translation pipeline works on SRT through `subtitleParser`, so imported
 * files are converted to SRT on the way in and exports are converted from SRT
 * on the way out. The internal representation stays SRT everywhere else.
 */
import { subtitleParser } from "chatgpt-subtitle-translator"

/**
 * @typedef {"srt" | "vtt" | "ass"} SubtitleFormatId
 */

/**
 * @typedef SubtitleFormat
 * @property {SubtitleFormatId} id
 * @property {string} label
 * @property {string} extension
 * @property {string} mimeType
 */

/** @type {SubtitleFormat[]} */
export const SubtitleFormats = [
  { id: "srt", label: "SRT", extension: ".srt", mimeType: "text/plain" },
  { id: "vtt", label: "VTT", extension: ".vtt", mimeType: "text/vtt" },
  { id: "ass", label: "ASS/SSA", extension: ".ass", mimeType: "text/plain" },
]

export const AcceptedSubtitleExtensions = ".srt,.vtt,.ass,.ssa,text/plain"

/**
 * @typedef SubtitleCue
 * @property {number} start milliseconds
 * @property {number} end milliseconds
 * @property {string} text
 */

/**
 * @param {SubtitleFormatId | string} id
 */
export function getSubtitleFormat(id) {
  return SubtitleFormats.find(x => x.id === id) ?? SubtitleFormats[0]
}

/** @param {string} text */
function normalizeNewlines(text) {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n")
}

/**
 * Parses `HH:MM:SS,mmm`, `H:MM:SS.cc` and `MM:SS.mmm` shaped timestamps.
 * @param {string} timestamp
 * @returns {number | null} milliseconds
 */
function parseTimestamp(timestamp) {
  const matches = timestamp.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/)
  if (!matches) {
    return null
  }
  const [, hours, minutes, seconds, fraction] = matches
  const milliseconds = Number(fraction.padEnd(3, "0"))
  return Number(hours ?? 0) * 3600000 + Number(minutes) * 60000 + Number(seconds) * 1000 + milliseconds
}

/**
 * @param {number} totalMilliseconds
 * @param {string} millisecondSeparator
 */
function formatTimestamp(totalMilliseconds, millisecondSeparator) {
  const total = Math.max(0, Math.round(totalMilliseconds))
  const hours = Math.floor(total / 3600000)
  const minutes = Math.floor((total % 3600000) / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const milliseconds = total % 1000
  const time = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
  return `${time}${millisecondSeparator}${milliseconds.toString().padStart(3, "0")}`
}

/** @param {number} totalMilliseconds */
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
 * remaining comma inside the last field.
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
 * Detects the format of a subtitle file from its extension, falling back to
 * sniffing the file content.
 * @param {string} text
 * @param {string} [fileName]
 * @returns {SubtitleFormatId}
 */
export function detectSubtitleFormat(text, fileName) {
  const extension = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (extension === "vtt") {
    return "vtt"
  }
  if (extension === "ass" || extension === "ssa") {
    return "ass"
  }
  if (extension === "srt") {
    return "srt"
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
 * @param {string} srtText
 * @returns {SubtitleCue[]}
 */
function cuesFromSrt(srtText) {
  return subtitleParser.fromSrt(srtText).map(x => ({
    start: parseTimestamp(x.startTime) ?? Math.round(x.startSeconds * 1000),
    end: parseTimestamp(x.endTime) ?? Math.round(x.endSeconds * 1000),
    text: x.text,
  }))
}

/**
 * @param {SubtitleCue[]} cues
 * @param {string} millisecondSeparator
 */
function cuesToCueBlocks(cues, millisecondSeparator) {
  const endOfLine = "\r\n"
  return cues.map((cue, i) => [
    `${i + 1}`,
    `${formatTimestamp(cue.start, millisecondSeparator)} --> ${formatTimestamp(cue.end, millisecondSeparator)}`,
    cue.text.split("\n").join(endOfLine),
    "",
    "",
  ].join(endOfLine)).join("")
}

/**
 * @param {SubtitleCue[]} cues
 */
function cuesToSrt(cues) {
  return cuesToCueBlocks(cues, ",")
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
  const blocks = normalizeNewlines(vttText).split(/\n{2,}/)
  /** @type {SubtitleCue[]} */
  const cues = []
  for (const block of blocks) {
    const lines = block.split("\n").filter(x => x.trim().length > 0)
    if (lines.length === 0) {
      continue
    }
    const timingIndex = lines.findIndex(x => x.includes("-->"))
    if (timingIndex < 0) {
      continue
    }
    const [startPart, endPart] = lines[timingIndex].split("-->")
    const start = parseTimestamp(startPart)
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

/**
 * @param {SubtitleCue[]} cues
 */
function cuesToVtt(cues) {
  return `WEBVTT\r\n\r\n${cuesToCueBlocks(cues, ".")}`
}

const AssStylesSection = [
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

/**
 * Removes override blocks and drawing commands that have no SRT equivalent,
 * and converts ASS line breaks into plain newlines.
 * @param {string} text
 */
function stripAssMarkup(text) {
  if (/\\p[1-9]/.test(text)) {
    // Vector drawing rather than dialogue, there is nothing to translate.
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
  const lines = normalizeNewlines(assText).split("\n")
  let eventFields = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"]
  let inEvents = false
  /** @type {SubtitleCue[]} */
  const cues = []
  for (const line of lines) {
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
 * @param {SubtitleCue[]} cues
 */
function cuesToAss(cues) {
  const endOfLine = "\r\n"
  const events = cues.map(cue => {
    const text = cue.text.split("\n").map(x => x.trim()).join("\\N")
    return `Dialogue: 0,${formatAssTimestamp(cue.start)},${formatAssTimestamp(cue.end)},Default,,0,0,0,,${text}`
  })
  return [...AssStylesSection, ...events, ""].join(endOfLine)
}

/**
 * Converts subtitle text of any supported format into the internal SRT
 * representation.
 * @param {string} text
 * @param {SubtitleFormatId} format
 */
export function convertToSrt(text, format) {
  if (format === "srt") {
    return text
  }
  const cues = format === "vtt" ? cuesFromVtt(text) : cuesFromAss(text)
  if (cues.length === 0) {
    throw new Error(`No subtitle entries found in the ${getSubtitleFormat(format).label} file.`)
  }
  return cuesToSrt(cues)
}

/**
 * Converts the internal SRT representation into the requested format.
 * @param {string} srtText
 * @param {SubtitleFormatId} format
 */
export function convertFromSrt(srtText, format) {
  if (format === "srt") {
    return srtText
  }
  const cues = cuesFromSrt(srtText)
  return format === "vtt" ? cuesToVtt(cues) : cuesToAss(cues)
}


