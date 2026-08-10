#!/usr/bin/env node
import url from 'node:url'
import fs from 'node:fs'
import { Command } from "commander"
import path from 'node:path'
import { parseTimeOffset } from '../src/subtitle.mjs'
import { detectSubtitleFormat, getSubtitleFormat, mergeSubtitles, offsetSubtitle } from '../src/subtitleFormats.mjs'

/**
 * @param {readonly string[]} args
 */
function createInstance(args) {
    const commandOffsetFile = new Command("offset")
        .description("Offsets all timestamps in a .srt, .vtt or .ass/.ssa file, currently implemented using floating points, sub-second operations will have precision issues\n"
            + "For negative offsets, pass -- first, eg: \n./subtitle.mjs -- offset file.srt -01:02:03.456")
        .argument("<file>", "Target file")
        .argument("<offset>", "Time offset in HH-MM-SS.sss or HH:MM:SS,sss or HH:MM:SS.sss or seconds")
        .action((file, offset) => offsetFile(file, offset))

    const commandMergeFiles = new Command("merge")
        .description("Merge subtitle files, formats may be mixed. The output format follows the first file unless --format is given")
        .arguments("<files...>")
        .option("--format <format>", "Output format: srt, vtt or ass")
        .action((files, opts) => mergeFiles(files, opts.format))

    const program = new Command()
        .description("Subtitle utilities")
        .addCommand(commandOffsetFile)
        .addCommand(commandMergeFiles)
        .parse(args)

    const opts = program.opts()

    return { program, opts }
}

/**
 * TODO: Move this to another module
 * @param {string} file
 * @param {string} offset
 */
function offsetFile(file, offset) {
    const offsetSeconds = parseTimeOffset(offset)

    if (isNaN(offsetSeconds)) {
        console.error("Bad format", offset)
        return
    }

    const filePath = path.parse(file)

    console.error("offsetting", filePath.ext, filePath.name, offsetSeconds)

    const content = fs.readFileSync(file, 'utf-8')
    const format = detectSubtitleFormat(content, file)
    const offsetted = offsetSubtitle(content, offsetSeconds, format)

    fs.renameSync(file, path.join(filePath.dir, filePath.name + ".old" + filePath.ext))
    fs.writeFileSync(file, offsetted)
}

/**
 * TODO: Move this to another module
 * @param {string[]} files
 * @param {string} [outputFormat] Output format, defaults to the format of the first file
 */
function mergeFiles(files, outputFormat) {
    const contents = files.map(file => fs.readFileSync(file, 'utf-8'))
    const formats = contents.map((content, i) => detectSubtitleFormat(content, files[i]))
    const format = getSubtitleFormat(outputFormat ?? formats[0])

    const outSubtitle = mergeSubtitles(contents, formats, format.id)
    const outFilePaths = files.map(x => path.parse(x))
    const outFileName = outFilePaths.map(x => x.name).join("+") + format.extension
    fs.writeFileSync(path.join(outFilePaths[0].dir, outFileName), outSubtitle)
}


// const { opts } = createInstance(process.argv)
// console.log(opts)
createInstance(process.argv)
