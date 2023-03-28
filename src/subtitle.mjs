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
