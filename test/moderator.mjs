//@ts-check

import { inspect } from "util";
import { openai } from "../src/openai.mjs";

const response = await openai.createModeration({
    input: "",
    // model: "text-moderation-stable"
})

console.log(inspect(response.data, undefined, Infinity, true))