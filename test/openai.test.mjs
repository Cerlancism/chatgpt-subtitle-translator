import test from "node:test"
import assert from "node:assert";

import { createOpenAIClient } from "../src/main.mjs";

import 'dotenv/config'

const openai = createOpenAIClient(process.env.OPENAI_API_KEY, undefined, process.env.OPENAI_BASE_URL)

test("should list available models", async () => {
  const models = await openai.models.list()
  const ids = models.data.map(x => x.id).sort()
  console.log("Available models:", ids.join(" "))
  assert(models.data.length > 0, `endpoint should expose at least one model, got ${models.data.length}`)
})
