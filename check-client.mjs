/**
 * Local checks for dsh-custom-desktop — `node check-client.mjs` (or `npm test`).
 *
 * 1. Manifest / Loader row: platform, bundle patch, client inject faces, insert row.
 * 2. Vendor provenance: the component is the build the desktop app ships (0.2.0-rc.2,
 *    `cl2Rlq_` CSS prefix) and carries its own style tag id.
 * 3. Hover contract (static): 150ms dwell, 300ms grace, both captions wired, the
 *    portal menu wired, press pinning, and no focus steal on the hover path.
 * 4. Runtime contract: execute the bundle factory against stub modules, then call
 *    apply() and assert the slot registration it performs.
 *
 * NOT covered: actual rendering and pointer behaviour — that needs the desktop app.
 * Manual steps are in README "验证".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, "client.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
const deleteSource = readFileSync(join(root, "session-delete.client.js"), "utf8");
const vendor = readFileSync(join(root, "vendor.mjs"), "utf8");

let failed = 0;
const check = (label, ok, detail = "") => {
	if (ok) {
		console.log(`ok   ${label}`);
		return;
	}
	failed += 1;
	console.log(`FAIL ${label}${detail === "" ? "" : ` — ${detail}`}`);
};

//#region 1. manifest
const client = pkg.dsh?.client ?? {};
check("host entry is index.mjs", pkg.main === "./index.mjs");
check("bundle patch declared", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("client platform is web", client.platform === "web", JSON.stringify(client.platform));
const injectFaces = client.inject ?? [];
check("injects the official model-seat row", injectFaces.includes("@deepseek-ai/dsh-client-ui-model-selection"));
check("injects the session controller", injectFaces.includes("@deepseek-ai/dsh-api-session-controller"));
check("injects the official context menu", injectFaces.includes("@deepseek-ai/dsh-client-ui-context-menu"));
check("ships the host delete implementation", pkg.files.includes("session-delete.host.mjs"));
check("loader row inserted", /id: custom-desktop\b/.test(patch) && /name: dsh-custom-desktop\b/.test(patch));
//#endregion

//#region 2. vendor provenance
check("vendored from the desktop build (cl2Rlq_ styles)", source.includes(".cl2Rlq_trigger{"));
check("own style tag id (no collision with the official tag)", source.includes('const tagId = "dsh-custom-desktop/model-select.css";'));
check("loader id is the package name", source.includes('id: "dsh-custom-desktop"'));
check("delete client is embedded in the bundle", source.includes(deleteSource.trim()));
check("delete contribution is installed on apply", source.includes("installSessionDelete(ctx);"));
check("re-vendor keeps the delete contribution", vendor.includes('"session-delete.client.js"') && vendor.includes("installSessionDelete(ctx);"));
//#endregion

//#region 3. hover contract
check("150ms dwell", source.includes("const HOVER_OPEN_DELAY = 150;"));
check("300ms grace", source.includes("const HOVER_CLOSE_DELAY = 300;"));
check("model caption opens the model pane", /triggerLabel,\s*\n\s*onMouseEnter: \(\) => hoverOpen\("model"\),/.test(source));
check("effort caption opens the effort pane (root when no levels)", /triggerEffort,[\s\S]{0,400}?hoverOpen\(reasoning === void 0 \? "root" : "effort"\)/.test(source));
check("root subtree carries enter/leave", /\n\s*onMouseEnter: clearHover,\s*\n\s*onMouseLeave: hoverLeave,/.test(source));
check("portal menu carries its own enter/leave/pin", /className: ModelSelect_module_css_default\.menu,\s*\n\s*onMouseEnter: clearHover,\s*\n\s*onMouseLeave: hoverLeave,\s*\n\s*onMouseDown: pinHover,/.test(source));
check("press pins the menu", source.includes("pinHover();") && source.includes("hoverPinned.current = true;"));
const hoverOpenBody = source.slice(source.indexOf("const hoverOpen = (next) => {"), source.indexOf("const hoverLeave = () => {"));
check("hover open does not steal focus", !hoverOpenBody.includes(".focus("), "hoverOpen must not call focus()");
check("seat inject survives a transient session rebind", source.includes("A session scope can be briefly absent while the client rebinds") && source.includes("unavailableFace()"));
check("seat keeps re-registering after a transient bind failure", source.includes("Math.min(backoff * 2, 5000)") && source.includes("registerSeat();") && !source.includes("failures +="));
//#endregion

//#region 4. factory + apply contract
const stubComponent = (props) => props;
const stubs = {
	"react": {
		useState: (value) => [value, () => {}],
		useRef: (value) => ({ current: value }),
		useEffect: () => {},
		useLayoutEffect: () => {},
		useId: () => "stub",
		useMemo: (fn) => fn(),
		useSyncExternalStore: (_subscribe, snapshot) => snapshot()
	},
	"react/jsx-runtime": { jsx: stubComponent, jsxs: stubComponent, Fragment: stubComponent },
	"react-dom": { createPortal: stubComponent },
	"@deepseek-ai/dsh-client-ui-primitives": new Proxy({}, { get: () => stubComponent })
};
let captured;
globalThis.window = {
	__ModuleLoader__: {
		load: (entry) => {
			captured = entry;
		}
	}
};
new Function(source)();

check("bundle registers its factory", captured?.id === "dsh-custom-desktop" && typeof captured.factory === "function");
const exportsObj = captured.factory((spec) => stubs[spec]);
check("exports apply/inject/name", typeof exportsObj.apply === "function" && Array.isArray(exportsObj.inject) && exportsObj.name === "dsh-custom-desktop");
check(
	"declares the seat services",
	["slots", "sessions", "modelDirectories"].every((face) => exportsObj.inject.includes(face)),
	exportsObj.inject.join(",")
);

let registered = null;
const shortcutCommands = [];
let contributedSessionMenu = null;
const menuService = { register: (entry) => { contributedSessionMenu = entry; return () => {}; }, notify() {} };
const sessionList = { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} };
const directoryStore = { getSnapshot: () => ({ groups: [], current: null, status: "ready", failures: [], retainedEffort: undefined }), subscribe: () => () => {} };
const slots = {
	inject: (_name, register) => register(),
	register: (entry, component) => (registered = { entry, component })
};
exportsObj.apply({
	sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
	inject: (_faces, body) =>
		body({
			modelDirectories: { directoryFor: () => ({ store: directoryStore, load: async () => {}, select: async () => ({ ok: true }) }) },
			sessions: { subagentAddress: () => undefined, list: sessionList },
			contextMenus: menuService,
			slots,
			shortcuts: { register: (command) => { shortcutCommands.push(command); return () => {}; } },
			layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
			effect: (fn) => fn()
		}),
	slots
});
check(
	"registers the seat below the official entry",
	registered?.entry?.name === "conversation.input.model" && registered.entry.priority === -1,
	JSON.stringify(registered?.entry?.name) + " priority=" + registered?.entry?.priority
);
check("two native commands without default bindings", shortcutCommands.length === 2 && shortcutCommands.every((command) => Object.keys(command.defaults).length === 0));
check("one native session delete action registered", contributedSessionMenu?.target === "session" && contributedSessionMenu.order === 9999);
const deleteAction = contributedSessionMenu?.resolve({ sessionId: "session-1", displayTitle: "Example" })?.[0];
check("delete action has destructive styling and callback", deleteAction?.danger === true && deleteAction?.afterContent === true && typeof deleteAction?.run === "function");
const previousFetch = globalThis.fetch;
let confirmCalls = 0;
window.confirm = () => { confirmCalls++; return false; };
let requestSent;
globalThis.document = { baseURI: "http://localhost:3333/" };
globalThis.fetch = async (url, options) => {
	requestSent = { url: String(url), options };
	return { ok: true, json: async () => ({ ok: true }) };
};
await deleteAction?.run();
check("delete runs without a confirmation prompt", confirmCalls === 0);
check("delete uses scoped Host POST endpoint", requestSent?.url === "http://localhost:3333/api/custom-desktop/delete-session" && requestSent?.options?.method === "POST" && JSON.parse(requestSent?.options?.body ?? "{}").sessionId === "session-1");
globalThis.fetch = previousFetch;
check("reuses the official locale namespace", registered?.entry?.locale === "model");
check("shadow component is the vendored one", typeof registered?.component === "function");
const face = registered?.entry?.inject("session-1");
check(
	"seat face matches the official contract",
	face?.available === true && face.directory === directoryStore && typeof face.load === "function" && typeof face.select === "function"
);
//#endregion

//#region 5. transient session bind recovery
let recoveryRegistrations = 0;
let recoveryRegistered = null;
// Each wait clears the pending retry (250ms, then doubling), so the next inject misses again.
// Four misses outlast the old 3-retry budget; the seat must still recover afterwards.
let recoveryFailures = Infinity;
const recoveryStore = {
	getSnapshot: () => ({ current: null, groups: [], status: "idle", failures: [], pending: null, error: null }),
	subscribe: () => () => {}
};
const recoverySlots = {
	inject: (_name, register) => {
		register();
		return () => {};
	},
	register: (entry, component) => {
		recoveryRegistrations += 1;
		recoveryRegistered = { entry, component };
		return () => {};
	}
};
exportsObj.apply({
	sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
	inject: (_faces, body) =>
		body({
			modelDirectories: {
				directoryFor: () => {
					if (recoveryFailures-- > 0) throw new Error("session scope not ready");
					return { store: recoveryStore, load: async () => {}, select: async () => ({ ok: true }) };
				}
			},
			sessions: { subagentAddress: () => undefined, list: sessionList },
			contextMenus: menuService,
			slots: recoverySlots,
			shortcuts: { register: () => () => {} },
			layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
			effect: (fn) => fn()
		}),
	slots: recoverySlots
});
const transientFace = recoveryRegistered?.entry?.inject("session-1");
check(
	"transient session bind returns a safe face instead of throwing",
	transientFace?.available === false && typeof transientFace?.directory?.getSnapshot === "function"
);
const injectSeat = async (ms) => {
	await new Promise((resolve) => setTimeout(resolve, ms));
	return recoveryRegistered?.entry?.inject("session-1");
};
const keptMissing = [];
for (const ms of [300, 600, 1100]) keptMissing.push((await injectSeat(ms))?.available === false);
recoveryFailures = 0;
const recoveredFace = await injectSeat(2100);
check(
	"transient session bind keeps re-registering and recovers past three misses",
	keptMissing.every(Boolean) && recoveryRegistrations >= 5 && recoveredFace?.available === true,
	`registrations=${recoveryRegistrations}`
);
//#endregion

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
