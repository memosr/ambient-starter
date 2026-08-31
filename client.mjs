// Minimal Ambient API client. Node 18+, zero dependencies.
//
// Ambient serves an OpenAI-compatible chat completions endpoint, so the request
// and response shapes here match the OpenAI spec. See README.md for gotchas.

const API_BASE = process.env.AMBIENT_API_BASE ?? 'https://api.ambient.xyz/v1';
const CHAT_URL = `${API_BASE}/chat/completions`;

// Model IDs on Ambient change as models roll in and out of the network.
// Run `node health.mjs` to see what is actually serving before hardcoding one.
export const DEFAULT_MODEL = process.env.AMBIENT_MODEL ?? 'deepseek/deepseek-v4-flash-0731';

// IMPORTANT: reasoning models spend this budget on hidden reasoning tokens
// BEFORE emitting a single character of visible content. Set it too low (say 50)
// and the request succeeds with finish_reason "length" and an empty content
// string, which looks exactly like a broken model but is not. 1000 covers short
// answers. Raise it to 4000+ for anything that needs real thinking.
const DEFAULT_MAX_TOKENS = 1000;

const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];
const DEFAULT_TIMEOUT_MS = 120_000;

// Statuses that will never succeed on retry, no matter how long you wait.
const PERMANENT_STATUS = new Set([400, 401, 402, 403, 422]);

// Attached to error messages so the cause is obvious at the call site.
const STATUS_HINTS = {
  400: 'bad request, check the body (does this model support tools?)',
  401: 'AMBIENT_API_KEY is missing or not valid',
  402: 'the account is out of credit',
  403: 'this key is not allowed to use that model or endpoint',
  404: 'unknown model id, run `node health.mjs` to see what is serving',
  429: 'rate limited OR no workers available for this model, read the body to tell which',
};

export class AmbientError extends Error {
  constructor(message, { status = null, kind = 'permanent', code = null, body = null, model = null, cause = null } = {}) {
    super(message);
    this.name = 'AmbientError';
    this.status = status;
    this.kind = kind; // 'permanent' | 'transient' | 'unavailable'
    this.code = code;
    this.body = body;
    this.model = model;
    this.cause = cause;
    this.emitted = false; // set when tokens already reached the caller
  }
}

/**
 * Send a chat completion request.
 *
 * @param {object}   opts
 * @param {Array}    opts.messages         OpenAI-style message array (required)
 * @param {string}   [opts.model]          Model id, defaults to DEFAULT_MODEL
 * @param {string[]} [opts.fallbackModels] Tried in order if the primary is exhausted
 * @param {Array}    [opts.tools]          OpenAI-style tool definitions
 * @param {string|object} [opts.toolChoice]
 * @param {boolean}  [opts.stream]         Parse SSE and call onDelta as tokens arrive
 * @param {Function} [opts.onDelta]        ({ type: 'content' | 'reasoning', text }) => void
 * @param {number}   [opts.maxTokens]      Defaults to 1000, see comment above
 * @param {number}   [opts.temperature]
 * @param {number}   [opts.maxRetries]     Defaults to 3
 * @param {number}   [opts.timeoutMs]      Hard cap per attempt, defaults to 120s
 * @param {Function} [opts.onFallback]     ({ from, to, error }) => void
 * @returns {Promise<{content: string, reasoning: string, toolCalls: Array,
 *                    finishReason: string|null, model: string, usage: object|null, raw: object|null}>}
 *
 * Streaming and non-streaming resolve to the same shape, so callers do not have
 * to branch on `stream`. With stream: true you also get tokens live via onDelta.
 */
export async function ambientChat({
  messages,
  model = DEFAULT_MODEL,
  fallbackModels = [],
  tools,
  toolChoice,
  stream = false,
  onDelta,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature,
  maxRetries = DEFAULT_MAX_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onFallback,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AmbientError('ambientChat needs a non-empty `messages` array');
  }

  const candidates = [model, ...fallbackModels];
  let lastError = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      return await requestWithRetries({
        model: candidate, messages, tools, toolChoice, stream,
        onDelta, maxTokens, temperature, maxRetries, timeoutMs,
      });
    } catch (error) {
      lastError = error;
      const isLast = i === candidates.length - 1;
      // Auth and billing problems follow the key, not the model, so switching
      // models cannot help. Only fall over for capacity or availability faults.
      if (isLast || !canFallOver(error)) throw error;
      onFallback?.({ from: candidate, to: candidates[i + 1], error });
    }
  }

  throw lastError;
}

function canFallOver(error) {
  if (error?.emitted) return false; // do not restart a stream mid-output
  return error?.kind === 'transient' || error?.kind === 'unavailable';
}

async function requestWithRetries(config) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await performRequest(config);
    } catch (error) {
      const outOfAttempts = attempt >= config.maxRetries;
      // Permanent errors throw on the first try, no backoff, no waiting.
      if (outOfAttempts || error?.kind !== 'transient' || error?.emitted) throw error;
      await sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
    }
  }
}

async function performRequest({ model, messages, tools, toolChoice, stream, onDelta, maxTokens, temperature, timeoutMs }) {
  const apiKey = process.env.AMBIENT_API_KEY;
  if (!apiKey) {
    throw new AmbientError('AMBIENT_API_KEY is not set. Run: export AMBIENT_API_KEY=sk-...');
  }

  const body = { model, messages, max_tokens: maxTokens, stream: Boolean(stream) };
  if (tools?.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (temperature !== undefined) body.temperature = temperature;

  let response;
  try {
    response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      // Upper bound on the whole attempt, including a stalled stream.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new AmbientError(`network error calling ${CHAT_URL}: ${cause.message}`, {
      kind: 'transient', model, cause,
    });
  }

  if (!response.ok) throw await errorFromResponse(response, model);

  return stream
    ? readStream(response, { model, onDelta })
    : parseCompletion(await response.json(), model);
}

async function errorFromResponse(response, model) {
  const text = await response.text().catch(() => '');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* server returned plain text */ }

  const detail = parsed?.error?.message ?? parsed?.message ?? text.slice(0, 300) ?? '';
  const hint = STATUS_HINTS[response.status];
  const message = [
    `Ambient API ${response.status} for model "${model}"`,
    detail || response.statusText,
    hint ? `(${hint})` : '',
  ].filter(Boolean).join(': ');

  return new AmbientError(message, {
    status: response.status,
    kind: classifyStatus(response.status),
    code: parsed?.error?.code ?? null,
    body: parsed ?? text,
    model,
  });
}

function classifyStatus(status) {
  if (PERMANENT_STATUS.has(status)) return 'permanent';
  if (status === 404) return 'unavailable';        // retired or misspelled model id
  if (status === 429 || status >= 500) return 'transient';
  return 'permanent';
}

function parseCompletion(data, model) {
  const choice = data?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  return {
    content: message.content ?? '',
    // Different backends name this differently, so accept both spellings.
    reasoning: message.reasoning_content ?? message.reasoning ?? '',
    toolCalls: message.tool_calls ?? [],
    finishReason: choice.finish_reason ?? null,
    model: data?.model ?? model,
    usage: data?.usage ?? null,
    raw: data,
  };
}

/**
 * Parse an SSE stream, keeping reasoning deltas separate from content deltas.
 * Uses getReader() rather than `for await (const c of response.body)` because
 * async iteration over a fetch body is not guaranteed across every 18+ runtime.
 */
async function readStream(response, { model, onDelta }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  let resolvedModel = model;
  let emitted = false;
  const toolCalls = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // Events are separated by a blank line. Normalise CRLF first.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue; // skip comments and event: lines
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; } // keepalive or partial

          resolvedModel = chunk.model ?? resolvedModel;
          usage = chunk.usage ?? usage;

          const choice = chunk.choices?.[0];
          if (!choice) continue;
          finishReason = choice.finish_reason ?? finishReason;

          const delta = choice.delta ?? {};
          const reasoningText = delta.reasoning_content ?? delta.reasoning;
          if (reasoningText) {
            reasoning += reasoningText;
            emitted = true;
            onDelta?.({ type: 'reasoning', text: reasoningText });
          }
          if (delta.content) {
            content += delta.content;
            emitted = true;
            onDelta?.({ type: 'content', text: delta.content });
          }
          accumulateToolCalls(toolCalls, delta.tool_calls);
        }
      }
    }
  } catch (cause) {
    const error = new AmbientError(`stream failed for model "${model}": ${cause.message}`, {
      kind: 'transient', model, cause,
    });
    // Retrying now would print the first half of the answer twice, so the retry
    // loop treats an already-emitting stream as unrecoverable.
    error.emitted = emitted;
    throw error;
  } finally {
    reader.releaseLock();
  }

  return { content, reasoning, toolCalls, finishReason, model: resolvedModel, usage, raw: null };
}

// Tool calls arrive in fragments: the name in one chunk, the JSON arguments
// spread across many. Each fragment carries the index of the call it belongs to.
function accumulateToolCalls(toolCalls, deltas) {
  for (const delta of deltas ?? []) {
    const index = delta.index ?? 0;
    toolCalls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
    const slot = toolCalls[index];
    if (delta.id) slot.id = delta.id;
    if (delta.type) slot.type = delta.type;
    if (delta.function?.name) slot.function.name += delta.function.name;
    if (delta.function?.arguments) slot.function.arguments += delta.function.arguments;
  }
}

/** GET /v1/models. Returns the ids the API says it knows about. */
export async function listModels({ timeoutMs = 30_000 } = {}) {
  const apiKey = process.env.AMBIENT_API_KEY;
  if (!apiKey) throw new AmbientError('AMBIENT_API_KEY is not set');

  const response = await fetch(`${API_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await errorFromResponse(response, '(models)');

  const data = await response.json();
  return (data?.data ?? []).map((entry) => entry.id).filter(Boolean).sort();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
