// One tool, full round trip: ask -> model requests a tool call -> we run it ->
// send the result back -> model answers.
// Usage: node examples/tools.mjs

import { ambientChat } from '../client.mjs';

const QUESTION = 'What is (137 + 43) * 6 / 9? Use the calculator tool, then state the answer.';

const tools = [{
  type: 'function',
  function: {
    name: 'calculate',
    description: 'Evaluate a basic arithmetic expression and return the numeric result.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'An arithmetic expression, for example "(2 + 3) * 7 / 2".',
        },
      },
      required: ['expression'],
    },
  },
}];

const messages = [{ role: 'user', content: QUESTION }];

// Round 1: give the model the tool and see if it asks for it.
const first = await ambientChat({ messages, tools, maxTokens: 2000 });

if (first.toolCalls.length === 0) {
  // Not every model on the network supports tool calling. Some just answer.
  console.log('Model answered without calling the tool:\n');
  console.log(first.content);
  process.exit(0);
}

// The assistant turn must go back into the history exactly as it came out,
// tool_calls included, or the follow-up request is rejected as malformed.
messages.push({
  role: 'assistant',
  content: first.content || null,
  tool_calls: first.toolCalls,
});

for (const call of first.toolCalls) {
  const args = safeParseArgs(call.function.arguments);
  const output = runTool(call.function.name, args);

  console.log(`tool call: ${call.function.name}(${call.function.arguments})`);
  console.log(`tool result: ${output}\n`);

  // Every tool_call id must get exactly one matching tool message back.
  messages.push({ role: 'tool', tool_call_id: call.id, content: output });
}

// Round 2: the model now sees the tool output and writes the final answer.
const second = await ambientChat({ messages, tools, maxTokens: 2000 });
console.log('final answer:\n');
console.log(second.content);

function runTool(name, args) {
  // Tool results are JSON strings by convention. Errors go back as data, not as
  // exceptions, so the model can read the failure and correct itself.
  try {
    if (name !== 'calculate') throw new Error(`unknown tool: ${name}`);
    return JSON.stringify({ result: evaluateExpression(String(args.expression ?? '')) });
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
}

function safeParseArgs(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {}; // models occasionally emit malformed argument JSON
  }
}

// --- Safe arithmetic parser -------------------------------------------------
// No eval, no Function constructor. A tool argument is untrusted model output,
// which may in turn be shaped by untrusted user text, so it never becomes code.
// Grammar (lowest precedence first):
//   expression = term (('+' | '-') term)*
//   term       = unary (('*' | '/' | '%') unary)*
//   unary      = ('+' | '-') unary | power
//   power      = primary ('^' unary)?        right associative
//   primary    = number | '(' expression ')'

function evaluateExpression(input) {
  const tokens = tokenize(input);
  let position = 0;

  const peek = () => tokens[position];
  const eat = (value) => (peek() === value ? (position++, true) : false);

  function parseExpression() {
    let left = parseTerm();
    for (;;) {
      if (eat('+')) left += parseTerm();
      else if (eat('-')) left -= parseTerm();
      else return left;
    }
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      if (eat('*')) left *= parseUnary();
      else if (eat('/')) left = divide(left, parseUnary());
      else if (eat('%')) left = modulo(left, parseUnary());
      else return left;
    }
  }

  function parseUnary() {
    if (eat('-')) return -parseUnary();
    if (eat('+')) return parseUnary();
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    return eat('^') ? base ** parseUnary() : base;
  }

  function parsePrimary() {
    const token = peek();
    if (token === undefined) throw new Error('unexpected end of expression');

    if (token === '(') {
      position++;
      const value = parseExpression();
      if (!eat(')')) throw new Error('missing closing parenthesis');
      return value;
    }

    const number = Number(token);
    if (Number.isNaN(number)) throw new Error(`unexpected token: ${token}`);
    position++;
    return number;
  }

  const result = parseExpression();
  if (position !== tokens.length) throw new Error(`unexpected token: ${tokens[position]}`);
  if (!Number.isFinite(result)) throw new Error('result is not a finite number');
  return result;
}

function tokenize(input) {
  // Numbers (including decimals and exponents) or single-character operators.
  const pattern = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[+\-*/%^()]|\s+/y;
  const tokens = [];
  let index = 0;

  while (index < input.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(input);
    // A sticky regex that fails to match means a character outside the grammar,
    // which is exactly what should be rejected rather than guessed at.
    if (!match) throw new Error(`invalid character at position ${index}: ${input[index]}`);
    if (match[0].trim()) tokens.push(match[0]);
    index = pattern.lastIndex;
  }

  if (tokens.length === 0) throw new Error('empty expression');
  return tokens;
}

// Function declarations, not const arrows: the top-level code above runs before
// this point in the file, and only declarations are hoisted.
function divide(a, b) {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}

function modulo(a, b) {
  if (b === 0) throw new Error('modulo by zero');
  return a % b;
}
