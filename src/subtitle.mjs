//@ts-check
import srtParser2 from "srt-parser-2"

export const parser = new srtParser2.default();

/**
 * @param {string} text
 * @param {string} label
 */
export function lineLabeler(text, label)
{
    return `${label}. ${text}`
}

/**
 * @param {string} str
 */
export function splitStringByNumberLabel(str)
{
    const regex = /^(\d+\.)?\s*(.*)/;
    const matches = str.match(regex);
    const number = matches[1] ? parseInt(matches[1]) : undefined;
    const text = matches[2].trim();
    return { number, text };
}

/**
 * @param {number} seconds
 */
export function secondsToTimestamp(seconds)
{
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millisecs = Math.floor((seconds % 1) * 1000);
    const result = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${millisecs.toString().padStart(3, '0')}`
    return result;
}

/**
 * @param {string | number} timeOffset
 */
export function parseTimeOffset(timeOffset)
{
    if (typeof timeOffset === 'string')
    {
        let negative = false
        if (timeOffset.startsWith("-"))
        {
            negative = true
            timeOffset = timeOffset.substring(1)
        }
        timeOffset = timeOffset.replace(',', '.'); // replace comma with dot
        timeOffset = timeOffset.replace(/-/g, ':'); // replace hyphens with colons
        let timeParts = timeOffset.split(":");

        if (timeParts.length === 1)
        {
            // if only seconds given
            timeOffset = parseFloat(timeParts[0]);
        } else if (timeParts.length === 3)
        {
            // if hours, minutes, and seconds given
            const hours = parseInt(timeParts[0]);
            const minutes = parseInt(timeParts[1]);
            const seconds = parseFloat(timeParts[2]);
            timeOffset = (hours * 3600) + (minutes * 60) + seconds;
        } else
        {
            // invalid time format
            timeOffset = NaN;
        }
        timeOffset = negative ? -timeOffset : timeOffset
    }
    return timeOffset;
}

/**
 * @param {string} srtString
 * @param {number} seconds
 */
export function offsetSrt(srtString, seconds)
{
    const srt = parser.fromSrt(srtString)

    for (const item of srt)
    {
        item.startSeconds += seconds
        item.startTime = secondsToTimestamp(item.startSeconds)
        item.endSeconds += seconds
        item.endTime = secondsToTimestamp(item.endSeconds)
    }

    return parser.toSrt(srt)
}
