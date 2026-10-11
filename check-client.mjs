/**
 * Local checks for dsh-custom-desktop — `node check-client.mjs` (or `npm test`).
 *
 * 1. Manifest / Loader row: platform, bundle patch, client inject faces, insert row.
 * 2. Vendor provenance: the component is the build the desktop app ships (0.2.0-rc.2,
 *    `cl2Rlq_` CSS prefix) and carries its own style tag id.
 * 3. Hover contract (static): 150ms dwell, 300ms grace, both captions wired, the
 *    portal menu wired, press pinning, and no focus steal on the hover path.
 * 4. Fork-marker contract: marking-only invariants (no row reorder, hiding, class
 *    churn or official padding override) plus a fake-DOM pass that marks forks
 *    with their lineage depth and leaves ordinary rows alone.
 * 5. Runtime contract: execute the bundle factory against stub modules, then call
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
check("loader row inserted", /id: custom-desktop\b/.test(patch) && /name: dsh-custom-desktop\b/.test(patch));
//#endregion

//#region 2. vendor provenance
check("vendored from the desktop build (cl2Rlq_ styles)", source.includes(".cl2Rlq_trigger{"));
check("own style tag id (no collision with the official tag)", source.includes('const tagId = "dsh-custom-desktop/model-select.css";'));
check("loader id is the package name", source.includes('id: "dsh-custom-desktop"'));
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
//#endregion

//#region 4. fork marker contract
const markerRegion = source.slice(
	source.indexOf("//#region sidebar fork marker"),
	source.indexOf("//#region plugin")
);
check("fork marker region present", markerRegion.length > 0);
check("anchors on the official row attribute", markerRegion.includes("'[data-row-key^=\"session:\"]'"));
check("mark is an attribute plus one custom property", markerRegion.includes('"data-dsh-fork-depth"') && markerRegion.includes("--dsh-fork-indent"));
check("marker rides a flex pseudo-element", markerRegion.includes('[data-dsh-fork-depth]::before{content:"└"'));
check("depth walk is cycle-safe", markerRegion.includes("new Set([id])"));
check("follows the official order instead of moving rows", !markerRegion.includes("insertBefore("));
check("never removes or re-classes a row", !markerRegion.includes("removeChild(") && !markerRegion.includes("classList"));
check("never hides a row", !markerRegion.includes("display"));
check("never overrides the official padding", !markerRegion.includes("padding"));
check("never archives", !markerRegion.includes("archive"));
check(
	"only the plugin's own stylesheet is appended",
	(markerRegion.match(/appendChild\(/g) ?? []).length === 1 && markerRegion.includes("document.head.appendChild(style)"),
	"row nodes must stay where React put them"
);
check("apply installs the marker from the session face", source.includes("ctx.inject([\"sessions\"], (scope) => {") && source.includes("installForkMarkers(scope, scope.sessions);"));
//#endregion

//#region 5. factory + apply contract
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
/** Minimal session row: attributes plus one inline custom property, nothing else. */
const fakeRow = (id) => ({
	attributes: { "data-row-key": `session:${id}` },
	style: {
		properties: {},
		setProperty(name, value) { this.properties[name] = value; },
		removeProperty(name) { delete this.properties[name]; }
	},
	getAttribute(name) { return this.attributes[name] ?? null; },
	setAttribute(name, value) { this.attributes[name] = value; },
	removeAttribute(name) { delete this.attributes[name]; }
});
const rows = ["root", "fork", "grand", "sub", "cycle-a", "cycle-b"].map(fakeRow);
const rowOf = (id) => rows.find((row) => row.getAttribute("data-row-key") === `session:${id}`);
const depthOf = (id) => rowOf(id).getAttribute("data-dsh-fork-depth");
const listSnapshot = () => ({
	byId: {
		root: { id: "root" },
		fork: { id: "fork", parentId: "root" },
		grand: { id: "grand", parentId: "fork" },
		sub: { id: "sub", parentId: "fork", origin: "subagent" },
		"cycle-a": { id: "cycle-a", parentId: "cycle-b" },
		"cycle-b": { id: "cycle-b", parentId: "cycle-a" }
	}
});
let appendedStyle;
globalThis.document = {
	body: {},
	head: { appendChild: (node) => { appendedStyle = node; } },
	querySelector: () => null,
	createElement: () => ({ dataset: {}, textContent: "", isConnected: true, remove() { this.isConnected = false; } }),
	querySelectorAll: (selector) => selector === '[data-row-key^="session:"]'
		? rows
		: rows.filter((row) => row.getAttribute("data-dsh-fork-depth") !== null)
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimeout;

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
const directoryStore = { getSnapshot: () => ({ groups: [], current: null, status: "ready", failures: [], retainedEffort: undefined }), subscribe: () => () => {} };
const slots = {
	inject: (_name, register) => register(),
	register: (entry, component) => (registered = { entry, component })
};
exportsObj.apply({
	inject: (_faces, body) =>
		body({
			modelDirectories: { directoryFor: () => ({ store: directoryStore, load: async () => {}, select: async () => ({ ok: true }) }) },
			sessions: { subagentAddress: () => undefined, list: { getSnapshot: listSnapshot, subscribe: () => () => {} } },
			slots
		}),
	slots
});
check(
	"registers the seat below the official entry",
	registered?.entry?.name === "conversation.input.model" && registered.entry.priority === -1,
	JSON.stringify(registered?.entry?.name) + " priority=" + registered?.entry?.priority
);
check("reuses the official locale namespace", registered?.entry?.locale === "model");
check("shadow component is the vendored one", typeof registered?.component === "function");
const face = registered?.entry?.inject("session-1");
check(
	"seat face matches the official contract",
	face?.available === true && face.directory === directoryStore && typeof face.load === "function" && typeof face.select === "function"
);
//#endregion

//#region 6. fork marker runtime (same apply, fake DOM)
check("fork child is marked at depth 1", depthOf("fork") === "1", String(depthOf("fork")));
check("nested fork inherits depth 2", depthOf("grand") === "2", String(depthOf("grand")));
check("ordinary root stays unmarked", depthOf("root") === null);
check("subagent child is not a fork", depthOf("sub") === null);
check("cyclic lineage terminates", depthOf("cycle-a") === "1" && depthOf("cycle-b") === "1");
check(
	"indent scales with the depth",
	rowOf("fork").style.properties["--dsh-fork-indent"] === "0px" && rowOf("grand").style.properties["--dsh-fork-indent"] === "12px",
	JSON.stringify(rowOf("grand").style.properties)
);
check(
	"marker stylesheet is the plugin's own",
	appendedStyle?.dataset?.plugin === "dsh-custom-desktop" && appendedStyle.textContent.includes("[data-dsh-fork-depth]::before"),
	JSON.stringify(appendedStyle?.dataset)
);
check(
	"rows carry no other attribute or style change",
	rows.every((row) => Object.keys(row.attributes).length === (depthOf(row.getAttribute("data-row-key").slice("session:".length)) === null ? 1 : 2))
	&& rows.every((row) => Object.keys(row.style.properties).every((name) => name === "--dsh-fork-indent")),
	"marking must not touch anything else on the row"
);
//#endregion

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
