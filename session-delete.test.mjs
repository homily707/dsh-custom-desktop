import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createSessionDeletion, ownedTranscriptDirectory, registerSessionDeleteRoute } from "./session-delete.host.mjs";

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "dsh-custom-delete-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "sessions");
  await mkdir(root, { recursive: true });
  const headers = new Map();
  const records = new Map([["workspace-1", { sessionIds: [], updatedAt: "old" }]]);
  const entities = new Map([["workspace-1", { record: records.get("workspace-1") }]]);
  const invalidSessionPaths = new Set();
  const events = [];
  const cacheRemoved = [];
  const active = new Set();
  let state = {
    workspaceIds: ["workspace-1"],
    archivedSessionIds: [],
    pinnedSessionIds: []
  };
  const transcript = (id) => join(root, "_no-cwd", id, "session.jsonl");
  const put = async (id, extra = {}) => {
    const header = { id, ...extra };
    headers.set(id, header);
    await mkdir(join(root, "_no-cwd", id), { recursive: true });
    await writeFile(transcript(id), '{"type":"session"}\n');
    records.get("workspace-1").sessionIds.push(id);
    return header;
  };
  const persistence = {
    name: "session-persistence-jsonl",
    root,
    locate: (header) => ({ kind: "jsonl", path: transcript(header.id) }),
    stat: async (id) => await exists(transcript(id)) ? { header: headers.get(id) } : undefined
  };
  const registry = {
    headers,
    sessionPaths: new Map(),
    invalidSessionPaths,
    entities,
    requireState: () => state,
    setState: async (next) => { state = next; },
    requireTable: () => ({
      get: (id) => records.get(id),
      update: async (id, fn) => {
        const next = fn(records.get(id));
        records.set(id, next);
        return next;
      }
    }),
    sessionKnown: async (id) => headers.has(id) || (await persistence.stat(id)) !== undefined,
    listStoredHeaders: async () => [...headers.values()],
    enqueueOperation: async (run) => await run()
  };
  let route;
  const ctx = {
    logger: { warn() {} },
    get: (service) => ({
      workspaceRegistry: registry,
      sessionPersistence: persistence,
      sessions: { get: () => undefined, list: () => [] },
      sessionProjectionCache: { requireTable: () => ({ delete: async (id) => { cacheRemoved.push(id); } }) }
    })[service],
    waterfall: async (_event, { sessionId }, next) =>
      active.has(sessionId) ? [{ kind: "agent" }] : await next(),
    emit: (...args) => events.push(args),
    webServer: { register: (definition) => { route = definition; return () => {}; } }
  };
  return {
    base, root, put, transcript, headers, records, entities, events, cacheRemoved,
    active, registry, persistence, ctx, getState: () => state, getRoute: () => route
  };
}

test("deletes a session, cache, workspace accounting and pinned/archive state, not the project directory", async (t) => {
  const f = await fixture(t);
  await f.put("main");
  await f.registry.setState({ ...f.getState(), archivedSessionIds: ["main"], pinnedSessionIds: ["main"] });
  const result = await createSessionDeletion(f.ctx)("main");
  assert.deepEqual(result, { deleted: true, sessionId: "main", descendantCount: 0 });
  assert.equal(await exists(f.transcript("main")), false);
  assert.equal(await exists(join(f.root, "_no-cwd")), true);
  assert.deepEqual(f.records.get("workspace-1").sessionIds, []);
  assert.deepEqual(f.getState().archivedSessionIds, []);
  assert.deepEqual(f.getState().pinnedSessionIds, []);
  assert.deepEqual(f.cacheRemoved, ["main"]);
  assert.deepEqual(f.events, [["api-session/removed", "main"]]);
});

test("refuses an active session without altering persistent data", async (t) => {
  const f = await fixture(t);
  await f.put("busy");
  f.active.add("busy");
  await assert.rejects(createSessionDeletion(f.ctx)("busy"), /正在运行或等待交互/);
  assert.equal(await exists(f.transcript("busy")), true);
  assert.deepEqual(f.records.get("workspace-1").sessionIds, ["busy"]);
  assert.deepEqual(f.cacheRemoved, []);
});

test("cascades only to subagents, preserving independent fork sessions", async (t) => {
  const f = await fixture(t);
  await f.put("parent");
  await f.put("subagent", { parentSession: "parent", origin: "subagent" });
  await f.put("fork", { parentSession: "parent", origin: "fork" });
  const result = await createSessionDeletion(f.ctx)("parent");
  assert.equal(result.descendantCount, 1);
  assert.equal(await exists(f.transcript("parent")), false);
  assert.equal(await exists(f.transcript("subagent")), false);
  assert.equal(await exists(f.transcript("fork")), true);
  assert.deepEqual(f.records.get("workspace-1").sessionIds, ["fork"]);
});

test("blocks the parent before any deletion when a child subagent is active", async (t) => {
  const f = await fixture(t);
  await f.put("parent");
  await f.put("subagent", { parentSession: "parent", origin: "subagent" });
  f.active.add("subagent");
  await assert.rejects(createSessionDeletion(f.ctx)("parent"), /正在运行或等待交互/);
  assert.equal(await exists(f.transcript("parent")), true);
  assert.equal(await exists(f.transcript("subagent")), true);
});

test("rejects a symbolic-link project directory and does not remove external files", async (t) => {
  const f = await fixture(t);
  const external = join(f.base, "external");
  await mkdir(join(external, "unsafe"), { recursive: true });
  const file = join(external, "unsafe", "session.jsonl");
  await writeFile(file, "keep");
  await symlink(external, join(f.root, "_no-cwd"), "dir");
  f.headers.set("unsafe", { id: "unsafe" });
  assert.equal(ownedTranscriptDirectory(f.persistence, { id: "unsafe" }), join(f.root, "_no-cwd", "unsafe"));
  await assert.rejects(createSessionDeletion(f.ctx)("unsafe"), /不是安全的普通目录/);
  assert.equal(await readFile(file, "utf8"), "keep");
});

test("does not report success when persistence still claims a deleted transcript exists", async (t) => {
  const f = await fixture(t);
  await f.put("stale");
  f.persistence.stat = async () => ({ header: { id: "stale" } });
  await assert.rejects(createSessionDeletion(f.ctx)("stale"), /仍能找到被删除的会话/);
  assert.equal(f.headers.has("stale"), true);
  assert.deepEqual(f.records.get("workspace-1").sessionIds, ["stale"]);
});

test("route enforces authenticated POST shape and forwards a delete to the Host", async (t) => {
  const f = await fixture(t);
  await f.put("main");
  registerSessionDeleteRoute(f.ctx);
  const route = f.getRoute();
  assert.equal(route.auth, "required");
  const invoke = async (method, headers, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
    req.method = method;
    req.headers = headers;
    const response = {
      status: 0, headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      setHeader() {},
      end(payload) { this.body = JSON.parse(payload); }
    };
    await route.handler(req, response, { principal: { kind: "owner" } });
    return response;
  };
  const headers = {
    host: "localhost:4567", origin: "http://localhost:4567",
    "content-type": "application/json",
    "x-custom-desktop-delete": "1",
    "sec-fetch-site": "same-origin"
  };
  const forbidden = await invoke("POST", { ...headers, "x-custom-desktop-delete": "" }, { sessionId: "main" });
  assert.equal(forbidden.status, 403);
  assert.equal(await exists(f.transcript("main")), true);
  const malformedOrigin = await invoke("POST", { ...headers, origin: "malformed origin" }, { sessionId: "main" });
  assert.equal(malformedOrigin.status, 403);
  assert.equal(await exists(f.transcript("main")), true);
  const deleted = await invoke("POST", headers, { sessionId: "main" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true, deleted: true, sessionId: "main", descendantCount: 0 });
});
