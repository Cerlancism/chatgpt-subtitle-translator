//@ts-check

import { CooldownContext } from "../src/cooldown.js";
import { sleep } from "../src/helpers.js";

const cooler = new CooldownContext(10, 1000, "tester")

for (let index = 0; index < 100; index++)
{
    await cooler.use()
    await sleep(10)
    console.log(index)
}