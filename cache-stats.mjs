/** Durable per-attempt cache usage statistics. No conversation content is persisted. */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Return the cache-read share of billed prompt input, or null when unreported. */
export function cacheHitRate(usage) {
  const input = tokenCount(usage?.inputTokens);
  const read = tokenCount(usage?.cacheReadTokens);
  const write = usage?.cacheWriteTokens === undefined ? 0 : tokenCount(usage.cacheWriteTokens);
  if (input === null || read === null || write === null) return null;
  const total = input + read + write;
  return total > 0 ? read / total : null;
}

/** Keep each measurement independent and omit all prompts, tools and credentials. */
export function cacheAttemptRecord({ sessionId, provider, model, startedAt, endedAt, status, usage, failureCode }) {
  return {
    version: 1,
    sessionId,
    provider,
    model,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: Math.max(0, endedAt - startedAt),
    status,
    failureCode: failureCode ?? null,
    cacheHitRate: cacheHitRate(usage),
    usage: usage === null ? null : {
      inputTokens: tokenCount(usage.inputTokens),
      cacheReadTokens: tokenCount(usage.cacheReadTokens),
      cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
      outputTokens: tokenCount(usage.outputTokens),
    },
  };
}

function defaultStatsPath() {
  const env = process.env.DSH_HOME?.trim();
  const home = env ? (env === '~' ? homedir() : env.startsWith('~/') || env.startsWith('~\\')
    ? join(homedir(), env.slice(2)) : env) : join(homedir(), '.dsh');
  return join(resolve(home), 'state', 'custom-desktop', 'cache-keepalive.jsonl');
}

/** Append-only serialized JSONL writer; data survives turning cache off or restarting. */
export function createCacheStatsRecorder(file = defaultStatsPath()) {
  let pending = Promise.resolve();
  return {
    file,
    append(record) {
      const write = pending.then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      });
      pending = write.catch(() => {}); // A failed append must not block subsequent records.
      return write;
    },
    flush() { return pending; },
  };
}
