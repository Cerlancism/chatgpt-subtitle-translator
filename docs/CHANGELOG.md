# Changelog

## 3.4.0 (draft)

### Deprecations

#### `translateSrtLines` deprecated (library API)

`TranslatorStructuredTimestamp.translateSrtLines()` (introduced with timestamp mode in 3.0.0) and `TranslatorAgent.translateSrtLines()` (introduced with agent mode in 3.1.0) are deprecated and now simply delegate to `translateLines()`, which accepts the translator's input entry type directly - plain strings for the string-based modes, timestamp entries for `timestamp` mode - and yields the matching output type.

```js
// deprecated
for await (const output of translator.translateSrtLines(entries)) { /* ... */ }

// preferred
for await (const output of translator.translateLines(entries)) { /* ... */ }
```

CLI usage is unaffected.

### New Features

#### Evened-out auto batch sizes

When `--batch-sizes` is omitted, batch sizes are now spread evenly across the remaining lines instead of greedily filled to the token budget. Greedy filling left a small remainder batch at the tail (e.g. 100 lines packing 30 per batch produced batches of 30/30/30/10); the same lines now translate as 25/25/25/25, improving context consistency and prompt cache utilization across batches.

The same evening applies to agent-mode planning scan windows, and is preserved while the batch size is temporarily reduced after a failure.

#### Moderation support in `timestamp` mode

`--use-moderator` now works in `-r timestamp` mode (previously it was silently ignored). The moderation check inspects only the text content of each batch - timestamps are excluded.

As in the other modes, moderation serves to prevent token wastage when the model is highly likely to refuse a batch, not as a content gate: flagged batches are retried at smaller sizes, ultimately falling back to single-entry translation.

#### Timestamp mode: merge remarks field removed

The `timestamp` mode output schema no longer includes the `remarksIfContainedMergers` field, reducing output tokens per batch. The merge readability guidance (keep merged text within ~42 characters) is retained in the schema description.

#### Timestamp mode: offset/length wire encoding

The `timestamp` mode wire format now sends each entry as `offset`/`length` (start time and duration) instead of `start`/`end`, and each batch carries its absolute start time as a single top-level `offset` field with entry offsets relative to it:

```yaml
offset: 5400000
inputs[2]{offset,length,text}:
  0,1500,今日はとてもいい天気ですね。
  1500,2200,桜が満開で、本当に綺麗です。
```

Absolute millisecond timestamps grow to 7 digits over a feature-length runtime, so batches later in the file previously cost more tokens and required the model to reproduce long near-identical digit strings without drift. With the relative encoding the numbers stay small (mostly 1-4 digits) regardless of position: mid-file batches of short dialogue measure ~5% fewer prompt tokens and ~9% fewer combined prompt+response tokens, with the same saving applying to every context-history replay. Timestamps are reconstructed exactly on parse; SRT output and the library API are unchanged.

### Fixes

#### Auto batch size recovers gradually after failures

In auto batch mode, a failure reduces the batch size for retries, previously a single successful batch immediately restored the full size, which could thrash between failing large batches and recovering. The reduction now eases back stepwise after every few consecutive successful batches.

#### Repetition guard input pre-check threshold

The input pre-check introduced in 3.3.2 now raises the effective guard threshold only when the input itself contains a pattern repeated at least the full `--guard-repetition` threshold (previously more than half), and the raised threshold is fixed at 3x the configured value (previously 3x the detected repeat count). This makes the guard less likely to be loosened by mildly repetitive input.

#### `--plain-text` with the `agent` subcommand

`cli/translator.mjs agent --plain-text "..."` previously failed with an `Expected Translator` error. It now runs the agent planning passes and translates the text using the default `array` delegate, as documented. Combining `--plain-text` with `-r timestamp` remains unsupported.

### Other Changes

- Repetition abort warnings now report the detected pattern's occurrence count and the active threshold.

---

## 3.3.2 (2026-04-14)

- Repetition guard now checks input for existing repetition before translating. When the source text itself contains a pattern repeated more than half the guard threshold, the threshold is automatically raised to 3x the detected count to avoid false-positive aborts.

## 3.3.1 (2026-04-09)

### New Features

#### Stream Repetition Guard (`-g, --guard-repetition`)

A new option that monitors streaming responses for looping output and aborts the request before it wastes too many tokens.

- **`-g, --guard-repetition <threshold>`** - minimum number of times a pattern must repeat before the stream is aborted. Defaults to `10`. Set to `0` to disable.
- On detection, the current batch is retried automatically.
- Applied across all translation modes: plain, `array`, `object`, and `timestamp`.

#### Agent Planning: LLM-Based Summary Fitting

Planning pass summaries that fall outside the target token range are now re-fit using the `llm-summary` `summarise` function (two-phase draft -> fit), replacing the previous direct model call for consolidation. This applies to both per-window batch summaries and accumulated consolidation steps.

- **`--no-fitting`** - skip LLM-based fitting for both scan-window summaries and consolidation. Summaries are used as-is regardless of token range.

## 3.2.0 (2026-04-02)

### New Features

#### Agent Mode Improvements (`agent` subcommand)

A new `agent` subcommand comes with a set of specific configurable options. It is still also available as `-r, --structured agent` for the default configuration, which uses now `array` mode as the delegate.

The agent mode has been expanded into a multi-pass pipeline:

**Overview pass:** Samples the file to generate a content overview (file identity, duration, entry count, genre/tone, character names) and detects the source language.

**Planning pass:** Scans the file in token-bounded windows derived from the context budget, rather than fixed max-batch-size chunks. Each window produces a batch summary. Summaries are consolidated and used to generate a refined translation instruction. The final refinement step can be skipped with `--skip-refine`.

**Translation pass:** Uses the enriched instruction. The delegate translation mode defaults to `array`, pass `-r timestamp` alongside the `agent` subcommand to use timestamp mode instead.

```bash
# Default (array delegate)
cli/translator.mjs agent -i subtitles.srt --from Japanese --to English

# Timestamp delegate
cli/translator.mjs agent -i subtitles.srt -r timestamp --from Japanese --to English
```

New options available for `agent` subcommand:
- `--context-summary`: Provide a context summary directly, skipping the planning pass entirely.
- `--skip-refine`: Bypass the final instruction refinement step at the end of the planning pass.

**Language verification:** Before translation begins, a sample of the input is checked to confirm the detected source language. A sample of the first batch output is then verified to confirm it matches the target language before proceeding.

#### Auto Batch Size

When `--batch-sizes` is omitted, the batch size is now derived automatically from the context budget (`-c, --context`).

---

## 3.1.0 (2026-03-15)

### New Features

#### Agent Mode (`-r, --structured agent`)

A multi-pass agentic translation mode.

**Planning pass:** Scans the full subtitle file in max-batch-size chunks. For each chunk the model produces a batch summary (character names, locations, events, tone, dialect). Summaries accumulate and are consolidated when they exceed the token budget. At the end of the scan, a refined system instruction is generated that filters the glossary and stylistic notes down to only what was observed in the file.

**Translation pass:** Runs identically to `timestamp` mode using the enriched instruction.

Best suited for content with recurring characters, specialized vocabulary, or stylistic consistency requirements. Costs additional API calls for the planning pass. Progress file resumption is not supported.

```bash
cli/translator.mjs -i subtitles.srt -r agent --from Japanese --to English
```

### Other Changes

#### `OPENAI_DEFAULT_MODEL` environment variable

A new optional env var that sets the default model instead of hardcoding `gpt-4o-mini`. Useful when you always use a different model without passing `-m` on every invocation.

```env
OPENAI_DEFAULT_MODEL=gpt-4o
```

#### `OPENAI_API_RPM` default raised to 500

The default requests-per-minute limit was raised from `60` to `500` to better match typical API tier limits. The `.env.example` value is now commented out (the built-in default applies unless you override it).

The fallback order for the moderator RPM was also corrected: `OPENAI_API_MODERATOR_RPM` is now checked before `OPENAI_API_RPM` (previously the two were swapped).

#### Context selection now uses real token counts

Context history chunking (`-c, --context`) switched from using model-reported completion token counts as a proxy to counting tokens directly with [`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer). This makes the budget more accurate and independent of whether a prior response recorded token usage.

---

## 3.0.0 (2026-03-01)

### Breaking Changes

#### CLI Options Removed

| Removed Option | Replacement |
|---|---|
| `-f, --file <file>` | `-i, --input <file>` |
| `-l, --history-prompt-length <length>` | Use the last value in `-b, --batch-sizes` |
| `--experimental-structured-mode [mode]` | `-r, --structured <mode>` |
| `--experimental-use-full-context` | `-c, --context <tokens>` |
| `--experimental-fallback-model <value>` | _(removed, no replacement)_ |
| `--no-use-moderator` | `--use-moderator` _(inverted - moderation is now **off** by default)_ |

#### CLI Options Changed

- **`--stream` -> `--no-stream`**: Streaming is now **enabled by default**. Pass `--no-stream` to disable it.
- **`--temperature`**: Now defaults to `0` (was previously unset, leaving the model default). Deterministic preferred output is now the default.
- **`-r, --structured`**: Promoted from `--experimental-structured-mode`. Now accepts `array` | `timestamp` | `object` | `none`, and defaults to `"array"`. In v2, structured output was an opt-in experimental flag - omitting `--experimental-structured-mode` was implicitly equivalent to `none`. In v3, `none` is an explicit value you must pass to replicate that behaviour, since `array` is now the default. Passing `-r none` disables structured output entirely and falls back to free-form text responses, the same as the v2 default.
- **`-c, --context <tokens>`**: Promoted from `--experimental-use-full-context`. Accepts a token budget integer (default `2000`). Set to `0` to include history without a token limit check.

#### Defaults Changed

| Option | v2 Default | v3 Default |
|---|---|---|
| `--structured` | `none` (disabled) | `array` |
| `--stream` | disabled | enabled |
| `--temperature` | _(model default)_ | `0` |
| `--use-moderator` | enabled | disabled |
| `--context` | disabled | `2000` tokens |
| `--batch-sizes` | `[10, 100]` | `[10, 50]` |

#### Runtime Requirements

- **Node.js**: Minimum version raised from 16 to **20**.

---

### New Features

#### Timestamp Mode (`-r timestamp`)

A new structured output mode that provides the model with start/end timestamps alongside each subtitle entry. Unlike other modes, the model is permitted to **merge adjacent entries**, enabling more natural translated output.

- Batch retries only when output time-span boundaries don't match input (reduces token waste on retries).
- Output entry count may differ from input - progress file resumption is **not supported** in this mode.
- Not compatible with `--plain-text`.

```bash
cli/translator.mjs -i subtitles.srt -r timestamp
```

#### Context Token Budget (`-c, --context <tokens>`)

Replaces `--experimental-use-full-context`. Accepts a maximum token budget for translation history. History is chunked by the last value in `--batch-sizes` to be compatible with prompt caching.

```bash
# Use up to 90,000 tokens of history (e.g., for a model with 128k context)
cli/translator.mjs -i subtitles.srt -c 90000
```

Set to `0` to include history without a token limit check:

```bash
cli/translator.mjs -i subtitles.srt -c 0
```

#### Streaming On by Default

Streaming output to the terminal is now on by default. This gives real-time feedback during long translations. Use `--no-stream` to disable if you need clean stdout.

#### `--reasoning_effort` Support

Pass reasoning effort hints (`low`, `medium`, `high`, or `none`) to reasoning models (OpenAI o-series, GPT-5+, or compatible open models via Ollama). Use `"none"` to disable reasoning/thinking entirely.

```bash
cli/translator.mjs -i subtitles.srt -m o3-mini --reasoning_effort low
```

---

### Internal Changes

- Replaced `JSONStream` with `@streamparser/json-node` for improved JSON streaming.
- Replaced `readline` (legacy) with the built-in `node:readline`.
- Token usage logging: improved breakdown formatting, removed pricing data.
- Context budget logged at debug level on each batch.

---

## Migration Guide: v2 -> v3

### Node.js Requirement

v3 requires Node.js **20 or later**.

```bash
node --version  # must be >= 20
```

### Removed Options

#### `-f` / `--file` (removed)

```bash
# v2
cli/translator.mjs -f subtitles.srt

# v3
cli/translator.mjs -i subtitles.srt
```

#### `-l` / `--history-prompt-length` (removed)

History chunk size is now controlled by the last value in `--batch-sizes`.

```bash
# v2
cli/translator.mjs -l 50 -i subtitles.srt

# v3 - set the last batch size to the desired history chunk length
cli/translator.mjs -b "[10, 50]" -i subtitles.srt
```

#### `--experimental-structured-mode` -> `-r` / `--structured`

```bash
# v2
cli/translator.mjs --experimental-structured-mode array -i subtitles.srt

# v3
cli/translator.mjs -r array -i subtitles.srt
```

To disable structured output (equivalent to v2 default):

```bash
cli/translator.mjs -r none -i subtitles.srt
```

#### `--experimental-use-full-context` -> `-c` / `--context`

```bash
# v2
cli/translator.mjs --experimental-use-full-context -i subtitles.srt

# v3 - provide a token budget (or omit to use the default of 2000)
cli/translator.mjs -c 2000 -i subtitles.srt

# v3 - set to 0 to include history without a token limit check
cli/translator.mjs -c 0 -i subtitles.srt
```

#### `--no-use-moderator` (inverted)

Moderation is now **off by default**. If you were previously not passing `--no-use-moderator` and relied on moderation being active, you must now opt in:

```bash
# v2 - moderation was on unless you passed --no-use-moderator
cli/translator.mjs -i subtitles.srt

# v3 - moderation is off by default, opt in explicitly
cli/translator.mjs --use-moderator -i subtitles.srt
```

#### `--experimental-fallback-model` (removed)

This option has been removed with no direct replacement. Remove it from any scripts.

### Updated Defaults

If your v2 scripts relied on the old defaults, you may need to add flags to preserve the previous behaviour:

| Old behaviour | v3 flag to restore it |
|---|---|
| No structured output | `-r none` |
| No streaming | `--no-stream` |
| Model-default temperature | `-t <value>` _(specify explicitly)_ |
| Moderation enabled | `--use-moderator` |
| Unbounded context (no token limit) | `-c 0` |

### `--stream` Flag

If you were explicitly passing `--stream` to enable streaming, that flag no longer exists. Streaming is on by default, remove the flag.

```bash
# v2
cli/translator.mjs --stream -i subtitles.srt

# v3
cli/translator.mjs -i subtitles.srt
```
