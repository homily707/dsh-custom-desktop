# dsh-custom-desktop

DSH 桌面应用（`desktop` profile）专用的两处 UI 微调：**composer 模型席位悬浮直达**、
**侧边栏 fork 标记**（缩进 + `└`）。

席位那半只适配 desktop —— 组件是从桌面应用内置的
`@deepseek-ai/dsh-client-ui-model-selection@0.2.0-rc.2` 逐字 vendor 的，不保证在其它
DSH 版本（web profile、npm 上的 0.1.x）上可用。若应用升级，按下面「重新 vendor」更新。
侧边栏那半是手写的 DOM 标记，只依赖官方两个公开面（行的 `data-row-key` 属性、会话列表
快照的 `parentId`），任何具备它们的构建都能用。

## 行为

### composer 模型席位（vendored）

- 鼠标悬浮**模型名称** → 停留 150ms 后直接展开 provider 分组的模型列表（跳过官方的两行根菜单）
- 鼠标悬浮**思考深度（effort 标签）** → 停留 150ms 后直接展开 effort 等级列表；该模型没有推理等级时回退到根菜单（effort 行本来也不渲染）
- **点击 trigger 的行为完全不变**：仍是官方两行菜单（模型 / 推理等级）的 toggle
- 指针离开席位（trigger + 菜单子树）300ms 后自动收起；300ms 覆盖 trigger↔菜单的 8px 间隙
- 在席位内按下过鼠标后菜单视为**已固定**，此后只按官方逻辑关闭（外点 / Esc / blur）
- hover 打开**不移动焦点**，所以不会把输入框的光标抢走（官方 `show()` 会 focus trigger，hover 路径刻意不调用）

### 侧边栏 fork 标记（手写）

- 会话列表里凡是从别的会话 fork 出来的行，行首加一个 `└`，整行右移一个缩进级；fork 的 fork 再深一级（每级 12px）
- 只认谱系，不区分 fork 与官方 turn 尾 branch 按钮产生的分支——两者都是同一个 `parentSession`
- **只标记，不搬运**：不移动、不隐藏、不重排、不改官方 class，所以官方排序、归档筛选与灰显、置顶、拖拽重排、每个 workspace 的「展开更多」都不受影响
- 归档、取消归档、切换归档筛选时只是重新跑一遍标记：归档的 fork 行照样带符号（灰显由官方渲染）
- 子代理（`origin: "subagent"`）子会话不算 fork，不标记

## 实现

`client.js` 以 priority `-1` 向单席位 slot `conversation.input.model` 注册第二个占据者
（slot 语义：同 cell 多 priority 共存，**最低者优先渲染**），从而阴影官方 ModelSelect。
官方插件照常加载，继续提供本副本不需要的一切：`model` 字典、`/model` 弹窗、以及
`ctx.modelDirectories` 背后的 per-session ModelDirectoryResolver。

vendored 内容只保留官方 `ModelSelect` 组件本体及其 CSS/clsx/provider 排序（`cl2Rlq_*`
类名原样保留），裁掉了 catalog/directory/resolver 类、locales 字典和 `/model`
命令贡献 —— 那些由官方插件提供。**唯一增量是 hover 生命周期**（`HOVER_OPEN_DELAY` /
`HOVER_CLOSE_DELAY` / `hoverOpen` / `hoverLeave` / `pinHover`），点击路径逐字未动。

为什么整块 vendor 而不是改 DOM：hover 要「直达指定 pane」，而 pane 是官方组件内部的
React state；DOM 方案只能人为合成 trigger→cell 两次点击，并依赖哈希类名。副本方案保住了
i18n、键盘导航、检索与菜单定位。

侧边栏 fork 标记走的是相反的路：缩进纯属表现层，所以它是手写的 DOM 标记，不 vendor。

- 数据：`ctx.sessions.list` 快照里每个 fork 子行都带 `parentId`（Host 把 journal 首行的
  `parentSession` 投影成这个字段）；`origin: "subagent"` 的是子代理子会话，不是 fork。
- 锚点：官方行上的 `data-row-key="session:<id>"`——显式属性，不是哈希类名。
- 落笔：`data-dsh-fork-depth` 属性 + 一个 `--dsh-fork-indent` 自定义属性，缩进由一个
  `::before` flex item 承担，因此**不覆盖官方的 `padding-inline-start`**（那上面已经驮着
  workspace 分组的缩进）。这两个都不是 React 渲染的 prop，普通重渲染不会抹掉。
- 复跑：`sessions.list` 订阅 + `document.body` 的 MutationObserver（rAF 合并），行随列表
  增删/重排时重标；`ctx.effect` 里整体回收（样式表、observer、订阅、标记）。
- 深度沿 `parentId` 链现算（环安全），因为 runtime 的 `flattenLineage` 只把 `depth` 留在
  manager 层，投影进 store 时已经丢掉。

- `index.mjs` — host 半：空实现（client-modules 需要每个 bundle 有一个可导入的 host 模块）
- `cordis.patch.yml` — 一行 Loader insert，让 host 收录本包、client-modules 才会投递 `client.js`
- `vendor.mjs` — 生成 `client.js` 的 vendor 脚本（不进 npm 包，只在仓库里）；侧边栏标记那段是
  这个脚本里手写拼接的 `forkMarker` 区域，重新 vendor 不会丢
- `check-client.mjs` — 本地检查（manifest / 注册契约 / hover 静态契约 / fork 标记静态+假 DOM 契约 / factory+apply 执行）

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
link:/Users/lmh/codes/homily707/my-dsh/dsh-custom-desktop
```

安装后刷新页面生效。

## 验证

```sh
node check-client.mjs
```

手工确认（页面刷新后）：悬浮模型名 → 直接出模型列表；悬浮 effort 标签 → 直接出等级列表；
点击 trigger → 官方两行菜单不变；鼠标移开 → 300ms 后收起；按下菜单后再移开 → 不自动收起，
点外部才关。

侧边栏 fork 标记（页面刷新后）：

1. 随便用一个会话跑一次 fork（turn 尾 branch 按钮，或 dsh-quick-fork 的 ✎）→ 新行带 `└`，比普通行右移一级（默认排序下它是最新的，通常落在本组最上面；想让新 fork 紧挨源行，把右栏排序切成官方「自定义排序」）
2. 对分支再 fork 一次 → 第二级再右移一级
3. 归档该分支 / 切归档筛选到「显示归档」→ 行原地灰显，符号和缩进保留（插件的标记不干预官方筛选）
4. 拖拽重排、置顶、点「展开更多」→ 位置与落点都按官方逻辑，符号跟着行走

## 已知取舍

- **Esc 不关闭 hover 打开的菜单**：hover 路径不 focus 席位，键盘事件到不了组件的
  `onKeyDown`，因此 hover 菜单靠指针离开 / 外点关闭（点 trigger 打开的菜单 Esc 行为不变）。
  这是「不抢焦点」的代价。
- 样式随副本：下次应用升级官方组件改版后，需重新 vendor，否则菜单外观可能与官方游走。
- 阴影期间官方 ModelSelect 仍被加载（它提供字典与 resolver），只是不渲染席位。
- **fork 标记依赖两个官方面**：行的 `data-row-key="session:<id>"` 与会话列表快照的 `parentId`。
  任一面改名，表现为符号消失（不报错、不影响会话），改锚点即可恢复。
- **不做折叠、不做级联归档**：fork-edit 那套「按谱系分组 + 折叠 + 级联归档」会与官方的归档
  筛选、单会话 undo、置顶/拖拽重排互相打架（详见仓库笔记），这里刻意只做就地标记。
- **缩进是否跟源行对齐，取决于官方的排序模式**：官方默认「按更新时间」排序（`orderBy: 'updated'`），
  fork 行按时间排，未必紧挨源行，连续 fork 时缩进看起来是悬空的；切到官方「自定义排序」
  （`manual`）后，官方会把新 fork 排到源行紧邻位置，缩进才与源行对齐。本插件不动排序——
  要哪种对齐方式由你切官方那个开关。
- 深度不设上限，也没有汇总折叠：连续十来次 fork 会一路缩进下去，属预期。
