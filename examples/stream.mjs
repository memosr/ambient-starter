// Streaming, with a time to first content token measurement.
// Usage: node examples/stream.mjs
//
// Content goes to stdout, reasoning goes to stderr, so this still works:
//   node examples/stream.mjs > answer.txt

import { ambientChat } from '../client.mjs';

const startedAt = Date.now();
let firstReasoningAt = null;
let firstContentAt = null;

const result = await ambientChat({
  messages: [{ role: 'user', content: 'Count from 1 to 20, then name one prime in that range.' }],
  stream: true,
  maxTokens: 2000, // reasoning models need headroom before content starts
  onDelta: ({ type, text }) => {
    if (type === 'reasoning') {
      firstReasoningAt ??= Date.now();
      process.stderr.write(text);
      return;
    }
    // Time to first CONTENT token is the number that matters. On a reasoning
    // model the first reasoning token can arrive seconds earlier, which makes
    // naive "time to first token" numbers look much better than they feel.
    firstContentAt ??= Date.now();
    process.stdout.write(text);
  },
});

const since = (at) => (at === null ? 'never' : `${at - startedAt}ms`);

console.log('\n---');
console.log(`model:                   ${result.model}`);
console.log(`time to first reasoning: ${since(firstReasoningAt)}`);
console.log(`time to first content:   ${since(firstContentAt)}`);
console.log(`total:                   ${Date.now() - startedAt}ms`);
console.log(`reasoning chars:         ${result.reasoning.length}`);
console.log(`content chars:           ${result.content.length}`);
console.log(`finish_reason:           ${result.finishReason}`);
