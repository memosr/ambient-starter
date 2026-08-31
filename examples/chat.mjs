// The simplest possible call.
// Usage: node examples/chat.mjs

import { ambientChat } from '../client.mjs';

const result = await ambientChat({
  messages: [{ role: 'user', content: 'In two sentences, what is a decentralized inference network?' }],
});

console.log(result.content);

// If content is empty, the model spent the whole max_tokens budget on reasoning.
// Raise maxTokens rather than assuming the model is broken.
if (!result.content) {
  console.error(`\n(empty content, finish_reason: ${result.finishReason}. Try a larger maxTokens.)`);
}
