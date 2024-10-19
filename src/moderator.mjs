import log from "loglevel"
import { CooldownContext } from "./cooldown.mjs"
import { openaiRetryWrapper } from "./openai.mjs"

/**
 * @typedef ModerationResult
 * @property {string} catergory
 * @property {number} value
 */

/**
 * @typedef ModerationServiceContext
 * @property {import("openai").OpenAI} openai
 * @property {CooldownContext} [cooler]
 */

/**
 * @param {string | string[]} input
 * @param {ModerationServiceContext} services
 * @param {import('openai').OpenAI.ModerationModel} model
 */
export async function checkModeration(input, services, model = undefined)
{
    return await openaiRetryWrapper(async () =>
    {
        await services.cooler?.cool()
        const moderation = await services.openai.moderations.create({ input, model })
        const moderationData = moderation.results[0]

        if (moderationData.flagged)
        {
            log.debug("[CheckModeration]", "flagged", getModeratorResults(moderationData))
        }

        // log.debug("Moderation complete")

        return moderationData
    }, 3, "CheckModeration")
}

/**
 * @param {import("openai").OpenAI.Moderation} moderatorOutput
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
