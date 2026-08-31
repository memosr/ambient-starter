# ambient-starter

A small, dependency-free starting point for building on the [Ambient](https://ambient.xyz) API.
Plain Node 18+, ES modules, no build step. Clone it, delete what you do not need, keep going.

```
client.mjs            the whole client, comments included
health.mjs            CLI: which models are actually serving right now
examples/chat.mjs     simplest possible call
examples/stream.mjs   streaming plus time to first content token
examples/tools.mjs    full tool-call round trip with a safe calculator
```

## Quick start

```bash
export AMBIENT_API_KEY=sk-your-key-here

node health.mjs            # see what is serving before you pick a model
node examples/chat.mjs     # simplest call
node examples/stream.mjs   # streaming
node examples/tools.mjs    # tool calling
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AMBIENT_API_KEY` | none, required | Bearer token |
| `AMBIENT_MODEL` | `deepseek/deepseek-v4-flash-0731` | Default model for every example |
| `AMBIENT_API_BASE` | `https://api.ambient.xyz/v1` | Point at a proxy or a local gateway |

If the default model 404s, that is normal and expected. Run `node health.mjs`, pick an id
from the SERVING rows, and `export AMBIENT_MODEL=that-id`.

## Which endpoint to use

Use **`/v1/chat/completions`**. It is the OpenAI-compatible path and it is the reliable one.

Because it is OpenAI-compatible, the request and response bodies are the shapes you already
know: `messages`, `tools`, `stream`, `max_tokens` going in, and `choices[0].message.content`
coming back. That also means any OpenAI SDK can talk to Ambient by overriding the base URL,
if you would rather not use the client here:

```js
// The same idea using the openai package, if you prefer a dependency.
new OpenAI({ apiKey: process.env.AMBIENT_API_KEY, baseURL: 'https://api.ambient.xyz/v1' });
```

`/v1/models` is useful for discovery and that is all it is good for. It reports what the API
knows about, not what has capacity behind it this minute. See the gotchas below.

Other paths on the API surface come and go. If you find yourself reaching for a bespoke
endpoint, check whether the OpenAI-compatible one can express the same thing first.

## Using the client

```js
import { ambientChat } from './client.mjs';

const result = await ambientChat({
  messages: [{ role: 'user', content: 'Hello' }],
  maxTokens: 2000,
});

console.log(result.content);
```

`ambientChat` options:

| Option | Default | Notes |
| --- | --- | --- |
| `messages` | required | OpenAI-style message array |
| `model` | `DEFAULT_MODEL` | See the env table above |
| `fallbackModels` | `[]` | Tried in order when the primary is exhausted |
| `tools` / `toolChoice` | none | OpenAI-style tool definitions |
| `stream` | `false` | Parses SSE, calls `onDelta` per token |
| `onDelta` | none | `({ type: 'content' \| 'reasoning', text }) => void` |
| `maxTokens` | `1000` | Read the reasoning-token gotcha before lowering this |
| `temperature` | server default | Passed through only when set |
| `maxRetries` | `3` | Set to `0` to see raw failures, as `health.mjs` does |
| `timeoutMs` | `120000` | Hard cap per attempt, including a stalled stream |
| `onFallback` | none | `({ from, to, error }) => void`, useful for logging |

Both streaming and non-streaming resolve to the same object, so callers never branch on
`stream`:

```js
{ content, reasoning, toolCalls, finishReason, model, usage, raw }
```

Failures throw an `AmbientError` carrying `status`, `code`, `body`, `model`, and a `kind` of
`permanent`, `transient`, or `unavailable`.

### Retry and fallback behavior

| Response | What happens |
| --- | --- |
| 429, 5xx, network error, timeout | Retry with 1s, 2s, 4s backoff, up to 3 retries |
| 404 unknown model | No retry, fall straight over to the next `fallbackModels` entry |
| 400, 401, 402, 403, 422 | Throw immediately with a message explaining the likely cause |
| Retries exhausted | Move to the next fallback model, or throw if there is none |

Auth and billing errors never trigger a fallback, because a different model cannot fix a bad
key or an empty balance. Capacity errors do:

```js
await ambientChat({
  messages,
  model: 'the-one-you-want',
  fallbackModels: ['the-one-that-is-usually-up'],
  onFallback: ({ from, to, error }) => console.warn(`${from} -> ${to}: ${error.message}`),
});
```

One deliberate exception: if a stream has already emitted tokens and then breaks, the client
throws instead of retrying. Retrying there would print the first half of the answer twice.

## Model availability

**Run `node health.mjs` before assuming a model works.** Availability on Ambient varies by
model and by hour, in a way that a static config file cannot track.

```
$ node health.mjs
Probing 3 listed model(s) with max_tokens=64

MODEL                      STATUS     LATENCY  NOTE
---------------------------------------------------
deepseek/deepseek-v4-flash-0731  SERVING      412ms  "ok"
some-org/some-model        SERVING?    8021ms  200 but empty content (finish_reason: length)
another-org/retired-model  DOWN         230ms  429 no workers available for this model

2 of 3 listed models responded.
```

Three states, and the middle one is the interesting one:

- `SERVING` returned real text. Use it.
- `SERVING?` returned HTTP 200 with empty content. The model is up; the 64-token probe was
  simply too small for a reasoning model. Not a failure.
- `DOWN` returned an error. The note carries the status and the server's own message.

It exits non-zero when nothing responds, so it works as a CI or pre-deploy gate.

## Gotchas

These are the things that cost people an afternoon.

### 1. Reasoning tokens are spent from your `max_tokens` budget

Reasoning models generate hidden reasoning tokens **before** emitting a single character of
visible content, and those tokens come out of the same `max_tokens` budget. So this:

```js
await ambientChat({ messages, maxTokens: 50 });
```

returns HTTP 200, `finish_reason: "length"`, and `content: ""`. No error, no warning, nothing
in the logs. It looks exactly like a broken model, but the request worked perfectly and the
budget simply ran out during reasoning.

The default here is 1000, which covers short answers. Raise it to 4000 or more for anything
that requires real thinking. If you get an empty `content`, check `finishReason` first and
raise `maxTokens` before you go debugging anything else.

The client returns reasoning separately so you can see where the budget went:

```js
const { content, reasoning, finishReason } = await ambientChat({ messages, maxTokens: 4000 });
console.log(reasoning.length, content.length, finishReason);
```

Note also that some backends name this field `reasoning_content` and others name it
`reasoning`. The client accepts both, in streaming and non-streaming responses.

### 2. A 429 does not always mean rate limiting

On a decentralized network, 429 is overloaded. It can mean:

- you are genuinely sending too many requests, or
- **there are no workers currently serving that model.**

Same status code, completely different fix. Backing off and retrying is right for the first
and useless for the second, where the fix is switching models or waiting for capacity.

**Read the message body to tell them apart.** The client keeps it on the error:

```js
try {
  await ambientChat({ messages });
} catch (error) {
  if (error.status === 429) {
    console.error(error.message);  // includes the server's own wording
    console.error(error.body);     // the parsed error payload
  }
}
```

This is the main reason `fallbackModels` exists. If a 429 survives three retries, the odds
that it is a capacity problem rather than a rate limit are high, and another model usually
works right away.

### 3. Model IDs change over time

Models get added, renamed, and retired as the network evolves. A model id hardcoded three
months ago may 404 today, and the id you find in a blog post may never have existed on this
deployment.

Consequences worth designing around:

- Do not hardcode a model id in more than one place. Here it lives in `DEFAULT_MODEL` in
  `client.mjs`, overridable with `AMBIENT_MODEL`.
- Treat 404 as "pick a different model", which is exactly what the fallback logic does.
- Run `node health.mjs` when something that worked yesterday stops working. It is the fastest
  way to tell "my code broke" from "that model went away".

### 4. Being listed is not the same as being available

`/v1/models` is a catalogue, not a status page. A model can be listed and still return 429 for
every request because nothing is serving it. `health.mjs` exists precisely because these two
things disagree often enough to matter.

### 5. Smaller things

- **Usage stats are missing when streaming.** The client returns `usage: null` for streamed
  responses, since usage arrives in a final chunk only when the server is asked for it and not
  every backend accepts that request. Make the non-streaming call if you need exact counts.
- **Tool support varies by model.** Not every model on the network handles `tools`. Some
  return 400, others accept the request and answer in prose without ever calling the tool.
  `examples/tools.mjs` handles the second case explicitly instead of crashing on an empty
  `toolCalls` array.
- **Never `eval` tool arguments.** Tool arguments are model output shaped by user input.
  `examples/tools.mjs` ships a short recursive descent parser for exactly this reason.
- **Tool arguments are sometimes malformed JSON.** Wrap `JSON.parse` on
  `tool_calls[].function.arguments`. The example does.
- **Streams stall.** Every attempt is capped by `timeoutMs` (120s by default), which covers a
  connection that opens and then goes quiet.

## License

Do whatever you want with this.
