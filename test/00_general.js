const arr = Array(1234).fill().map((element, index) => index + 1)


for (let index = 0; index < arr.length; index+=100) {
    const batch = arr.slice(index, index + 100)
    for (const iterator of batch)
    {
        console.log(iterator)
    }
}

