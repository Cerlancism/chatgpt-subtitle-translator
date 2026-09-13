import srtParser2 from "srt-parser-2"
import log from "loglevel"

export const parser = new srtParser2();

/**
 * Line ending emitted when `SUBTITLE_LINE_ENDING` is unset.
 * `srt-parser-2` hardcodes CRLF in `toSrt`, and the plain text and progress
 * writers have always used LF, so the default preserves both behaviours.
 */
const DEFAULT_SRT_LINE_ENDING = "\r\n"
const DEFAULT_TEXT_LINE_ENDING = "\n"

/** @type {Record<string, string>} */
const LINE_ENDINGS = {
    crlf: "\r\n",
    lf: "\n",
}

/**
 * Reads the `SUBTITLE_LINE_ENDING` override.
 *
 * Returns `undefined` when unset, blank, or set to `auto`, which leaves every
 * writer on its own existing convention — deliberately inconsistent between
 * writers (CRLF for SRT, LF for text and CSV), which is why this is `auto`
 * rather than `native`: no platform ending is ever resolved. Unrecognised
 * values warn and are ignored rather than throwing, so a typo cannot fail a
 * long translation run.
 *
 * Guarded for the browser bundle, which is statically exported and has no
 * `process.env`; there the override is never set and callers get the default.
 *
 * @returns {string | undefined}
 */
export function getLineEndingOverride() {
    const configured = typeof process !== "undefined" ? process.env?.SUBTITLE_LINE_ENDING : undefined

    if (!configured) {
        return undefined
    }

    const key = configured.trim().toLowerCase()

    if (key === "" || key === "auto") {
        return undefined
    }

    if (key in LINE_ENDINGS) {
        return LINE_ENDINGS[key]
    }

    log.warn("[Subtitle]", `Unrecognised SUBTITLE_LINE_ENDING ${JSON.stringify(configured)}, expected crlf, lf or auto. Ignoring.`)
    return undefined
}

/**
 * Line ending for non-SRT text output (plain text translations, progress CSV).
 * Defaults to LF.
 * @returns {string}
 */
export function getTextLineEnding() {
    return getLineEndingOverride() ?? DEFAULT_TEXT_LINE_ENDING
}

/**
 * Serialises SRT entries, honouring `SUBTITLE_LINE_ENDING`.
 *
 * Wraps `srt-parser-2`'s `toSrt`, which hardcodes CRLF and — because it calls
 * `String.prototype.replace` with a string pattern — rewrites only the *first*
 * newline inside a multi-line cue, leaving later ones as bare LF. Normalising
 * every break here fixes that mixed-ending output as well.
 *
 * @param {Parameters<typeof parser.toSrt>[0]} entries
 * @param {string} [lineEnding] Explicit override, mainly for tests.
 * @returns {string}
 */
export function toSrt(entries, lineEnding = getLineEndingOverride() ?? DEFAULT_SRT_LINE_ENDING) {
    const serialised = parser.toSrt(entries)
    // toSrt emits a mix of CRLF and bare LF; collapse to one convention.
    return serialised.replace(/\r\n|\r|\n/g, lineEnding)
}

/**
 * @param {string} text
 * @param {string} label
 */
export function lineLabeler(text, label) {
    return `${label}. ${text}`
}

/**
 * @param {string} str
 */
export function splitStringByNumberLabel(str) {
    const regex = /^(\d+\.)?\s*(.*)/;
    const matches = str.match(regex);
    const number = matches[1] ? parseInt(matches[1]) : undefined;
    const text = matches[2].trim();
    return { number, text };
}

/**
 * @param {number} totalMs integer milliseconds
 */
function formatTimestamp(totalMs) {
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

/** @param {number} milliseconds */
export function millisecondsToTimestamp(milliseconds) {
    return formatTimestamp(milliseconds);
}

/** @param {string} timestamp HH:MM:SS,mmm */
export function timestampToMilliseconds(timestamp) {
    const [h, m, rest] = timestamp.split(':');
    const [s, ms] = rest.split(',');
    return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms);
}

/** @param {number} seconds */
export function secondsToTimestamp(seconds) {
    return formatTimestamp(Math.floor(seconds * 1000));
}

/**
 * @param {string | number} timeOffset
 */
export function parseTimeOffset(timeOffset) {
    if (typeof timeOffset === "string") {
        let negative = false;
        if (timeOffset.startsWith("-")) {
            negative = true;
            timeOffset = timeOffset.substring(1);
        }
        timeOffset = timeOffset.replace(",", "."); // replace comma with dot
        timeOffset = timeOffset.replace(/[-.]/g, ":"); // replace hyphens and dots with colons
        let timeParts = timeOffset.split(":");

        log.debug(timeParts)

        if (timeParts.length === 1) {
            // if only seconds given
            timeOffset = parseFloat(timeParts[0]);
        } else if (timeParts.length === 4) {
            // if hours, minutes, and seconds given
            const hours = parseInt(timeParts[0]);
            const minutes = parseInt(timeParts[1]);
            const seconds = parseInt(timeParts[2]);
            const subseconds = parseFloat(timeParts[3]) / 1000;
            timeOffset = hours * 3600 + minutes * 60 + seconds + (Math.round(subseconds * 1000) / 1000);
        } else {
            // invalid time format
            timeOffset = NaN;
        }
        timeOffset = negative ? -timeOffset : timeOffset;
    }
    return timeOffset;
}

/**
 * @param {string} srtString
 * @param {number} seconds
 */
export function offsetSrt(srtString, seconds) {
    const srt = parser.fromSrt(srtString)

    for (const item of srt) {
        item.startSeconds += seconds
        item.startTime = secondsToTimestamp(item.startSeconds)
        item.endSeconds += seconds
        item.endTime = secondsToTimestamp(item.endSeconds)
    }

    return toSrt(srt)
}
