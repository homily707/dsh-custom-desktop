/**
 * Host-owned permanent session deletion for the desktop plugin.
 *
 * Storage layout checks and deletion ordering adapted from
 * MichengAI/dsh-archive-manager (Apache-2.0), src/workspace.ts.
 * No archive UI, workspace-service override, or additional npm dependency.
 */
import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DELETE_SESSION_ROUTE = "/api/custom-desktop/delete-session";
const TRANSCRIPT_NAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/;

function segment(text) {
  return text.replace(/[^A-Za-z0-9._-]/g,
    (ch) => "~" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
}

/** Only remove an entire session directory when its ownership is proven. */
export function ownedTranscriptDirectory(persistence, header) {
  if (persistence?.name !== "session-persistence-jsonl" || typeof persistence.locate !== "function")
    throw new Error("不支持的会话存储格式，已拒绝删除");
  const location = persistence.locate(header);
  const root = persistence.root ?? persistence.config?.root;
  if (location?.kind !== "jsonl" || typeof location.path !== "string"
    || typeof root !== "string" || !isAbsolute(root)
    || !isAbsolute(location.path) || !TRANSCRIPT_NAME.test(basename(location.path)))
    throw new Error("无法验证会话日志路径，已拒绝删除");
  if (typeof header?.id !== "string" || !header.id)
    throw new Error("会话头部缺少 ID");
  const encodedId = header.id === "." ? "~002E" : header.id === ".." ? "~002E~002E" : segment(header.id);
  let project = "_no-cwd";
  if (header.cwd !== undefined) {
    if (typeof header.cwd !== "string" || !header.cwd)
      throw new Error("会话工作目录无效");
    const readable = segment(header.cwd.replace(/[\\/:]+/g, "-")).replace(/^-+/, "") || "root";
    project = "--" + readable.slice(0, 251) + "--";
  }
  const base = resolve(root);
  const dir = join(base, project, encodedId);
  if (location.path !== join(dir, basename(location.path)))
    throw new Error("会话日志路径与存储根目录不符，已拒绝删除");
  const rel = relative(base, dir);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("禁止删除会话存储根目录或其外部路径");
  return dir;
}

/** Never recurse through a symlink under the storage root. */
async function checkDirectoryChain(dir) {
  for (const path of [dirname(dir), dir]) {
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("会话目录不是安全的普通目录：" + path);
  }
}

class TranscriptStillPresentError extends Error {
  constructor(id) { super("存储后端仍能找到被删除的会话：" + id); }
}

async function deleteTranscript(persistence, header) {
  const dir = ownedTranscriptDirectory(persistence, header);
  await checkDirectoryChain(dir);
  let existed = true;
  try { await lstat(dir); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existed = false;
  }
  await rm(dir, { recursive: true, force: true });
  if (typeof persistence.stat !== "function") return;
  try {
    const stillThere = await persistence.stat(header.id);
    if (stillThere !== undefined) {
      // Must not treat a positive post-delete stat as a recoverable read error.
      throw new TranscriptStillPresentError(header.id);
    }
  } catch (error) {
    if (error instanceof TranscriptStillPresentError) throw error;
    // A damaged transcript can make stat() throw. Only accept a verified
    // removal of a directory that actually existed before this attempt.
    if (!existed) throw error;
    try { await lstat(dir); }
    catch (postError) {
      if (postError?.code === "ENOENT") return;
      throw postError;
    }
    throw error;
  }
}

const actualError = (error) => error instanceof Error ? error.message : String(error);
export class ActiveSessionDeleteError extends Error {
  constructor(id) { super("会话 " + id + " 正在运行或等待交互，请先停止任务"); this.name = "ActiveSessionDeleteError"; }
}

/** A serialised, retryable delete operation sharing the registry mutation queue. */
export function createSessionDeletion(ctx) {
  const registry = ctx.get("workspaceRegistry");
  const persistence = ctx.get("sessionPersistence");
  if (!registry || !persistence) throw new Error("缺少 Workspace 或会话持久化服务");

  async function assertIdle(id) {
    // Reuse the same official activity providers as Workspace archive.
    if (typeof ctx.waterfall !== "function")
      throw new Error("宿主无法检查会话运行状态，已拒绝删除");
    const activity = await ctx.waterfall("workspace/session-activity",
      { sessionId: id }, () => Promise.resolve([]));
    if (!Array.isArray(activity) || activity.length > 0)
      throw new ActiveSessionDeleteError(id);
  }

  async function preflight(id, storedHeaders, visited, order) {
    if (visited.has(id)) return;
    visited.add(id);
    if (!(await registry.sessionKnown(id))) throw new Error("会话不存在：" + id);
    await assertIdle(id);
    const sessions = ctx.get("sessions");
    const header = sessions?.get(id)?.header
      ?? registry.headers?.get(id)
      ?? storedHeaders.find((item) => item.id === id);
    if (!header) throw new Error("无法读取会话头部：" + id);
    // Validate all paths and activity before deleting *any* child or parent.
    ownedTranscriptDirectory(persistence, header);
    const descendants = new Map();
    for (const item of storedHeaders) {
      if (item.parentSession === id && item.origin === "subagent") descendants.set(item.id, item);
    }
    for (const live of sessions?.list?.() ?? []) {
      if (live.header?.parentSession === id && live.header?.origin === "subagent")
        descendants.set(live.id, live.header);
    }
    for (const childId of descendants.keys())
      await preflight(childId, storedHeaders, visited, order);
    order.push({ id, header }); // children first, never cascade to user forks
  }

  async function deleteOne({ id, header }) {
    await assertIdle(id); // activity may have changed during preflight
    const sessions = ctx.get("sessions");
    const live = sessions?.get(id);
    if (live !== undefined) {
      if (typeof sessions.flush !== "function"
        || typeof sessions.liveEntryFor !== "function"
        || typeof sessions.detachEntered !== "function")
        throw new Error("无法安全分离已加载的会话");
      await sessions.flush(live);
      sessions.detachEntered(sessions.liveEntryFor(live));
    }
    // Remove the physical transcript before removing the durable accounting.
    // If removal fails, the indexed session remains available for a retry.
    await deleteTranscript(persistence, header);
    const projection = ctx.get("sessionProjectionCache");
    if (projection !== undefined) await projection.requireTable().delete(id);
    const spill = ctx.get("spillStore");
    if (spill?.root && isAbsolute(spill.root)) {
      try {
        const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
        await rm(join(spill.root, "session-" + hash), { recursive: true, force: true });
      } catch (error) { ctx.logger?.warn?.("custom-desktop: spill cleanup failed: " + actualError(error)); }
    }
    const state = registry.requireState();
    const archived = state.archivedSessionIds?.filter((item) => item !== id);
    const pinned = state.pinnedSessionIds?.filter((item) => item !== id);
    if ((archived && archived.length !== state.archivedSessionIds.length)
      || (pinned && pinned.length !== state.pinnedSessionIds.length))
      await registry.setState({
        ...state,
        ...(archived ? { archivedSessionIds: archived } : {}),
        ...(pinned ? { pinnedSessionIds: pinned } : {})
      });
    const table = registry.requireTable();
    for (const workspaceId of registry.requireState().workspaceIds) {
      const record = table.get(workspaceId);
      if (!record?.sessionIds?.includes(id)) continue;
      const next = await table.update(workspaceId, (current) => ({
        ...current,
        sessionIds: current.sessionIds.filter((item) => item !== id),
        updatedAt: new Date().toISOString()
      }));
      const entity = registry.entities?.get(workspaceId);
      if (entity) entity.record = next;
    }
    registry.headers?.delete(id);
    registry.sessionPaths?.delete(id);
    registry.invalidSessionPaths?.delete(id);
    registry.missingSessionPaths?.delete?.(id);
    try { ctx.emit("api-session/removed", id); }
    catch (error) { ctx.logger?.warn?.("custom-desktop: removal event failed: " + actualError(error)); }
  }

  return async function deleteSession(id) {
    if (typeof id !== "string" || !id || id.length > 256 || /[/\\\0]/.test(id))
      throw new TypeError("无效的会话 ID");
    if (typeof registry.enqueueOperation !== "function")
      throw new Error("宿主不支持串行 Workspace 更新");
    return registry.enqueueOperation(async () => {
      const stored = await registry.listStoredHeaders();
      const order = [];
      await preflight(id, stored, new Set(), order);
      for (const item of order) await deleteOne(item);
      return { deleted: true, sessionId: id, descendantCount: order.length - 1 };
    });
  };
}

function send(response, code, value) {
  response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function matchesRequestOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && typeof request.headers.host === "string"
      && url.host === request.headers.host;
  } catch {
    return false;
  }
}

export function registerSessionDeleteRoute(ctx) {
  const deleteSession = createSessionDeletion(ctx);
  return ctx.webServer.register({
    kind: "exact",
    path: DELETE_SESSION_ROUTE,
    auth: "required",
    async handler(request, response, peer) {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        send(response, 405, { ok: false, error: "仅支持 POST" });
        return;
      }
      // Required authentication is provided by the Host. Reject cross-origin
      // forms as well, and require a non-simple same-origin header.
      if ((peer?.principal && peer.principal.kind !== "owner")
        || request.headers["sec-fetch-site"] === "cross-site"
        || !matchesRequestOrigin(request)
        || request.headers["x-custom-desktop-delete"] !== "1") {
        send(response, 403, { ok: false, error: "拒绝未授权的删除请求" });
        return;
      }
      try {
        if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
          send(response, 415, { ok: false, error: "仅接受 JSON" }); return;
        }
        let raw = "";
        for await (const chunk of request) {
          raw += chunk.toString("utf8");
          if (raw.length > 4096) { send(response, 413, { ok: false, error: "请求过大" }); return; }
        }
        const input = JSON.parse(raw);
        const result = await deleteSession(input?.sessionId);
        send(response, 200, { ok: true, ...result });
      } catch (error) {
        const code = error instanceof ActiveSessionDeleteError ? 409
          : error instanceof SyntaxError || error instanceof TypeError ? 400 : 500;
        send(response, code, { ok: false, error: actualError(error) });
      }
    }
  });
}
