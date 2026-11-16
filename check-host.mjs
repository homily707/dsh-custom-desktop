/** Dependency-free behavior checks for the desktop Host cache keepalive. */
import assert from 'node:assert/strict';
import { apply, inject } from './index.mjs';
import { firstUserPrefix } from './cache-keepalive.mjs';

assert.deepEqual(inject, ['llm', 'commands']);
const source = {
  provider: 'example', model: 'example-model', sessionId: 'session-a',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'system' }] },
    { role: 'developer', content: [{ type: 'text', text: 'instructions' }] },
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
  ],
  tools: [{ name: 'noop' }],
  toolHistory: { changed: true },
  signal: new AbortController().signal,
  maxTokens: 1024,
};
const prefix = firstUserPrefix(source);
assert.equal(prefix.messages.length, 3);
assert.equal(prefix.messages.at(-1).content[0].text, 'first question');
assert.equal(prefix.maxTokens, 1);
assert.equal(prefix.tools, source.tools);
assert.equal(prefix.signal, undefined);
assert.equal(prefix.toolHistory, undefined);
assert.equal(firstUserPrefix({ messages: [{ role: 'system' }] }), null);

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pending = new Map();
let timerId = 0;
globalThis.setTimeout = (cb, duration) => {
  const id = ++timerId;
  pending.set(id, { cb, duration });
  return id;
};
globalThis.clearTimeout = (id) => pending.delete(id);

try {
  const events = new Map();
  let cacheCommand;
  let dispose;
  const sent = [];
  const ctx = {
    logger: () => ({ warn: () => {} }),
    llm: { stream: (request) => (async function* () {
      sent.push(request);
      yield { type: 'finish', reason: { kind: 'stop' } };
    })() },
    on: (event, callback) => events.set(event, callback),
    effect: (callback) => { dispose = callback(); },
    commands: { register: (command) => { cacheCommand = command; } },
  };
  apply(ctx);
  assert.equal(cacheCommand.name, 'cache');
  const command = (sessionId, rawInput) => cacheCommand.handler({ agent: { session: { id: sessionId } }, rawInput });
  const stream = (request) => events.get('llm/stream')(request, () => (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  const drain = async (iterable) => { for await (const _chunk of iterable) { /* drain */ } };
  const due = (duration) => [...pending.entries()].find(([, t]) => t.duration === duration);

  assert.match(command('session-a', '').text, /off/);
  assert.equal(command('session-a', ' invalid').kind, 'error');
  assert.match(command('session-a', ' on').text, /Waiting/);
  assert.match(command('session-b', '').text, /off/);
  await drain(stream({ ...source, purpose: 'title' }));
  assert.equal(pending.size, 0, 'auxiliary requests must not arm keepalive');
  await drain(stream(source));
  assert.ok(due(240_000), 'a successful foreground request arms a four-minute timer');
  assert.match(command('session-a', '').text, /on/);

  const [id, alarm] = due(240_000);
  pending.delete(id);
  alarm.cb();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].maxTokens, 1);
  assert.equal(sent[0].messages.length, 3);
  assert.notEqual(sent[0].signal, source.signal);
  assert.equal(sent[0].provider, 'example');
  assert.ok(due(240_000), 'warm completion schedules the next refresh');

  command('session-b', 'on');
  await drain(stream({ ...source, sessionId: 'session-b' }));
  assert.equal([...pending.values()].filter((v) => v.duration === 240_000).length, 2);
  command('session-a', 'off');
  assert.equal([...pending.values()].filter((v) => v.duration === 240_000).length, 1,
    'turning off one session must not affect another');
  events.get('session/disposed')({ id: 'session-b' });
  assert.equal(pending.size, 0, 'disposing a session clears its timer');
  dispose();
  console.log('host keepalive checks passed');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
