import test from 'node:test';
import assert from 'node:assert';
import { CooldownContext } from "../src/cooldown.mjs";
import { sleep } from "../src/helpers.mjs";

test('CooldownContext should handle bursts correctly', async () =>
{
    const totalCount = 30;
    const burstCount = 10;
    const waitTime = 250; // time to wait between bursts in milliseconds
    const description = "tester";
    const cooler = new CooldownContext(burstCount, waitTime, description);

    let lastTime = Date.now();

    let workDone = 0

    for (let index = 0; index < totalCount; index++)
    {
        await sleep(10); // simulate some work
        workDone++
        
        const cooled = await cooler.cool();
        // Check if the cooldown is respecting the burst count and wait time
        if (cooled)
        {
            const currentTime = Date.now();
            const timeDiff = currentTime - lastTime;
            // console.log({ timeDiff, waitTime, index })
            assert(workDone === burstCount, `Work done ${workDone} per cool should be same as specified burst count ${burstCount}`)
            assert(timeDiff >= waitTime, `Expected a wait time of at least ${waitTime} ms between bursts, but got ${timeDiff} ms`);
            lastTime = currentTime;
            workDone = 0
        }
    }
});
