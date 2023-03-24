//@ts-check
import readline from 'readline';

const rl = readline.promises.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const output = await rl.question("Test: ")

readline.moveCursor(process.stdout, 0, -1) // up one line
readline.clearLine(process.stdout, 0)

rl.write(output)
rl.close()