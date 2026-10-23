# dsh-custom-desktop

DSH 桌面应用（`desktop` profile）专用的 UI 微调：**composer 模型席位悬浮直达，以及两个可配置快捷键的宿主命令**。

只适配 desktop —— 组件是从桌面应用内置的
`@deepseek-ai/dsh-client-ui-model-selection@0.2.1-rc.2` vendor 的，不保证在其它
DSH 版本（web profile、npm 上的 0.1.x）上可用。若应用升级，按下面「重新 vendor」更新。

## 行为

### composer 模型席位（vendored）

- 鼠标悬浮**模型名称** → 停留 150ms 后直接展开 provider 分组的模型列表（跳过官方的两行根菜单）
- 鼠标悬浮**思考深度（effort 标签）** → 停留 150ms 后直接展开 effort 等级列表；该模型没有推理等级时回退到根菜单（effort 行本来也不渲染）
- **点击 trigger 的行为完全不变**：仍是官方两行菜单（模型 / 推理等级）的 toggle
- 指针离开席位（trigger + 菜单子树）300ms 后自动收起；300ms 覆盖 trigger↔菜单的 8px 间隙
- 在席位内按下过鼠标后菜单视为**已固定**，此后只按官方逻辑关闭（外点 / Esc / blur）
- hover 打开**不移动焦点**，所以不会把输入框的光标抢走（官方 `show()` 会 focus trigger，hover 路径刻意不调用）

### 可配置快捷键

在 DSH 快捷键设置中搜索下列命令并自行绑定；两者都没有默认键位。

| 命令 | ID | 行为 |
| --- | --- | --- |
| 切换推理等级（Reasoning effort） | `custom-desktop.reasoning-effort.cycle` | 按当前模型的 effort 列表依次循环，最后一项回到第一项；没有显式默认等级时包含“提供方默认值” |
| 唤出模型选择卡 | `custom-desktop.model.open` | 直接打开输入框旁的模型列表，可搜索、键盘导航和选择模型 |

命令只作用于当前主会话的模型选择器；其他面板、弹窗、锁定状态或模型更新期间不可用。
不支持 effort 或不足两个选项时不切换。模型目录尚未就绪时也不切换；组件挂载会加载目录。
动作在宿主调用 `run` 时执行，`resolve` 不执行动作。绑定、持久化、冲突检查和按键重复过滤均由宿主处理。

## 实现

`client.js` 以 priority `-1` 向单席位 slot `conversation.input.model` 注册第二个占据者
（slot 语义：同 cell 多 priority 共存，**最低者优先渲染**），从而阴影官方 ModelSelect。
官方插件照常加载，继续提供本副本不需要的一切：`model` 字典、`/model` 弹窗、以及
`ctx.modelDirectories` 背后的 per-session ModelDirectoryResolver。

vendored 内容只保留官方 `ModelSelect` 组件本体及其 CSS/clsx/provider 排序（`cl2Rlq_*`
类名原样保留），裁掉了 catalog/directory/resolver 类、locales 字典和 `/model`
命令贡献 —— 那些由官方插件提供。**增量是 hover 生命周期和两个宿主命令**（`HOVER_OPEN_DELAY` /
`HOVER_CLOSE_DELAY` / `hoverOpen` / `hoverLeave` / `pinHover`），点击路径逐字未动。

为什么整块 vendor 而不是改 DOM：hover 要「直达指定 pane」，而 pane 是官方组件内部的
React state；DOM 方案只能人为合成 trigger→cell 两次点击，并依赖哈希类名。副本方案保住了
i18n、键盘导航、检索与菜单定位。

- `index.mjs` — host 半：空实现（client-modules 需要每个 bundle 有一个可导入的 host 模块）
- `cordis.patch.yml` — 一行 Loader insert，让 host 收录本包、client-modules 才会投递 `client.js`
- `vendor.mjs` — 生成 `client.js` 的 vendor 脚本（不进 npm 包，只在仓库里）
- `check-client.mjs` — 本地检查（manifest / 注册契约 / hover 静态契约 / factory+apply 执行）

没有 npm 依赖，没有 host 服务，不注册任何 HTTP 路由。

## 重新 vendor（应用升级后）

```sh
node vendor.mjs        # 从 app.asar 重新取官方 bundle → 切片 → 打 hover 补丁 → 重写 client.js
node check-client.mjs  # 校验
```

`client.js` 由 `vendor.mjs` 生成，**不要手改**：改 vendor.mjs 里的补丁点再重新生成。
切片按 region 标记定位（`clsx` / `ModelSelect.module.css` / `provider-order.js` /
`ModelSelect.js`），锚点找不到会直接报错，不会产出半成品；应用升级后 CSS 哈希（当前
`cl2Rlq_`）会变，`check-client.mjs` 里对应的断言要一起更新（vendor.mjs 会提示）。

## 安装（desktop profile）

桌面 profile 由 Electron 应用独占管理，`dsh plugin --profile desktop ...` 会被拒绝
（`profile "desktop" is managed exclusively by the Electron application` /
`EPERM package.json.lock`）。走应用自己的插件管理入口，加本地链接依赖——与已装的
`dsh-quick-fork` 相同的形式：

```
link:/Users/lmh/code/homily707/dsh-custom-desktop
```

安装后刷新页面生效。本地直接更新已安装包的文件可能在插件更新或重装时被覆盖；源码保留在上述 checkout 中。

## 验证

```sh
node check-client.mjs
```

手工确认（页面刷新后）：悬浮模型名 → 直接出模型列表；悬浮 effort 标签 → 直接出等级列表；
点击 trigger → 官方两行菜单不变；鼠标移开 → 300ms 后收起；按下菜单后再移开 → 不自动收起，
点外部才关。

## 已知取舍

- **Esc 不关闭 hover 打开的菜单**：hover 路径不 focus 席位，键盘事件到不了组件的
  `onKeyDown`，因此 hover 菜单靠指针离开 / 外点关闭（点 trigger 打开的菜单 Esc 行为不变）。
  这是「不抢焦点」的代价。
- 样式随副本：下次应用升级官方组件改版后，需重新 vendor，否则菜单外观可能与官方游走。
- 模型名称使用原始 `model.name`，不渲染官方 `conversation.input.model.label` 扩展子槽位：该槽位归官方组件所有，本副本不能重复声明，也不会获得它的 `renderSlot` 权限。
- 阴影期间官方 ModelSelect 仍被加载（它提供字典与 resolver），只是不渲染席位。
