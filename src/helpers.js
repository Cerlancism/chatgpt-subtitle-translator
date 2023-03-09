//@ts-check

export const genRanHex = size => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

export async function sleep(ms)
{
    return new Promise(resolve => setTimeout(resolve, ms));
}
