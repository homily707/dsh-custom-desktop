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
const directoryStore = { getSnapshot: () => ({ groups: [], current: null, status: "ready", failures: [], retainedEffort: undefined }), subscribe: () => () => {} };
const slots = {
	inject: (_name, register) => register(),
	register: (entry, component) => (registered = { entry, component })
};
exportsObj.apply({
	inject: (_faces, body) =>
		body({
			modelDirectories: { directoryFor: () => ({ store: directoryStore, load: async () => {}, select: async () => ({ ok: true }) }) },
			sessions: { subagentAddress: () => undefined },
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

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
