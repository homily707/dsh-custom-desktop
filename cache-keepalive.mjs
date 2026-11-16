/** Minimal, session-scoped prompt-prefix cache keepalive for DSH Host. */
const INTERVAL_MS = 4 * 60_000;
const REQUEST_TIMEOUT_MS = 90_000;

/** Keep the original request header and only the messages through its first user turn. */
export function firstUserPrefix(options) {
  const index = options.messages?.findIndex((message) => message.role === 'user') ?? -1;
  if (index < 0) return null;
  // Never retain the foreground cancellation signal or later tool-history projection.
  const { signal: _signal, toolHistory: _toolHistory, ...header } = options;
  return { ...header, messages: options.messages.slice(0, index + 1), maxTokens: 1 };
}

/** Install host-only scheduling and a native /cache [on|off] command. */
export function installCacheKeepalive(ctx) {
  const sessions = new Map();
  const ownRequests = new WeakSet();
  const logger = ctx.logger('custom-desktop:cache');
  let disposed = false;

  function stateFor(id) {
    let state = sessions.get(id);
    if (!state) {
      state = { enabled: false, prefix: null, timer: null, warm: null, foreground: 0 };
      sessions.set(id, state);
    }
    return state;
  }

  function stop(state) {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    state.warm?.abort();
  }

  function schedule(state) {
    if (disposed || !state.enabled || !state.prefix || state.timer !== null
      || state.warm !== null || state.foreground > 0) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void warm(state);
    }, INTERVAL_MS);
  }

  async function warm(state) {
    if (disposed || !state.enabled || !state.prefix || state.warm || state.foreground > 0) return;
    const controller = new AbortController();
    state.warm = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const request = { ...state.prefix, signal: controller.signal };
      ownRequests.add(request);
      for await (const chunk of ctx.llm.stream(request)) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          logger.warn('cache warm failed: %s', chunk.reason.failure?.code ?? 'provider error');
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn('cache warm failed: %s', error instanceof Error ? error.message : String(error));
      }
    } finally {
      clearTimeout(timeout);
      if (state.warm === controller) state.warm = null;
      schedule(state);
    }
  }

  ctx.on('llm/stream', (options, next) => {
    if (disposed || ownRequests.has(options) || options.sessionId === undefined
      || options.purpose !== undefined) return next();
    const state = sessions.get(String(options.sessionId));
    if (!state?.enabled) return next();
    const prefix = firstUserPrefix(options);
    if (!prefix) return next();
    state.foreground += 1;
    stop(state); // Foreground requests always take priority.
    let stream;
    try {
      stream = next();
    } catch (error) {
      state.foreground -= 1;
      schedule(state);
      throw error;
    }
    return (async function* () {
      let succeeded = false;
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'finish') {
            succeeded = chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted';
          }
          yield chunk;
        }
      } finally {
        state.foreground -= 1;
        if (state.enabled && succeeded && options.signal?.aborted !== true) state.prefix = prefix;
        schedule(state);
      }
    })();
  });

  ctx.commands.register({
    name: 'cache',
    description: 'Control prompt-prefix cache keepalive for this session',
    input: { hint: '[on|off]' },
    handler: ({ agent, rawInput }) => {
      const id = String(agent.session.id);
      const action = rawInput.trim();
      if (action !== '' && action !== 'on' && action !== 'off') {
        return { kind: 'error', text: 'Usage: /cache [on|off]' };
      }
      const state = stateFor(id);
      if (action === 'on') {
        state.enabled = true;
        schedule(state);
        return { kind: 'success', text: state.prefix
          ? 'Cache keepalive enabled (every 4 minutes).'
          : 'Cache keepalive enabled. Waiting for the next successful agent request.' };
      }
      if (action === 'off') {
        state.enabled = false;
        stop(state);
        state.prefix = null;
        return { kind: 'success', text: 'Cache keepalive disabled for this session.' };
      }
      return { kind: 'success', text: state.enabled
        ? (state.prefix ? 'Cache keepalive: on (every 4 minutes).' : 'Cache keepalive: on (waiting for an agent request).')
        : 'Cache keepalive: off.' };
    },
  });

  const drop = (id) => {
    const state = sessions.get(id);
    if (!state) return;
    state.enabled = false;
    stop(state);
    sessions.delete(id);
  };
  ctx.on('session/disposed', (session) => drop(String(session.id)));
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.session?.id !== undefined) drop(String(agent.session.id));
  });
  ctx.effect(() => () => {
    disposed = true;
    for (const id of sessions.keys()) drop(id);
  });
}
