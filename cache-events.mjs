/** One informational, non-surface plugin record per cache keepalive attempt. */
export const CACHE_EVENT = 'plugin:custom-desktop/cache-keepalive';

const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Share of all input tokens served by the provider's cache; unknown != 0%. */
export function cacheHitRate(usage) {
  const input = nonnegative(usage?.inputTokens);
  const read = nonnegative(usage?.cacheReadTokens);
  const write = usage?.cacheWriteTokens === undefined ? 0 : nonnegative(usage.cacheWriteTokens);
  if (input === null || read === null || write === null) return null;
  const total = input + read + write;
  return total > 0 ? read / total : null;
}

/** Keep request metadata and provider usage, never messages, tools, or output. */
export function keepaliveEvent({ provider, model, startedAt, endedAt, status, failureCode, usage }) {
  return {
    version: 1,
    provider,
    model,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    status,
    failureCode: failureCode ?? null,
    cacheHitRate: cacheHitRate(usage),
    usage: usage === null ? null : {
      inputTokens: nonnegative(usage.inputTokens),
      cacheReadTokens: nonnegative(usage.cacheReadTokens),
      cacheWriteTokens: nonnegative(usage.cacheWriteTokens),
      outputTokens: nonnegative(usage.outputTokens),
    },
  };
}

/**
 * Write through the existing Session journal and request its durability barrier.
 * The record is ignorable across plugin uninstall / upgrades and never enters
 * the model-visible message surface. The package is a DSH Host peer dependency.
 */
export async function appendKeepaliveEvent(ctx, session, data) {
  const { appendPluginRecord } = await import('@deepseek-ai/dsh-session');
  if (ctx.sessions.get(session.id) !== session) return false;
  appendPluginRecord(session, CACHE_EVENT, data);
  await ctx.sessions.flush(session);
  return true;
}
