//@ts-check
import { CooldownContext } from "../src/cooldown.mjs";
import { sleep } from "../src/helpers.mjs";

const cooler = new CooldownContext(10, 1000, "tester")

for (let index = 0; index < 100; index++)
{
    await cooler.cool()
    await sleep(10)
    console.log(index)
}