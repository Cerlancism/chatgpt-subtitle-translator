#!/usr/bin/env node
//@ts-check
import url from 'node:url'
import fs from 'node:fs'
import { Command, program } from "commander"
import path from 'node:path'
import { offsetSrt, parseTimeOffset, parser } from '../src/subtitle.mjs'

/**
 * @param {readonly string[]} args
 */
export function createInstance(args)
{
    const commandOffsetFile = new Command("offset")
        .description("Offsets all timestamps in .srt file, currently implemented using floating points, sub-second operations will have precision issues\n"
            + "For negative offsets, pass -- first, eg: \n./subtitle.mjs -- offset file.srt -01:02:03.456")
        .argument("<file>", "Target file")
        .argument("<offset>", "Time offset in HH-MM-SS.sss or HH:MM:SS,sss or HH:MM:SS.sss or seconds")
        .action((file, offset) => offsetFile(file, offset))

    const program = new Command()
        .description("Subtitle ultilities")
        .addCommand(commandOffsetFile)
        .parse(args)

    const opts = program.opts()

    return { program, opts }
}

/**
 * @param {string} file
 * @param {string} offset
 */
export function offsetFile(file, offset)
{
    const offsetSeconds = parseTimeOffset(offset)

    if (isNaN(offsetSeconds))
    {
        console.error("Bad format", offset)
        return
    }

    const filePath = path.parse(file)

    console.error("offsetting", filePath.ext, filePath.name, offsetSeconds)

    const content = fs.readFileSync(file, 'utf-8')
    const srt = offsetSrt(content, offsetSeconds)

    fs.renameSync(file, path.join(filePath.dir, filePath.name + ".old" + filePath.ext))
    fs.writeFileSync(file, srt)
}


if (import.meta.url === url.pathToFileURL(process.argv[1]).href)
{
    const { opts } = createInstance(process.argv)

    // console.log(opts)
}