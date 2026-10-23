/**
 * Re-vendor `client.js` from the desktop app's own build — `node vendor.mjs`.
 *
 * Reads @deepseek-ai/dsh-client-ui-model-selection's shipped browser bundle straight
 * out of the running app's `app.asar` (the desktop profile's client rows come from
 * there, not from the profile's node_modules), keeps the four regions this plugin
 * needs (clsx, ModelSelect CSS, provider order, the component), and re-applies the
 * hover and native-command delta. Anchors are checked, so an upstream refactor fails loudly instead of
 * producing a half-patched bundle; the file it writes is the one `check-client.mjs`
 * then verifies.
 *
 * Run after updating the desktop app. Expect the CSS hash (`cl2Rlq_`) to change with
 * the app build — check-client.mjs asserts it, so update that assertion too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
const PKG = "dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection";
const PKG_NAME = "@deepseek-ai/dsh-client-ui-model-selection";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "client.js");

//#region asar reader (the shell cannot traverse app.asar; node can)
/**
 * Read one file out of an asar archive.
 * @param archive - archive path.
 * @param path - archive-relative file path.
 * @returns the file's UTF-8 contents.
 */
function readAsar(archive, path) {
	const buf = readFileSync(archive);
	const jsonStart = buf.indexOf('{"files":');
	if (jsonStart < 0) throw new Error(`not an asar archive: ${archive}`);
	const jsonLen = buf.readUInt32LE(jsonStart - 4);
	const header = JSON.parse(buf.slice(jsonStart, jsonStart + jsonLen).toString("utf8"));
	const base = jsonStart + jsonLen + ((4 - ((jsonStart + jsonLen) % 4)) % 4);
	let node = header;
	for (const part of path.split("/").filter(Boolean)) node = node?.files?.[part];
	if (node === undefined || node.files !== undefined) throw new Error(`not a file in ${archive}: ${path}`);
	return buf.slice(base + Number(node.offset), base + Number(node.offset) + Number(node.size)).toString("utf8");
}
//#endregion

//#region source slices (located by region markers, not line numbers)
/**
 * Cut one `//#region …` block out of a bundle, marker included.
 * @param text - the full bundle.
 * @param marker - the region's opening marker line content (without indentation).
 * @returns the region block, ending with its own `//#endregion`.
 */
function region(text, marker) {
	const at = text.indexOf(marker);
	if (at < 0) throw new Error(`region not found: ${marker}`);
	const lineStart = text.lastIndexOf("\n", at) + 1;
	const indent = /^\t*/.exec(text.slice(lineStart))[0];
	const end = text.indexOf(`\n${indent}//#endregion`, at);
	if (end < 0) throw new Error(`region end not found: ${marker}`);
	const after = text.indexOf("\n", end + 1);
	return text.slice(lineStart, after < 0 ? text.length : after);
}

/** Indentation of the line holding offset `at`. */
const indentAt = (text, at) => /^\t*/.exec(text.slice(text.lastIndexOf("\n", at) + 1))[0];

/**
 * Insert `extra` lines relative to the line containing `anchor`, at that line's
 * indentation. Empty strings stay empty (blank separators).
 * @param text - the text to patch.
 * @param anchor - unique substring of the anchor line.
 * @param extra - lines to insert.
 * @param where - "after" (default) or "before".
 * @returns the patched text.
 */
function insert(text, anchor, extra, where = "after") {
	const at = text.indexOf(anchor);
	if (at < 0) throw new Error(`anchor not found: ${anchor}`);
	const lineStart = text.lastIndexOf("\n", at) + 1;
	const eol = text.indexOf("\n", at);
	const indent = indentAt(text, at);
	const block = extra.map((line) => (line === "" ? "" : indent + line)).join("\n");
	return where === "after"
		? text.slice(0, eol + 1) + block + "\n" + text.slice(eol + 1)
		: text.slice(0, lineStart) + block + "\n" + text.slice(lineStart);
}
//#endregion

//#region assemble
const official = readAsar(ASAR, `${PKG}/lib/client.js`);
const version = JSON.parse(readAsar(ASAR, `${PKG}/package.json`)).version;

let component = region(official, "//#region lib/types/client/ModelSelect.js");

// 1. Hover hooks, declared with the other hooks (before the `!available` early return).
component = insert(component, "const itemRefs = (0, react.useRef)([]);", [
	"// Hover state (dsh-custom-desktop). Declared here, not with the handlers below, so",
	"// the hook order survives the `if (!available) return null` early return.",
	"const hoverTimers = (0, react.useRef)({ open: 0, close: 0 });",
	"const hoverPinned = (0, react.useRef)(false);",
	"(0, react.useEffect)(() => {",
	"\tif (!open) hoverPinned.current = false;",
	"}, [open]);",
	"(0, react.useEffect)(() => clearHover, []);"
]);

// 2. Hover handlers, next to the official show/close/drill verbs they build on.
component = insert(component, "/** Leave a drilled pane for the root one, handing the keyboard back to its cell. */", [
	"//#region hover interaction (dsh-custom-desktop)",
	"/** Drop both pending hover timers. */",
	"const clearHover = () => {",
	"\tif (hoverTimers.current.open !== 0) clearTimeout(hoverTimers.current.open);",
	"\tif (hoverTimers.current.close !== 0) clearTimeout(hoverTimers.current.close);",
	"\thoverTimers.current.open = 0;",
	"\thoverTimers.current.close = 0;",
	"};",
	"/**",
	"* Open straight into `next` after the dwell delay — never through the root menu.",
	"* Unlike the official show() this does not focus the trigger: hovering the seat",
	"* must not take the caret away from the composer.",
	"* @param next - pane to open: \"model\", \"effort\", or \"root\".",
	"*/",
	"const hoverOpen = (next) => {",
	"\tif (open || hoverPinned.current) return;",
	"\tclearHover();",
	"\thoverTimers.current.open = setTimeout(() => {",
	"\t\thoverTimers.current.open = 0;",
	"\t\tsetSelectionFocus(false);",
	"\t\tsetQuery(\"\");",
	"\t\tsetHighlightedIndex(null);",
	"\t\tpaneFocus.current = null;",
	"\t\tsetPane(next);",
	"\t\tsetOpen(true);",
	"\t\treload();",
	"\t}, HOVER_OPEN_DELAY);",
	"};",
	"/** Close a hover-opened menu after the grace delay; re-entering the seat cancels it. */",
	"const hoverLeave = () => {",
	"\tif (hoverPinned.current) return;",
	"\tclearHover();",
	"\thoverTimers.current.close = setTimeout(() => {",
	"\t\thoverTimers.current.close = 0;",
	"\t\tclose();",
	"\t}, HOVER_CLOSE_DELAY);",
	"};",
	"/** Any press inside the seat pins the menu: only the official close paths apply from then on. */",
	"const pinHover = () => {",
	"\thoverPinned.current = true;",
	"\tclearHover();",
	"};",
	"//#endregion",
	""
], "before");

// 3. Root subtree: enter/leave + pin on press.
component = insert(component, "\t\t\t\tonBlur,", ["onMouseEnter: clearHover,", "onMouseLeave: hoverLeave,"]);
component = component.replace(
	"\t\t\t\tonMouseDown: (event) => {\n\t\t\t\t\tif (event.target instanceof Element",
	"\t\t\t\tonMouseDown: (event) => {\n\t\t\t\t\tpinHover();\n\t\t\t\t\tif (event.target instanceof Element"
);

// 4. The two trigger captions are the hover targets.
component = insert(component, "className: ModelSelect_module_css_default.triggerLabel,", ["onMouseEnter: () => hoverOpen(\"model\"),"]);
component = insert(component, "className: ModelSelect_module_css_default.triggerEffort,", [
	"// The effort pane is empty when the model exposes no reasoning levels — the root",
	"// menu (whose effort cell is not rendered either) is the honest destination.",
	"onMouseEnter: () => hoverOpen(reasoning === void 0 ? \"root\" : \"effort\"),"
]);

// 5. The menu is portaled to document.body, so it needs its own enter/leave/pin.
component = insert(component, "className: ModelSelect_module_css_default.menu,", [
	"onMouseEnter: clearHover,",
	"onMouseLeave: hoverLeave,",
	"onMouseDown: pinHover,"
]);

// 6. Rename the component so the vendor line is obvious in a diff.
const signature = "function ModelSelect({ ";
if (!component.includes(signature)) throw new Error("ModelSelect signature not found");
component = component.replace(signature, "function HoverModelSelect({ registerCommands, ");

// The official entry owns conversation.input.model.label. This shadow entry
// cannot redeclare that slot and receives no renderSlot prop. Keep its plain
// model-name fallback, as the original custom-desktop component did.
const labelSlot = /renderSlot\("conversation\.input\.model\.label",\s*\{\s*provider,\s*model,\s*placement,\s*selected\s*\},\s*\{ fallback: model\.name \}\)/;
if (!labelSlot.test(component)) throw new Error("ModelSelect label slot call changed; review the shadow component adapter");
component = component.replace(labelSlot, "model.name").replace(
	", t, renderSlot }) {", ", t }) {"
);

// Publish the mounted seat's current actions; resolving never performs UI work.
component = insert(component, "if (!available) return null;", [
	"(0, react.useEffect)(() => {",
	"\tif (available) load();",
	"}, [available, directory]);",
	"(0, react.useLayoutEffect)(() => registerCommands((action) => {",
	"\tif (!available || locked || busy) return { status: \"blocked\", reason: \"当前模型选择不可用或正在更新\" };",
	"\tif (action === \"model\") return {",
	"\t\tstatus: \"handled\",",
	"\t\trun: () => { show(); drill(\"model\"); pinHover(); }",
	"\t};",
	"\tif (state.current === null || effortChoices.length < 2) return { status: \"blocked\", reason: \"当前模型没有可切换的推理等级，或模型目录尚未就绪\" };",
	"\tconst index = effortChoices.findIndex((choice) => choice.effort === effectiveEffort);",
	"\treturn { status: \"handled\", run: () => chooseEffort(effortChoices[(index + 1) % effortChoices.length].effort) };",
	"}));"
], "before");

// 7. Module-scope hover timings, next to the other module constants.
component = insert(component, "/** Unplaced portal card:", [
	"//#region hover shortcut timings",
	"/** Hover dwell before a pane opens (ms) — filters pointer transit over the seat. */",
	"const HOVER_OPEN_DELAY = 150;",
	"/** Grace before a hover-opened menu closes (ms) — must cover the 8px trigger↔menu gap. */",
	"const HOVER_CLOSE_DELAY = 300;",
	"//#endregion",
	""
], "before");

const css = region(official, "//#region \\0dsh-css:")
	.replace(`const tagId = "${PKG_NAME}/ModelSelect.module.css";`, 'const tagId = "dsh-custom-desktop/model-select.css";')
	.replace('tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-model-selection";', 'tag.dataset.plugin = "dsh-custom-desktop";');
//#endregion

//#region output
const header = `/**
 * Browser half of \`dsh-custom-desktop\` — desktop-only hover and native
 * shortcuts on the composer's model seat (\`conversation.input.model\`).
 *
 * Strategy: register a second occupant of the single slot at priority -1 (a slot
 * renders its LOWEST-priority entry), which shadows the official ModelSelect. The
 * official plugin stays loaded and keeps providing everything this copy does not
 * need: the \`model\` dictionaries, the /model popup, and the per-session
 * ModelDirectoryResolver service behind \`ctx.modelDirectories\`.
 *
 * The component below is vendored from the build the DeepSeek Harness
 * desktop app ships — @deepseek-ai/dsh-client-ui-model-selection@${version}
 * (app.asar/dsh) — minus the catalog/directory/resolver classes, the locale
 * dictionaries and the /model contribution (a resolver and dictionaries are
 * mounted by the official plugin; only ModelSelect is needed here). The
 * hover lifecycle adds: dwelling 150ms on the model name opens the
 * provider-grouped model list directly, dwelling on the effort caption opens the
 * effort list, and leaving the seat closes a hover-opened menu after 300ms. The
 * click path is unchanged. Two unbound native commands open the model pane
 * or cycle the current model's effort choices through the existing handlers.
 *
 * Why a vendored copy instead of DOM manipulation: "open straight into pane X"
 * is React state inside the official component. A DOM-level implementation would
 * have to synthesise trigger→cell click pairs and depend on hashed class names
 * (\`cl2Rlq_*\`); the copy keeps i18n, keyboard navigation, search and menu
 * positioning exact for the same reason.
 *
 * Generated by \`node vendor.mjs\` — do not edit by hand; patch vendor.mjs instead.
 * Desktop-only by construction: the vendored markup and CSS are pinned to the
 * build above, so re-vendor whenever the app updates.
 *
 * @module dsh-custom-desktop/client
 */
window.__ModuleLoader__.load({
\tid: "dsh-custom-desktop",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tlet _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
\t\tlet react_jsx_runtime = require("react/jsx-runtime");
\t\tlet react = require("react");
\t\tlet react_dom = require("react-dom");
`;

const footer = `\t\t//#region plugin
\t\t/**
\t\t* Required services: the slot registry, the session face (the seat is hidden in
\t\t* addressed subagent sessions), and the per-session model directory the
\t\t* official ui-model-selection provides. \`remote.session\` is touched internally
\t\t* by directoryFor() — without it the entry crashes and abdicates the seat.
\t\t*/
\t\tconst inject = [
\t\t\t"slots",
\t\t\t"sessions",
\t\t\t"modelDirectories",
\t\t\t"remote",
\t\t\t"remote.session"
\t\t];
\t\t/**
\t\t* Client plugin body: take the composer's model seat with the hover-aware copy,
\t\t* \`locale: "model"\` reuses the official dictionary namespace for every string.
\t\t* @param ctx - client root context.
\t\t*/
\t\tfunction apply(ctx) {
\t\t\tconst commands = new Map();
\t\t\tctx.inject(["shortcuts", "layout"], (scope) => {
\t\t\t\tfor (const [action, id, label] of [
\t\t\t\t\t["effort", "custom-desktop.reasoning-effort.cycle", "切换推理等级（Reasoning effort）"],
\t\t\t\t\t["model", "custom-desktop.model.open", "唤出模型选择卡"]
\t\t\t\t]) scope.effect(() => scope.shortcuts.register({
\t\t\t\t\tid,
\t\t\t\t\tlabel: () => label,
\t\t\t\t\taliases: [label, id, action === "effort" ? "reasoning effort" : "model selection"],
\t\t\t\t\tdefaults: {},
\t\t\t\t\tregions: ["page", "editable", "terminal"],
\t\t\t\t\tmodals: [],
\t\t\t\t\tresolve: (context) => {
\t\t\t\t\t\tconst current = Object.values(ctx.sessions.list.getSnapshot().byId).find((row) => (row.retainedBy.mainView ?? 0) > 0);
\t\t\t\t\t\tconst resolve = current === undefined ? undefined : commands.get(current.id);
\t\t\t\t\t\tif (context.modal !== null || scope.layout.panelInfo.getSnapshot().activePanelId !== null || resolve === undefined) {
\t\t\t\t\t\t\treturn { status: "blocked", reason: "当前没有可操作的会话模型选择器" };
\t\t\t\t\t\t}
\t\t\t\t\t\treturn resolve(action);
\t\t\t\t\t}
\t\t\t\t}), id);
\t\t\t});
\t\t\tctx.inject(["slots", "modelDirectories"], (scope) => {
\t\t\t\tconst models = scope.modelDirectories;
\t\t\t\tconst sessions = scope.sessions;
\t\t\t\tscope.slots.inject("conversation.input.model", () => scope.slots.register({
\t\t\t\t\tname: "conversation.input.model",
\t\t\t\t\tpriority: -1,
\t\t\t\t\tlocale: "model",
\t\t\t\t\tregistrant: "dsh-custom-desktop",
\t\t\t\t\tinject: (sessionId) => {
\t\t\t\t\t\tconst directory = models.directoryFor(sessionId);
\t\t\t\t\t\tconst available = sessions.subagentAddress(sessionId) === void 0;
\t\t\t\t\t\treturn {
\t\t\t\t\t\t\tavailable,
\t\t\t\t\t\t\tregisterCommands: (resolve) => {
\t\t\t\t\t\t\t\tcommands.set(sessionId, resolve);
\t\t\t\t\t\t\t\treturn () => { if (commands.get(sessionId) === resolve) commands.delete(sessionId); };
\t\t\t\t\t\t\t},
\t\t\t\t\t\t\tdirectory: directory.store,
\t\t\t\t\t\t\tload: () => {
\t\t\t\t\t\t\t\tif (available) directory.load().catch(() => {});
\t\t\t\t\t\t\t},
\t\t\t\t\t\t\tselect: (selection) => available ? directory.select(selection) : Promise.resolve(void 0)
\t\t\t\t\t\t};
\t\t\t\t\t}
\t\t\t\t}, HoverModelSelect));
\t\t\t});
\t\t}
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\texports.name = "dsh-custom-desktop";
\t\t//#endregion
\t\treturn module.exports;
\t}
});
`;

const out = [
	header,
	region(official, "//#region ../../../node_modules/.pnpm/clsx@"),
	css,
	region(official, "//#region lib/types/client/provider-order.js"),
	component,
	footer
].join("\n");

writeFileSync(OUT, out);
const hash = /\.([A-Za-z0-9_]+)_trigger\{/.exec(css)?.[1] ?? "?";
console.log(`vendored ${version} → ${OUT} (${out.split("\n").length} lines, css prefix ${hash}_)`);
if (version !== "0.2.0-rc.2") console.log(`note: check-client.mjs asserts the 0.2.0-rc.2 css prefix — update it for ${hash}_`);
//#endregion
