/** Checks event payloads and cache keepalive's Session persistence handoff. */
import assert from 'node:assert/strict';
import { CACHE_EVENT, cacheHitRate, keepaliveEvent } from './cache-events.mjs';
import { installCacheKeepalive } from './cache-keepalive.mjs';

assert.equal(CACHE_EVENT, 'plugin:custom-desktop/cache-keepalive');
assert.equal(cacheHitRate({ inputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 20 }), 0.6);
assert.equal(cacheHitRate({ inputTokens: 50, cacheReadTokens: 0 }), 0);
assert.equal(cacheHitRate({ inputTokens: 50 }), null);
assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0 }), null);
assert.equal(cacheHitRate({ inputTokens: -1, cacheReadTokens: 5 }), null);
assert.equal(cacheHitRate(null), null);

const data = keepaliveEvent({
  provider: 'example', model: 'test', startedAt: 10, endedAt: 20, status: 'completed',
  failureCode: null, usage: { inputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 20, outputTokens: 1 },
});
assert.equal(data.cacheHitRate, 0.6);
assert.equal(data.durationMs, 10);
assert.equal(data.version, 1);
assert.equal(JSON.stringify(data).includes('messages'), false);

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pending = new Map();
let nextTimer = 0;
globalThis.setTimeout = (cb, delay) => {
  const id = ++nextTimer;
  pending.set(id, { cb, delay });
  return id;
};
globalThis.clearTimeout = (id) => pending.delete(id);
try {
  const sessions = new Map(['a', 'b', 'c', 'd'].map(id => [id, { id, events: [] }]));
  const handlers = new Map();
  let command;
  let dispose;
  let flushCount = 0;
  const warnings = [];
  let warmCount = 0;
  const ctx = {
    logger: () => ({ warn: (...args) => warnings.push(args) }),
    commands: { register: (entry) => { command = entry; } },
    sessions: { get: (id) => sessions.get(id), flush: async () => { flushCount++; } },
    on: (event, handler) => handlers.set(event, handler),
    effect: (handler) => { dispose = handler(); },
    llm: { stream: (request) => (async function* () {
      warmCount++;
      if (request.sessionId === 'b') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FAIL' } } };
      } else if (request.sessionId === 'c') {
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
        yield { type: 'finish', reason: { kind: 'aborted' } };
      } else if (request.sessionId === 'd') {
        yield { type: 'usage', usage: { inputTokens: 20, cacheReadTokens: 0, outputTokens: 1 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } else {
        yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 70, cacheWriteTokens: 20, outputTokens: 1 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })() },
  };
  const recorded = [];
  installCacheKeepalive(ctx, { appendEvent: async (_ctx, session, event) => {
    recorded.push({ session: session.id, event });
    session.events.push({ type: CACHE_EVENT, ignorable: true, data: event });
    await ctx.sessions.flush(session);
  } });
  const run = (id, input) => command.handler({ agent: { session: { id } }, rawInput: input });
  const request = (id) => ({ provider: 'example', model: 'test-model', sessionId: id,
    messages: [{ role: 'system', content: [] }, { role: 'user', content: [{ type: 'text', text: 'secret prompt' }] }] });
  const userRequest = async (id) => {
    const stream = handlers.get('llm/stream')(request(id), () => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } };
    })());
    for await (const _chunk of stream) { /* drain */ }
  };
  const fire = async () => {
    const entry = [...pending.entries()].find(([, task]) => task.delay === 240_000);
    assert.ok(entry, 'keepalive should have a 4 minute timer');
    pending.delete(entry[0]);
    entry[1].cb();
    await new Promise(resolve => setImmediate(resolve));
  };
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.equal(run(id, 'on').kind, 'success');
    await userRequest(id);
    await fire();
    if (id === 'c') run(id, 'off');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sessions.get(id).events.length, 1, `saved exactly one event for ${id}`);
    if (id !== 'c') run(id, 'off');
  }
  assert.deepEqual(recorded.map(({ session }) => session), ['a', 'b', 'c', 'd']);
  assert.deepEqual(recorded.map(({ event }) => event.status), ['completed', 'failed', 'aborted', 'completed']);
  assert.deepEqual(recorded.map(({ event }) => event.cacheHitRate), [0.7, null, null, 0]);
  assert.equal(recorded[1].event.failureCode, 'FAIL');
  assert.equal(recorded[1].event.usage, null);
  assert.equal(warmCount, 4);
  assert.equal(flushCount, 4);
  assert.equal(recorded.every(({event}) => !JSON.stringify(event).includes('secret prompt')), true);
  assert.equal(pending.size, 0);
  dispose();
  console.log('cache event checks passed');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
