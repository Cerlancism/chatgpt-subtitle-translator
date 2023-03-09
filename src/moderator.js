//@ts-check

import { CooldownContext } from "./cooldown.js"
import { openai } from "./openai.js"

const cooler = new CooldownContext(10, 60000, "Moderator")

/**
 * @param {any} input
 */
export async function checkModeration(input)
{
    try
    {
        await cooler.use()
        const moderation = await openai.createModeration({ input: input })
        const moderationData = moderation.data.results[0]

        if (moderationData.flagged)
        {
            const flaggedCatergories = Object.keys(moderationData.categories)
                .filter(x => moderationData.categories[x])
                .map(x => ({ catergory: x, value: Number(moderationData.category_scores[x]) }))
            console.error("flagged", flaggedCatergories.map(x => `${x.catergory}: ${x.value.toFixed(3)}`).join(" "))
        }

        return moderationData
    }
    catch (error)
    {
        console.error("error checkModeration", error.message)
        process.exit(1)
    }
}
