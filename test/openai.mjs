//@ts-check

import gp3Encoder from "gpt-3-encoder";
import { openaiRetryWrapper, openai } from "../src/openai.mjs";

const jsonResponse = await prompt(false)

console.log(jsonResponse.data.choices[0]?.message.content)
console.log(jsonResponse.data.usage)
console.log("\n------------------------------------------\n")

const streamResponse = await prompt(true)

console.log("\n------------------------------------------\n")

console.log(streamResponse.data.choices[0]?.message.content)
console.log(streamResponse.data.usage)

/**
 * @param {boolean} [isStream]
 */
async function prompt(isStream)
{
    const promptResponse = await openaiRetryWrapper(async () =>
    {
        /**
         * @type {import('openai').ChatCompletionRequestMessage[]}
         */
        const messages = [
            { role: "system", "content": "Generate a English joke with at least 50 words" },
        ]
        const response = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: messages,
            n: 1,
            temperature: 0,
            max_tokens: 256,
            stream: isStream
        }, isStream ? { responseType: "stream" } : undefined)
        if (!isStream)
        {
            return response
        }
        else
        {
            const output = await completeStream(response, (data) => process.stdout.write(data), () => process.stdout.write("\n"))
            const prompt_tokens = numTokensFromMessages(messages)
            const completion_tokens = numTokensFromMessages([{ content: output.data.choices[0].message.content }])
            output.data.usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
            return output
        }
    }, 3, "Test")
    return promptResponse
}

/**
 * @param {import("axios").AxiosResponse} response
 * @return {Promise<import("axios").AxiosResponse<import("openai").CreateChatCompletionResponse, any>>}
 */
async function completeStream(response, onData = (d) => { }, onEnd = () => { })
{
    let output = ''
    return new Promise((resolve, reject) =>
    {
        response.data.on("data", (/** @type {Buffer} */ data) =>
        {
            const lines = data.toString().split('\n').filter(line => line.trim() !== '');
            for (const line of lines)
            {
                const message = line.replace(/^data: /, '');
                if (message === '[DONE]')
                {
                    response.data = {
                        choices: [
                            { message: { role: "assistant", content: output } }
                        ]
                    }
                    onEnd()
                    resolve(response)
                    return; // Stream finished
                }
                try
                {
                    const parsed = JSON.parse(message);
                    const text = parsed.choices[0]?.delta?.content ?? ""
                    output += text
                    if (text)
                    {
                        onData(text)
                    }

                } catch (error)
                {
                    reject(new Error(`Could not JSON parse stream message ${message}`, { cause: error }))
                }
            }
        })

        response.data.on("error", (e) =>
        {
            reject(e)
        })
    })
}

/**
 * Seems to overcount a little bit
 * @param {Object[]} messages
 */
function numTokensFromMessages(messages, model = 'gpt-3.5-turbo-0301')
{
    switch (model)
    {
        case 'gpt-3.5-turbo':
            // console.warn('Warning: gpt-3.5-turbo may change over time. Returning num tokens assuming gpt-3.5-turbo-0301.');
            return numTokensFromMessages(messages, 'gpt-3.5-turbo-0301');
        case 'gpt-4':
            // console.warn('Warning: gpt-4 may change over time. Returning num tokens assuming gpt-4-0314.');
            return numTokensFromMessages(messages, 'gpt-4-0314');
        case 'gpt-3.5-turbo-0301':
            var tokensPerMessage = 4; // every message follows <im_start>{role/name}\n{content}<im_end>\n
            var tokensPerName = -1; // if there's a name, the role is omitted
            break;
        case 'gpt-4-0314':
            var tokensPerMessage = 3;
            var tokensPerName = 1;
            break;
        default:
            throw new Error(`numTokensFromMessages() is not implemented for model ${model}. See https://github.com/openai/openai-python/blob/main/chatml.md for information on how messages are converted to tokens.`);
    }

    let numTokens = 0;
    for (const message of messages)
    {
        numTokens += tokensPerMessage;
        for (const [key, value] of Object.entries(message))
        {
            numTokens += gp3Encoder.encode(value).length;
            if (key === 'name')
            {
                numTokens += tokensPerName;
            }
        }
    }

    numTokens += 2; // every reply is primed with <im_start>assistant
    return numTokens;
}
