//@ts-check
import { openai, numTokensFromMessages, completeChatStream, openaiRetryWrapper } from "../src/openai.mjs";

// const jsonResponse = await prompt({ stream: false })
// console.log(jsonResponse.data.choices[0]?.message.content)
// console.log(jsonResponse.data.usage)
// console.log("\n------------------------------------------\n")

const streamResponse = await prompt({ stream: true })
console.log("\n------------------------------------------\n")
// console.log(streamResponse.data.choices[0]?.message.content)
console.log(streamResponse.data.usage)

async function prompt(options = { stream: false })
{
    const promptResponse = await openaiRetryWrapper(async () =>
    {
        /** @type {import('openai').ChatCompletionRequestMessage[]} */
        const messages = [
            { role: "system", "content": "Generate short Chinese+English joke with emojis" },
            { role: "user", name: "user", content: "" },

        ]
        const response = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: messages,
            n: 1,
            temperature: 0,
            max_tokens: 256,
            stream: options.stream
        }, options.stream ? { responseType: "stream" } : undefined)
        if (!options.stream)
        {
            return response
        }
        else
        {
            const output = await completeChatStream(response, (data) => process.stdout.write(data), () => process.stdout.write("\n"))
            const prompt_tokens = numTokensFromMessages(messages)
            const completion_tokens = numTokensFromMessages([{ content: output.data.choices[0].message.content }])
            output.data.usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
            return output
        }
    }, 3, "Test")
    return promptResponse
}
