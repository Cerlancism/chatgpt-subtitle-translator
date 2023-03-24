//@ts-check

import { openaiRetryWrapper, openai } from "../src/openai.mjs";

const jsonResponse = await prompt(false)

console.log(jsonResponse.data.choices[0].message.content)
console.log("\n------------------------------------------\n")

const streamResponse = await prompt(true)

console.log("\n------------------------------------------\n")

console.log(streamResponse.data.choices[0].message.content)

/**
 * @param {boolean} [isStream]
 */
async function prompt(isStream)
{
    const promptResponse = await openaiRetryWrapper(async () =>
    {
        const response = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", "content": "Generate short single liner Chinese English multilingual funny joke with loads of emojis, and end with emoji" },
            ],
            n: 1,
            stream: isStream
        }, isStream ? { responseType: "stream" } : undefined)
        if (!isStream)
        {
            return response
        }
        else
        {
            const output = await completeStream(response, (data) =>
            {
                process.stdout.write(data)
            }, () =>
            {
                process.stdout.write("\n")
            })

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
                            { message: { content: output } }
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

        // response.data.on("end", () =>
        // {
            
        // })

        response.data.on("error", (e) =>
        {
            reject(e)
        })
    })
}
