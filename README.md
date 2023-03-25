# ChatGPT API SRT Subtitle Translator
ChatGPT has also demonstrated its capabilities as a [robust translator](https://towardsdatascience.com/translate-with-chatgpt-f85609996a7f), capable of handling not just common languages, but also unconventional forms of writing like emojis and [word scrambling](https://www.mrc-cbu.cam.ac.uk/people/matt.davis/cmabridge/). However, it may not always produce a deterministic output and adhere to line-to-line correlation, potentially disrupting the timing of subtitles, even when instructed to follow precise instructions and setting the model `temperature` parameter to [`0`](https://cobusgreyling.medium.com/example-code-implementation-considerations-for-gpt-3-5-turbo-chatml-whisper-e61f8703c5db).

This utility uses the OpenAI ChatGPT API to translate text, with a specific focus on line-based translation, especially for SRT subtitles. The translator optimizes token usage by removing SRT overhead, grouping text into batches, resulting in arbitrary length translations without excessive [token consumption](https://openai.com/pricing) while ensuring a one-to-one match between line input and output.

## Features
- Line-based batching: avoiding token limit per request, reducing overhead token wastage, maintaining translation context to certain extent
- Checking with the free OpenAI Moderation tool: prevent token wastage if the model is highly likely to refuse to translate
- Streaming process output
- Request per minute (RPM) [rate limits](https://platform.openai.com/docs/guides/rate-limits/overview) 
- **TODO**: Tokens per minute rate limits (TPM) 
- Progress resumption - mitigation for frequent API gateway errors and downtimes
- **TODO**: Retry translation parts

## Setup
Reference: <https://github.com/openai/openai-quickstart-node#setup>
- Node.js version `>= 14.21.3` required. This README assumes `bash` shell environment
- Clone this repository and navigate into the directory
  ```bash
  git clone https://github.com/Cerlancism/chatgpt-subtitle-translator && cd chatgpt-subtitle-translator
  ``` 
- Install the requirements
  ```bash
  npm install
  ```
- Give executable permission
  ```bash
  chmod +x cli/translator.mjs
  ```
- Copy `.example.env` to `.env`
  ```bash
  cp .env.example .env
  ```
- Add your [API key](https://platform.openai.com/account/api-keys) to the newly created `.env` file
  - Optional set rate limits: <https://platform.openai.com/docs/guides/rate-limits/overview>
## CLI
```
cli/translator.mjs --help
```

`Usage: translator [options]`

`Translation tool based on ChatGPT API`


Options:
  - `-f, --from <language>`  
    Source language (default: "") 
  - `-t, --to <language>`  
    Target language (default: "English")
  - `-f, --file <file>`  
    Input source text with the content of this file, in `.srt` format or plain text
  - `--plain-text <text>`  
    Input source text with this plain text argument
  - `--system-instruction <instruction>`  
    Override the prompt system instruction template `Translate {from} to {to}` with this plain text, ignoring `--from` and `--to` options
  - `--initial-prompts <prompts>`  
    Initial prompts for the translation in JSON (default: `"[]"`) 
  - `--no-use-moderator`  
    Don't use the OpenAI API Moderation endpoint
  - `--no-prefix-line-with-number`  
    Don't prefix lines with numerical indices
  - `--history-prompt-length <length>`  
    Length of prompt history to retain for next request batch (default: 10)
  - `--batch-sizes <sizes>` 
    Batch sizes of increasing order for translation prompt slices in JSON Array (default: `"[10, 100]"`)

    The number of lines to include in each translation prompt, provided that they are estimated to within the token limit. 
    In case of mismatched output line quantities, this number will be decreased step-by-step according to the values in the array, ultimately reaching one.
    
    Larger batch sizes generally lead to more efficient token utilization and potentially better contextual translation. 
    However, mismatched output line quantities or exceeding the token limit will cause token wastage, requiring resubmission of the batch with a smaller batch size.

Additional Options for ChatAPT:  
  - `-m, --model <model>`  
    (default: `"gpt-3.5-turbo"`) https://platform.openai.com/docs/api-reference/chat/create#chat/create-model
  - `--stream`  
    Stream progress output to terminal https://platform.openai.com/docs/api-reference/chat/create#chat/create-stream
  - `-t, --temperature <temperature>`  
    Sampling temperature to use, should set a low value below `0.3` to be more deterministic for translation (default: `1`) https://platform.openai.com/docs/api-reference/chat/create#chat/create-temperature
  - `--top_p <top_p>`  
    Nucleus sampling parameter, top_p probability mass https://platform.openai.com/docs/api-reference/chat/create#chat/create-top_p
  - `--presence_penalty <presence_penalty>`  
    Penalty for new tokens based on their presence in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-presence_penalty
  - `--frequency_penalty <frequency_penalty`  
    Penalty for new tokens based on their frequency in the text so far https://platform.openai.com/docs/api-reference/chat/create#chat/create-frequency_penalty
  - `--logit_bias <logit_bias>`  
    Modify the likelihood of specified tokens appearing in the completion https://platform.openai.com/docs/api-reference/chat/create#chat/create-logit_bias


## Examples
### Plain text  
```bash
cli/translator.mjs --plain-text "你好"
```
Standard Output
```
Hello.
```
### Emojis
```bash
cli/translator.mjs --to "Emojis" --temperature 0 --plain-text "$(curl 'https://api.chucknorris.io/jokes/0ECUwLDTTYSaeFCq6YMa5A' | jq .value)"
```  
Input Argument
```
Chuck Norris can walk with the animals, talk with the animals; grunt and squeak and squawk with the animals... and the animals, without fail, always say 'yessir Mr. Norris'.
```
Standard Output
```
👨‍🦰💪🚶‍♂️🦜🐒🐘🐅🐆🐎🐖🐄🐑🦏🐊🐢🐍🐿️🐇🐿️❗️🌳💬😲👉🤵👨‍🦰👊=🐕🐑🐐🦌🐘🦏🦍🦧🦓🐅🦌🦌🦌🐆🦍🐘🐘🐗🦓=👍🤵.
```
### Scrambling
```bash
cli/translator.mjs --system-instruction "Scramble characters of words keeping only start and end letter" --temperature 0 --plain-text "Chuck Norris can walk with the animals, talk with the animals;"
```  
Standard Output
```
Cuhk Ciorrsn cna wlkak wtih the ainnmlas, takl wtih the ainnmlas;
```
```bash
cli/translator.mjs --system-instruction "Unscramble characters back to English" --temperature 0 --plain-text "Cuhckor Narisso acn alkwa wthi the aanimls"
```
Standard Output
```
Chuck Norris can walk with the animals, talk with the animals;
```

### Plain text file  
```bash
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
```bash
cli/translator.mjs --file test/data/test_ja.srt
```  
Input file: [test/data/test_ja.srt](test/data/test_ja.srt)
```srt
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
```srt
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

```srt
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

```srt
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
- No batching, with SRT stripping but one line per prompt with System Instruction overhead, including up to 10 historical prompt context:  
  Tokens: `362` 
- SRT stripping and line batching of 2:  
  Tokens: `276`

30 SRT lines:  
[test/data/test_ja.srt](test/data/test_ja.srt)
- None (Plain text SRT input output):  
  Tokens: `1625`
- No batching, with SRT stripping but one line per prompt with System Instruction overhead, including up to 10 historical prompt context:  
  Tokens: `6719` 
- SRT stripping and line batching of `[5, 10]`, including up to 10 historical prompt context:  
  Tokens: `1036`
