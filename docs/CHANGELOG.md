# Changelog

## 3.0.0 (2026-03-01)

### Breaking Changes

#### CLI Options Removed

| Removed Option | Replacement |
|---|---|
| `-f, --file <file>` | `-i, -i <file>` |
| `-l, --history-prompt-length <length>` | Use the last value in `-b, --batch-sizes` |
| `--experimental-structured-mode [mode]` | `-r, --structured <mode>` |
| `--experimental-use-full-context` | `-c, --context <tokens>` |W
| `--experimental-fallback-model <value>` | _(removed, no replacement)_ |
| `--no-use-moderator` | `--use-moderator` _(inverted - moderation is now **off** by default)_ |

#### CLI Options Changed

- **`--stream` → `--no-stream`**: Streaming is now **enabled by default**. Pass `--no-stream` to disable it.
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

- **Node.js**: Minimum version raised from 18 to **20**.

---

### New Features

#### Timestamp Mode (`-r timestamp`)

A new structured output mode that provides the model with start/end timestamps alongside each subtitle entry. Unlike other modes, the model is permitted to **merge adjacent entries**, enabling more natural translated output.

- Batch retries only when output time-span boundaries don't match input (reduces token waste on retries).
- Output entry count may differ from input - progress file resumption is **not supported** in this mode.
- Not compatible with `--plain-text`.

```bash
translator -i subtitles.srt -r timestamp
```

#### Context Token Budget (`-c, --context <tokens>`)

Replaces `--experimental-use-full-context`. Accepts a maximum token budget for translation history. History is chunked by the last value in `--batch-sizes` to be compatible with prompt caching.

```bash
# Use up to 90,000 tokens of history (e.g., for a model with 128k context)
translator -i subtitles.srt -c 90000
```

Set to `0` to disable token-budget slicing. History is still included, falling back to the last `currentBatchSize` entries rather than a token-bounded slice:

```bash
translator -i subtitles.srt -c 0
```

#### Streaming On by Default

Streaming output to the terminal is now on by default. This gives real-time feedback during long translations. Use `--no-stream` to disable if you need clean stdout.

#### `--reasoning_effort` Support

Pass reasoning effort hints (`low`, `medium`, `high`, or `none`) to reasoning models (OpenAI o-series, GPT-5+, or compatible open models via Ollama). Use `"none"` to disable reasoning/thinking entirely.

```bash
translator -i subtitles.srt -m o3-mini --reasoning_effort low
```

---

### Internal Changes

- Replaced `JSONStream` with `@streamparser/json-node` for improved JSON streaming.
- Replaced `readline` (legacy) with the built-in `node:readline`.
- Structured output schema unified for single and batch requests.
- Token usage logging improved (formatted, without pricing data).
- Context budget logged at debug level on each batch.

---

## Migration Guide: v2 → v3

### Node.js Requirement

v3 requires Node.js **20 or later**.

```bash
node --version  # must be >= 20
```

### Removed Options

#### `-f` / `--file` (removed)

```bash
# v2
translator -f subtitles.srt

# v3
translator -i subtitles.srt
```

#### `-l` / `--history-prompt-length` (removed)

History chunk size is now controlled by the last value in `--batch-sizes`.

```bash
# v2
translator -l 50 -i subtitles.srt

# v3 - set the last batch size to the desired history chunk length
translator -b "[10, 50]" -i subtitles.srt
```

#### `--experimental-structured-mode` → `-r` / `--structured`

```bash
# v2
translator --experimental-structured-mode array -i subtitles.srt

# v3
translator -r array -i subtitles.srt
```

To disable structured output (equivalent to v2 default):

```bash
translator -r none -i subtitles.srt
```

#### `--experimental-use-full-context` → `-c` / `--context`

```bash
# v2
translator --experimental-use-full-context -i subtitles.srt

# v3 - provide a token budget (or omit to use the default of 2000)
translator -c 2000 -i subtitles.srt

# v3 - set to 0 to include history without a token limit check
translator -c 0 -i subtitles.srt
```

#### `--no-use-moderator` (inverted)

Moderation is now **off by default**. If you were previously not passing `--no-use-moderator` and relied on moderation being active, you must now opt in:

```bash
# v2 - moderation was on unless you passed --no-use-moderator
translator -i subtitles.srt

# v3 - moderation is off by default; opt in explicitly
translator --use-moderator -i subtitles.srt
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

If you were explicitly passing `--stream` to enable streaming, that flag no longer exists. Streaming is on by default; remove the flag.

```bash
# v2
translator --stream -i subtitles.srt

# v3
translator -i subtitles.srt
```
