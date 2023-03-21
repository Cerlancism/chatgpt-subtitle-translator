# ChatGPT API SRT Subtitle Translator
ChatGPT has also demonstrated its capabilities as a [robust translator](https://towardsdatascience.com/translate-with-chatgpt-f85609996a7f), capable of handling not just common languages, but also unconventional forms of writing like emojis and word scrambling. However, it may not always produce a deterministic output and adhere to line-to-line correlation, potentially disrupting the timing of subtitles, even when instructed to follow precise instructions and setting the model `temperature` parameter to [`0`](https://cobusgreyling.medium.com/example-code-implementation-considerations-for-gpt-3-5-turbo-chatml-whisper-e61f8703c5db).

This utility uses the OpenAI ChatGPT API to translate text, with a specific focus on line-based translation, especially for SRT subtitles. The translator optimizes token usage by removing SRT overhead, grouping text into batches, resulting in longer translations without excessive [token consumption](https://openai.com/pricing) while ensuring a one-to-one match between line input and output.

## Features
- Line-based batching: avoiding token limit per request, reducing overhead token wastage, maintaining translation context to certain extent
- Checking with the free OpenAI Moderation tool: prevent token wastage if the model is highly likely to refuse to translate
- Request per minute (RPM) [rate limits](https://platform.openai.com/docs/guides/rate-limits/overview) 
- **TODO**: Tokens per minute rate limits (TPM) 
- **TODO**: Progress resumption - mitigation for frequent API gateway errors and downtimes
- **TODO**: Retry translation parts

## Setup
Reference: <https://github.com/openai/openai-quickstart-node#setup>
- Node.js version >= 14.6.0 required
- Clone this repository
- Install the requirements
  ```
  npm install
  ```
- Give executable permission
  ```
  chmod +x cli/translator.mjs
  ```
- Copy `.example.env` to `.env`
- Add your [API key](https://platform.openai.com/account/api-keys) to the newly created `.env` file
  - Optional set rate limits: <https://platform.openai.com/docs/guides/rate-limits/overview>
## CLI
```
cli/translator.mjs --help
```

`Usage: translator [options]`

`Translation tool based on ChatGPT API`


Options:
  - `-f, --from <language>` Source language
  - `-t, --to <language>` Target language (default: "English")
  - `-m, --model <model>` https://platform.openai.com/docs/api-reference/chat/create#chat/create-model
  - `-f, --file <file>` Text file name to use as input, .srt or plain text
  - `--system-instruction <instruction>` Override the prompt system instruction template (Translate {from} to {to}) with this plain text
  - `--plain-text <text>` Only translate this input plain text
  - `--initial-prompts <prompts>` Initial prompts for the translation in JSON
  - `--no-use-moderator` Don't use the OpenAI Moderation tool
  - `--no-prefix-line-with-number` Don't prefix lines with numerical indices
  - `--history-prompt-length <length>` Length of prompt history to retain for next request batch, default: 10
  - `--batch-sizes <sizes>` Batch sizes for translation prompts in JSON Array, eg: `"[10, 100]"`
  - `--temperature <temperature>` Sampling temperature to use, should set a low value below 0.3 to be more deterministic for translation https://platform.openai.com/docs/api-reference/chat/create#chat/create-temperature
  - `--top_p <top_p>` Nucleus sampling parameter, top_p probability mass https://platform.openai.com/docs/api-reference/chat/create#chat/create-top_p
  - `--presence_penalty <presence_penalty>` Penalty for new tokens based on their presence in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-presence_penalty
  - `--frequency_penalty <frequency_penalty` Penalty for new tokens based on their frequency in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-frequency_penalty
  - `--logit_bias <logit_bias>` Modify the likelihood of specified tokens appearing in the completion https://platform.openai.com/docs/api-reference/chat/create#chat/create-logit_bias
  - `--user <user>` A unique identifier representing your end-user

## Examples
### Plain text  
```
cli/translator.mjs --plain-text "你好"
```
Standard Output
```
Hello.
```
### Emojis
```
cli/translator.mjs --to "Emojis" --temperature 0 --plain-text "$(curl 'https://api.chucknorris.io/jokes/0ECUwLDTTYSaeFCq6YMa5A' | jq .value)"
```  
Input Argument
```
Chuck Norris can walk with the animals, talk with the animals; grunt and squeak and squawk with the animals... and the animals, without fail, always say 'yessir Mr. Norris'.
```
Standard Output
```bash
👨‍🦰💪🚶‍♂️🦜🐒🐘🐅🐆🐎🐖🐄🐑🦏🐊🐢🐍🐿️🐇🐿️❗️🌳💬😲👉🤵👨‍🦰👊=🐕🐑🐐🦌🐘🦏🦍🦧🦓🐅🦌🦌🦌🐆🦍🐘🐘🐗🦓=👍🤵.
```
### Scrambling
```
cli/translator.mjs --system-instruction "Scramble characters of words keeping only start and end letter" --temperature 0 --plain-text "Chuck Norris can walk with the animals, talk with the animals;"
```  
Standard Output
```
Cuhk Ciorrsn cna wlkak wtih the ainnmlas, takl wtih the ainnmlas;
```
```
cli/translator.mjs --system-instruction "Unscramble characters back to English" --temperature 0 --plain-text "Cuhckor Narisso acn alkwa wthi the aanimls"
```
```
Chuck Norris can walk with the animals, talk with the animals;
```

### Plain text file  
```
cli/translator.mjs --file test/data/test_cn.txt
```  
Input file: [test/data/test_cn.txt](test/data/test_cn.txt)
```
你好。
拜拜！
```
Standard Output
```
Hello.  
Goodbye!
```
### SRT file
```
cli/translator.mjs --file test/data/test_ja.srt
```  
Input file: [test/data/test_ja.srt](test/data/test_ja.srt)
```
1
00:00:00,000 --> 00:00:02,000
おはようございます。

2
00:00:02,000 --> 00:00:05,000
お元気ですか？

3
00:00:05,000 --> 00:00:07,000
はい、元気です。

``` 
Output file: [test/data/test_ja.srt.out_English.srt](test/data/test_ja.srt.out_English.srt)
```
1
00:00:00,000 --> 00:00:02,000
Good morning.

2
00:00:02,000 --> 00:00:05,000
How are you?

3
00:00:05,000 --> 00:00:07,000
Yes, I'm doing well.

```

## How it works
### Token Reductions
**System Instruction**  
Tokens: `5`
```
Translate Japanese to English
```  
<table>
<tr>
<th>Input</th>
<th>Prompt</th>
<th>Transform</th>
<th>Output</th>
</tr>
<tr>
<td>

Tokens: `164`

</td>
<td>

Tokens: `83`

</td>
<td>

Tokens: `46`

</td>
<td>

Tokens: `130`

</td>
</tr>
<tr>
<td valign="top">

```log
1
00:00:00,000 --> 00:00:02,000
おはようございます。

2
00:00:02,000 --> 00:00:05,000
お元気ですか？

3
00:00:05,000 --> 00:00:07,000
はい、元気です。

4
00:00:08,000 --> 00:00:12,000
今日は天気がいいですね。

5
00:00:12,000 --> 00:00:16,000
はい、とてもいい天気です。
```

</td>
<td valign="top">

```log
1. おはようございます。
2. お元気ですか？
3. はい、元気です。
4. 今日は天気がいいですね。
5. はい、とてもいい天気です。
```

</td>
<td valign="top">

```log
1. Good morning.
2. How are you?
3. Yes, I'm doing well.
4. The weather is nice today, isn't it?
5. Yes, it's very nice weather.
```

</td>
<td valign="top">

```log
1
00:00:00,000 --> 00:00:02,000
Good morning.

2
00:00:02,000 --> 00:00:05,000
How are you?

3
00:00:05,000 --> 00:00:07,000
Yes, I'm doing well.

4
00:00:08,000 --> 00:00:12,000
The weather is nice today, isn't it?

5
00:00:12,000 --> 00:00:16,000
Yes, it's very nice weather.
```

</td>
</tr>
</table>

### Results
**TODO**: More analysis

5 SRT lines:  
[test/data/test_ja_small.srt](test/data/test_ja_small.srt)  
- None (Plain text SRT input output):  
  Tokens: `299`
- No batching, one line per prompt with (System instruction overhead), including up to 10 historical prompt context:  
  Tokens: `362` 
- SRT stripping and line batching of 2:  
  Tokens: `276`

30 SRT lines:  
[test/data/test_ja.srt](test/data/test_ja.srt)
- None (Plain text SRT input output):  
  Tokens: `1625`
- No batching, one line per prompt with (System instruction overhead), including up to 10 historical prompt context:  
  Tokens: `6719` 
- SRT stripping and line batching of `[5, 10]`, including up to 10 historical prompt context:  
  Tokens: `1036`
