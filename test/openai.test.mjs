import test from "node:test"
import assert from "node:assert";

import { openai } from "../src/openai.mjs";

test("should list available openai models", async () =>
{
  const models = await openai.models.list()
  const gptModels = models.data.filter(x => x.id.startsWith("gpt") && !x.id.includes("instruct") && !x.id.includes("vision"))

  for (const model of gptModels)
  {
    // console.log(model)
  }
  const gptList = gptModels.map(x => x.id).sort().join(" ")
  console.log("GPT Text Models:", gptList)
  assert(gptModels.length > 0, `should have available gpt models: ${gptModels.length} ${gptList}`)
})
