# ChatGPT API SRT Subtitle Translator
ChatGPT has also demonstrated its capabilities as a [robust translator](https://arxiv.org/abs/2303.13780), capable of handling not just common languages, but also unconventional forms of writing like emojis and [word scrambling](https://www.mrc-cbu.cam.ac.uk/people/matt.davis/cmabridge/). However, it may not always produce a deterministic output or adhere to line-to-line correlation, potentially disrupting the timing of subtitles, even when instructed to follow precise instructions and with the model `temperature` parameter set to [`0`](https://cobusgreyling.medium.com/example-code-implementation-considerations-for-gpt-3-5-turbo-chatml-whisper-e61f8703c5db).

This utility uses the OpenAI ChatGPT API to translate text, with a specific focus on line-based translation, especially for SRT subtitles. The translator optimizes token usage by removing SRT overhead and grouping text into batches, resulting in arbitrary length translations without excessive [token consumption](https://openai.com/api/pricing/) while ensuring a one-to-one match between line input and output.

### Upgrading from v2? See the [v2 -> v3 Migration Guide](docs/CHANGELOG.md#300-2026-03-01) for breaking changes.

## Web Interface: <https://cerlancism.github.io/chatgpt-subtitle-translator>  

## Features
- Web User Interface (Web UI) and Command Line Interface (CLI)  
- Supports [Structured Output](https://openai.com/index/introducing-structured-outputs-in-the-api/): for more concise results, available in the Web UI and in CLI with `-r, --structured`
- Supports [Prompt Caching](https://openai.com/index/api-prompt-caching/): by including the full context of translated data, the system instruction and translation context are packaged to work well with prompt caching, controlled with `-c, --context` (CLI only)
- Supports any OpenAI API compatible providers such as running [Ollama](https://ollama.com/) locally
- Line-based batching: avoids token limit per request, reduces overhead token wastage, and maintains translation context to a certain extent
- Optional OpenAI Moderation tool check: prevents token wastage if the model is highly likely to refuse to translate, enabled with `--use-moderator`
- Streaming process output  
- Request per minute (RPM) [rate limits](https://platform.openai.com/docs/guides/rate-limits/overview)  
- Progress resumption (CLI only)


## Setup
Reference: <https://github.com/openai/openai-quickstart-node#setup>
- Node.js version `>= 20` required. This README assumes `bash` shell environment
- Clone this repository and 
  ```bash
  git clone https://github.com/Cerlancism/chatgpt-subtitle-translator
  ``` 
- Navigate into the directory
  ```bash
  cd chatgpt-subtitle-translator
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

## CLI
```
cli/translator.mjs --help
```

`Usage: translator [options]`

`Translation tool based on ChatGPT API`


Options:
  - `--from <language>`  
    Source language (default: "") 
  - `--to <language>`  
    Target language (default: "English")
  - `-i, --input <file>`  
    Input source text with the content of this file, in `.srt` format or plain text
  - `-o, --output <file>`  
    Output file name, defaults to be based on input file name
  - `-s, --system-instruction <instruction>`  
    Override the prompt system instruction template `Translate ${from} to ${to}` with this plain text, ignoring `--from` and `--to` options
  - `--initial-prompts <prompts>`  
    Initial prompts for the translation in JSON (default: `"[]"`) 
  - `--use-moderator`
    Use the OpenAI API Moderation endpoint
  - `--moderation-model <model>`
    (default: `"omni-moderation-latest"`) https://developers.openai.com/api/docs/models  
  - `-b, --batch-sizes <sizes>`
    Batch sizes of increasing order for translation prompt slices in JSON Array (default: `"[10,50]"`)  

    The number of lines to include in each translation prompt, provided that they are estimated to be within the token limit.  
    In case of mismatched output line quantities, this number will be decreased step by step according to the values in the array, ultimately reaching one.

    Larger batch sizes generally lead to more efficient token utilization and potentially better contextual translation.  
    However, mismatched output line quantities or exceeding the token limit will cause token wastage, requiring resubmission of the batch with a smaller batch size.
  - `-r, --structured <mode>`
    [Structured response](https://openai.com/index/introducing-structured-outputs-in-the-api/) format mode with timestamp support. (default: `array`, choices: `array`, `timestamp`, `object`, `none`)
      - `array` Structures the input and output into a plain array format. More concise than `none` mode, though uses slightly more tokens per batch.
      - `timestamp` Provides the model with start/end timestamps alongside each entry's text, allowing it to merge adjacent entries into one. A batch is only retried when the output time span boundaries don't match the input - unlike other modes which retry on any line count mismatch - significantly reducing token wastage from retries. Uses more tokens per batch due to timestamps in input and a merge remarks field in output. Output entry count may differ from input, so progress file resumption is not supported.
      - `object` Structures the input and output as a keyed object.
      - `none` Disables structured output.

  - `-c, --context <tokens>`
    Include translation history up to a token budget to work well with [prompt caching](https://openai.com/index/api-prompt-caching/). Default: `2000`. Set to `0` to include history without a token limit check.

    The token budget is tracked from actual model response token counts. The history is chunked into user/assistant message pairs using the last value in `--batch-sizes`.

    Recommended value: set `<tokens>` to ~30% less than the model's max context length to leave room for the current batch and system prompts. For example, for a `128K` context model: `--context 90000`.
  - `--no-prefix-number`
    Don't prefix lines with numerical indices. Ignored in `-r, --structured` `array|object|timestamp` - prefix numbers are always disabled there.
  - `--no-line-matching`
    Don't enforce one to one line quantity input output matching. Ignored in `-r, --structured` `timestamp` - line matching is always disabled there since entries may be merged.
  - `-p, --plain-text <text>`
    Input source text with this plain text argument. Not supported in `-r, --structured` `timestamp`.
  - `--log-level <level>`  
    Log level (default: `debug`, choices: `trace`, `debug`, `info`, `warn`, `error`, `silent`)
  - `--silent`  
    Same as `--log-level silent`  
  - `--quiet`
    Same as `--log-level silent`
  - `--no-stream`
    Disable stream progress output to terminal (streaming is on by default)

Additional Options for GPT: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
  - `-m, --model <model>`
    (default: `"gpt-4o-mini"`) https://developers.openai.com/api/docs/models
  - `--reasoning_effort <reasoning_effort>`
    Constrains effort on reasoning for reasoning models. Accepted values depend on the model (e.g. `"low"`, `"medium"`, `"high"`); follows the model's default when not set. `"none"` disables reasoning/thinking entirely (supported by OpenAI o-series/GPT-5+ and open models via Ollama such as Qwen3).
  - `-t, --temperature <temperature>`
    Sampling temperature to use, should set a low value such as `0` to be more deterministic for translation (default: `0`)
  - `--top_p <top_p>`
    Nucleus sampling parameter, top_p probability mass
  - `--presence_penalty <presence_penalty>`
    Penalty for new tokens based on their presence in the text so far
  - `--frequency_penalty <frequency_penalty>`
    Penalty for new tokens based on their frequency in the text so far
  - `--logit_bias <logit_bias>`
    Modify the likelihood of specified tokens appearing in the completion


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
cli/translator.mjs --to "Emojis" --plain-text "$(curl 'https://api.chucknorris.io/jokes/0ECUwLDTTYSaeFCq6YMa5A' | jq .value)"
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
cli/translator.mjs --system-instruction "Scramble characters of words while only keeping the start and end letter" --no-prefix-number --no-line-matching --plain-text "Chuck Norris can walk with the animals, talk with the animals;"
```
Standard Output
```
Cuhck Nroris can wakl wtih the aiamnls, talk wtih the aiamnls;
```  
### Unscrabling
```bash
cli/translator.mjs --system-instruction "Unscramble characters back to English" --no-prefix-number --no-line-matching --plain-text "Cuhck Nroris can wakl wtih the aiamnls, talk wtih the aiamnls;"
```
Standard Output
```
Chuck Norris can walk with the animals, talk with the animals;
```

### Plain text file  
```bash
cli/translator.mjs --input test/data/test_cn.txt
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
cli/translator.mjs --input test/data/test_ja_small.srt
```  
Input file: [test/data/test_ja_small.srt](test/data/test_ja_small.srt)
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
Output file: [test/data/test_ja_small.srt.out_English.srt](test/data/test_ja_small.srt.out_English.srt)
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

## How it works
### Token Reductions
SRT timestamps and indices are stripped. Text lines are batched into a structured JSON user message; the model returns a matching structured JSON response. The translated lines are then reassembled back into SRT format.

**System Instruction**
Tokens: `3`
```
Translate to English
```
<table>
<tr>
<th>Input (SRT)</th>
<th>Prompt (User Message)</th>
<th>Transform (Model Response)</th>
<th>Output (SRT)</th>
</tr>
<tr>
<td>

Tokens: `139`

</td>
<td>

Tokens: `52`

</td>
<td>

Tokens: `38`

</td>
<td>

Tokens: `127`

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

*(compact JSON, formatted here for readability)*

```json
{
  "inputs": [
    "おはようございます。",
    "お元気ですか？",
    "はい、元気です。",
    "今日は天気がいいですね。",
    "はい、とてもいい天気です。"
  ]
}
```

</td>
<td valign="top">

*(compact JSON, formatted here for readability)*

```json
{
  "outputs": [
    "Good morning.",
    "How are you?",
    "Yes, I'm doing well.",
    "The weather is nice today, isn't it?",
    "Yes, it's very nice weather."
  ]
}
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
