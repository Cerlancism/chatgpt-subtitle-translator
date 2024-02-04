import { sleep } from "./helpers.mjs"

/**
 * Simple rate limiter
 */
export class CooldownContext
{
    /**
     * @param {number} limit
     * @param {number} duration
     * @param {string} description
     */
    constructor(limit, duration, description)
    {
        this.limit = limit
        this.duration = duration
        this.description = description

        this.baseDelay = 1

        this.requests = []
    }

    /**
     * 
     * @return {number} 
     */
    cooldown()
    {
        // Remove any requests from the requests array that are older than the duration
        // console.log("[CooldownContext]", this.description, this.requests.length)
        const now = Date.now();
        this.requests = this.requests.filter(time => now - time < this.duration);
        this.rate = this.requests.length

        // Check if the number of requests made within the duration has reached the limit
        if (this.rate >= this.limit)
        {
            // The limit has been reached, so we cannot make another request yet
            const nextRequestTime = this.requests[0] + this.duration;
            return nextRequestTime - now;
        }

        // The limit has not been reached, so we can make another request
        return 0;
    }

    async cool()
    {
        const cooldown = this.cooldown()

        if (cooldown === 0)
        {
            this.requests.push(Date.now());
            return false
        }
        console.error("[Cooldown]", this.description, cooldown, `ms`)

        await sleep(cooldown + this.baseDelay)
        this.requests.push(Date.now());
        return true
    }
}
