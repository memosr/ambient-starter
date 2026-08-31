#!/usr/bin/env node
// Usage: node health.mjs
//
// /v1/models tells you what the API knows about. It does not tell you what has
// workers behind it right now. This script lists the models, sends each one a
// tiny probe, and prints what is actually serving.

import { ambientChat, listModels, AmbientError } from './client.mjs';

const PROBE_PROMPT = 'Reply with the single word: ok';
const PROBE_MAX_TOKENS = 64;   // small, but not so small that a reasoning model returns nothing
const PROBE_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;         // be polite, a burst of probes can trip rate limits
const NOTE_WIDTH = 58;

const STATUS_LABEL = {
  serving: 'SERVING',
  empty: 'SERVING?',
  down: 'DOWN',
};

async function main() {
  let models;
  try {
    models = await listModels();
  } catch (error) {
    console.error(`Could not list models: ${error.message}`);
    process.exit(1);
  }

  if (models.length === 0) {
    console.error('/v1/models returned an empty list.');
    process.exit(1);
  }

  console.log(`Probing ${models.length} listed model(s) with max_tokens=${PROBE_MAX_TOKENS}\n`);
  const results = await mapWithConcurrency(models, CONCURRENCY, probe);
  printTable(results);

  const serving = results.filter((r) => r.status !== 'down').length;
  console.log(`\n${serving} of ${results.length} listed models responded.`);
  // Non-zero exit makes this usable as a CI or pre-deploy gate.
  process.exit(serving === 0 ? 1 : 0);
}

async function probe(model) {
  const startedAt = Date.now();
  try {
    // maxRetries: 0 on purpose. This is a snapshot of right now, and retrying
    // would hide exactly the capacity problem we are trying to observe.
    const result = await ambientChat({
      model,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      maxTokens: PROBE_MAX_TOKENS,
      maxRetries: 0,
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    const ms = Date.now() - startedAt;
    const reply = result.content.trim().replace(/\s+/g, ' ');
    if (reply) return { model, status: 'serving', ms, note: `"${truncate(reply, 30)}"` };

    // A 200 with no content usually means the reasoning budget ate every token.
    // The model is up, the probe was just too small for it.
    return {
      model,
      status: 'empty',
      ms,
      note: `200 but empty content (finish_reason: ${result.finishReason ?? 'none'})`,
    };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const status = error instanceof AmbientError && error.status ? `${error.status}` : 'ERR';
    // Prefer the server's own wording over the client's wrapper message. This is
    // what tells a real rate limit apart from "no workers for this model".
    const detail = error.body?.error?.message ?? error.body?.message ?? firstLine(error.message);
    return { model, status: 'down', ms, note: `${status} ${detail}` };
  }
}

function printTable(results) {
  const rows = [...results].sort(byStatusThenLatency);
  const modelWidth = Math.max(5, ...rows.map((r) => r.model.length));
  const statusWidth = Math.max(...Object.values(STATUS_LABEL).map((s) => s.length));

  const header =
    'MODEL'.padEnd(modelWidth) + '  ' +
    'STATUS'.padEnd(statusWidth) + '  ' +
    'LATENCY'.padStart(8) + '  NOTE';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    console.log(
      row.model.padEnd(modelWidth) + '  ' +
      STATUS_LABEL[row.status].padEnd(statusWidth) + '  ' +
      `${row.ms}ms`.padStart(8) + '  ' +
      truncate(row.note, NOTE_WIDTH),
    );
  }
}

// Serving first, then the maybes, then the dead ones. Fastest first within a group.
function byStatusThenLatency(a, b) {
  const rank = { serving: 0, empty: 1, down: 2 };
  return rank[a.status] - rank[b.status] || a.ms - b.ms;
}

/** Run `task` over `items`, at most `limit` in flight at once. Keeps input order. */
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

const firstLine = (text) => String(text).split('\n')[0];
const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}...`);

await main();
