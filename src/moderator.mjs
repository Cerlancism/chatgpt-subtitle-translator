//@ts-check

import { CooldownContext } from "./cooldown.mjs"
import { openai, openaiRetryWrapper } from "./openai.mjs"

const cooler = new CooldownContext(Number(process.env.OPENAI_API_RPM ?? process.env.OPENAI_API_MODERATOR_RPM ?? 60), 60000, "Moderator")

/**
 * @param {any} input
 */
export async function checkModeration(input)
{
    return await openaiRetryWrapper(async () =>
    {
        await cooler.cool()
        const moderation = await openai.createModeration({ input })
        const moderationData = moderation.data.results[0]

        if (moderationData.flagged)
        {
            console.error("flagged", getModeratorResults(moderationData))
        }

        // console.error("Moderation complete")

        return moderationData
    }, 3, "CheckModeration")
}

/**
 * @typedef ModerationResult
 * @property {string} catergory
 * @property {number} value
 */

/**
 * @param {import("openai").CreateModerationResponseResultsInner} moderatorOutput
 */
export function getModeratorResults(moderatorOutput)
{
    return Object.keys(moderatorOutput.categories)
        .filter(x => moderatorOutput.categories[x])
        .map(x => ({ catergory: x, value: Number(moderatorOutput.category_scores[x]) }))
}

/**
 * @param {ModerationResult[]} moderatorResults
 */
export function getModeratorDescription(moderatorResults)
{
    return moderatorResults.map(x => `${x.catergory}: ${x.value.toFixed(3)}`).join(" ")
}
