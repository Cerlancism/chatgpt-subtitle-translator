//@ts-check

import { translateSrtChinese } from "./translator.js";

const directory = "//CHE-MAIN/Lump/Subtitles/AI/"
const file = "NHDTB-293_01.54.40.881-02.51.52.841.mp3-subs" + ".srt"

const offset = 0
const end = undefined

await translateSrtChinese(`${directory}${file}`, offset, end)



