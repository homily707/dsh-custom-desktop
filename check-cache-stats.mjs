/** Real temporary-file checks for per-warm-attempt persisted usage (no DSH runtime). */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.mjs';
import { cacheHitRate } from './cache-stats.mjs';

assert.equal(cacheHitRate({ inputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 20, outputTokens: 500 }), 0.6);
assert.equal(cacheHitRate({ inputTokens: 20, cacheReadTokens: 0 }), 0);
assert.equal(cacheHitRate({ inputTokens: 20 }), null, 'not reported must differ from 0%');
assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0 }), null);
assert.equal(cacheHitRate(null), null);
assert.equal(cacheHitRate({ inputTokens: 20, cacheReadTokens: -1 }), null);

const home = await mkdtemp(join(tmpdir(), 'dsh-custom-cache-stats-'));
const previousHome = process.env.DSH_HOME;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pending = new Map();
let nextTimer = 0;
globalThis.setTimeout = (cb, duration) => {
  const id = ++nextTimer;
  pending.set(id, { cb, duration });
  return id;
};
globalThis.clearTimeout = (id) => pending.delete(id);
process.env.DSH_HOME = home;

try {
  const logger = { warn: () => {} };
  const handlers = new Map();
  let command;
  let dispose;
  let calls = 0;
  const ctx = {
    logger: () => logger,
    commands: { register: (definition) => { command = definition; } },
    on: (name, fn) => { handlers.set(name, fn); },
    effect: (fn) => { dispose = fn(); },
    llm: { stream: (request) => (async function* () {
      calls++;
      if (request.sessionId === 'session-b') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_CACHE' } } };
      } else if (request.sessionId === 'session-c') {
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
        yield { type: 'finish', reason: { kind: 'aborted' } };
      } else {
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 16, cacheReadTokens: 60, cacheWriteTokens: 20 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })() },
  };
  apply(ctx);
  const invoke = (sessionId, rawInput) => command.handler({ agent: { session: { id: sessionId } }, rawInput });
  const simulateRealRequest = async (sessionId) => {
    const request = { provider: 'example', model: 'example-model', sessionId,
      messages: [{ role: 'system', content: [] }, { role: 'user', content: [{ type: 'text', text: 'private message' }] }] };
    const iterable = handlers.get('llm/stream')(request, () => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } };
    })());
    for await (const _chunk of iterable) { /* consume the foreground stream */ }
  };
  const fireNextWarm = async () => {
    const entry = [...pending.entries()].find(([, value]) => value.duration === 240_000);
    assert.ok(entry, 'expected a 4min keepalive timer');
    const [id, timer] = entry;
    pending.delete(id);
    timer.cb();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const file = join(home, 'state', 'custom-desktop', 'cache-keepalive.jsonl');
  const readRows = async () => {
    try {
      const data = await readFile(file, 'utf8');
      return data.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const waitRows = async (count) => {
    for (let i = 0; i < 100; i++) {
      const rows = await readRows();
      if (rows.length >= count) return rows;
      await new Promise((resolve) => realSetTimeout(resolve, 10));
    }
    assert.fail(`expected ${count} saved rows`);
  };

  assert.match(invoke('session-a', 'on').text, /Waiting/);
  await simulateRealRequest('session-a');
  await fireNextWarm();
  const first = (await waitRows(1))[0];
  assert.equal(first.version, 1);
  assert.equal(first.sessionId, 'session-a');
  assert.equal(first.provider, 'example');
  assert.equal(first.model, 'example-model');
  assert.equal(first.status, 'completed');
  assert.equal(first.cacheHitRate, 0.6);
  assert.deepEqual(first.usage, { inputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 20, outputTokens: 16 });
  assert.ok(first.startedAt && first.endedAt);
  assert.equal(first.failureCode, null);
  assert.equal(JSON.stringify(first).includes('private message'), false, 'no prompt content in the stats');
  invoke('session-a', 'off');

  invoke('session-b', 'on');
  await simulateRealRequest('session-b');
  await fireNextWarm();
  const second = (await waitRows(2))[1];
  assert.equal(second.status, 'failed');
  assert.equal(second.failureCode, 'NO_CACHE');
  assert.equal(second.cacheHitRate, null, 'missing usage must not be treated as 0%');
  assert.equal(second.usage, null);
  invoke('session-b', 'off');

  invoke('session-c', 'on');
  await simulateRealRequest('session-c');
  await fireNextWarm();
  invoke('session-c', 'off');
  const third = (await waitRows(3))[2];
  assert.equal(third.status, 'aborted');
  assert.equal(third.cacheHitRate, null);

  assert.equal(calls, 3, 'one request per warm attempt');
  assert.equal(pending.size, 0);
  dispose();
  assert.equal((await readRows()).length, 3, 'disabling and disposing must not erase saved stats');
  console.log('cache stats checks passed');
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  await rm(home, { recursive: true, force: true });
}
