//#region dsh-custom-desktop — Host half (empty)
/**
 * dsh-custom-desktop — Host 半:空实现。
 *
 * 本插件的全部行为都在浏览器半(`package.json` 的 `exports["./client"]`):席位阴影
 * 与 hover 直达都是纯客户端 UI,host 侧不需要路由、服务或事件。
 *
 * 这个模块存在的唯一理由:client-modules 是从 host Loader 的条目里发现
 * `dsh.client` 声明、并把浏览器半投递给页面的,所以每个 bundle 条目都需要一个
 * 可导入的 host 模块。这里的 apply 不做任何事。
 */

/** Stable Cordis plugin name (host row id is `custom-desktop`). */
const name = "custom-desktop";

/** No host-side contribution. */
function apply() {}

export { apply, name };
//#endregion
