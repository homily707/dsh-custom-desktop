# dsh-custom-desktop

DSH 桌面应用（`desktop` profile）专用的 UI 微调：**composer 模型席位悬浮直达、两个可配置快捷键，以及 Host 端的极简缓存保温 slash 命令**。

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

- `index.mjs` — Host 入口：注入 LLM 与命令服务并安装缓存保温功能
- `cache-keepalive.mjs` — Host 保温调度、前缀截断和 `/cache` 命令
- `cache-stats.mjs` — 每次保温请求的缓存用量计算和本地 JSONL 持久化
- `cordis.patch.yml` — 一行 Loader insert，让 host 收录本包、client-modules 才会投递 `client.js`
- `vendor.mjs` — 生成 `client.js` 的 vendor 脚本（不进 npm 包，只在仓库里）
- `check-client.mjs` — 本地检查（manifest / 注册契约 / hover 静态契约 / factory+apply 执行）

没有新增 npm 依赖，也不注册任何 HTTP 路由。缓存保温仅使用 DSH 已有的 Host 服务。

## 重新 vendor（应用升级后）

```sh
node vendor.mjs        # 从 app.asar 重新取官方 bundle → 切片 → 打 hover 补丁 → 重写 client.js
node check-client.mjs  # 校验 UI
node check-host.mjs    # 校验保温行为
node check-cache-stats.mjs # 校验缓存命中率及保存
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
node check-host.mjs
node check-cache-stats.mjs
```

手工确认（页面刷新后）：悬浮模型名 → 直接出模型列表；悬浮 effort 标签 → 直接出等级列表；
点击 trigger → 官方两行菜单不变；鼠标移开 → 300ms 后收起；按下菜单后再移开 → 不自动收起，
点外部才关。

## 会话重绑保护

桌面客户端在安装/更新插件、Host 重连或切换会话时会短暂重建 session scope。此时
`ModelDirectoryResolver.directoryFor()` 可能抛出 `resolved no scope` / `resolved no binding`；
如果从 `inject` 直接把该异常抛出，DSH 的 slot 错误边界会把这个 entry 永久标记为
`abdicated`，只能关/开插件才能恢复。插件现在会捕获这种瞬态失败，短暂重试重新注册席位，
最多 3 次后退回官方 ModelSelect。

## 已知取舍

- **Esc 不关闭 hover 打开的菜单**：hover 路径不 focus 席位，键盘事件到不了组件的
  `onKeyDown`，因此 hover 菜单靠指针离开 / 外点关闭（点 trigger 打开的菜单 Esc 行为不变）。
  这是「不抢焦点」的代价。
- 样式随副本：下次应用升级官方组件改版后，需重新 vendor，否则菜单外观可能与官方游走。
- 模型名称使用原始 `model.name`，不渲染官方 `conversation.input.model.label` 扩展子槽位：该槽位归官方组件所有，本副本不能重复声明，也不会获得它的 `renderSlot` 权限。
- 阴影期间官方 ModelSelect 仍被加载（它提供字典与 resolver），只是不渲染席位。

## 会话缓存保温（Host）

使用 DSH 原生 slash 命令，不需要任何额外 UI：

- `/cache on`：开启**当前会话**的缓存保温（默认关闭）。
- `/cache off`：关闭当前会话保温并取消正在进行的后台请求。
- `/cache`：查询当前会话开关状态。

开启后，插件等待该会话下一次成功的普通 Agent 模型请求，然后只保存其 **system / developer 等前缀和第一条 user 消息**（包含首条 user，但不包含后续 assistant、tool、user 消息）。原始 provider、model、tools 等请求头保留；旧请求的 `signal` 和完整会话的 `toolHistory` 不再附带。后续成功的 Agent 请求会用最新请求的首条 user 前缀更新这个快照，以跟随模型或系统上下文变化。

Host 每隔固定 **4 分钟**重发一次这个前缀，指定 `maxTokens: 1`，输出不进入会话日志，也不执行工具。部分 Provider/SDK 可能把输出预算提升到自己的最小值，因此不保证实际线上的生成预算严格为 1。保温只是尝试刷新缓存，不能保证供应商缓存命中。

前台模型请求优先；同一会话不会并行发出多个保温请求；每次保温最多等待 90 秒。关闭、Session 销毁或插件卸载时会清理定时器、取消后台请求。插件不会为关闭的会话主动发请求。

**取舍**：状态仅保存在 Host 内存中，不写入配置或会话日志。重新启动、卸载或销毁会话后默认关闭；开启后直到手动关闭或会话销毁都可能持续每 4 分钟调用 Provider，包括会话空闲时，因此会产生实际 API 费用。若在已完成对话后才开启，需要再发送一条真实 Agent 消息才能捕获前缀。本功能不复用旧插件的完整请求重放或复杂配置。


## 缓存保温统计（无 UI）

每次真正发起的保温请求结束后，Host 追加一条 JSONL 记录到：

```text
$DSH_HOME/state/custom-desktop/cache-keepalive.jsonl
```

没有指定 `DSH_HOME` 时，使用 `~/.dsh`；目录和文件会自动创建。每行一个独立 JSON 对象，包含 `version`、`sessionId`、`provider`、`model`、`startedAt`、`endedAt`、`durationMs`、`status`、`failureCode`、`usage` 和 `cacheHitRate`。状态分别为 `completed`、`failed`、`aborted` 或 `timeout`；无论成功或失败都记录。不会保存请求正文、system prompt、工具定义或输出内容。

`usage` 保留 Provider 通过 DSH `usage` chunk 上报的 `inputTokens`（未缓存）、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`。`cacheHitRate = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`，取 **0–1 小数**（例如 `0.6` 代表 60%）。缺失 `cacheWriteTokens` 按 0 参与计算；未上报 `cacheReadTokens`、没有用量或分母为 0 时，命中率为 `null`，不能视为 0%。如果一个流出现多个 usage chunk，使用最后一个，不累加可能重复的快照。

统计数据不随 `/cache off`、Session 销毁或 Host 重启删除；只记录保温请求，不统计普通对话请求。追加写入失败只记录一条 Host 警告，不阻断会话或后续保温。JSONL 会持续增长，目前不做 UI、文件轮换或历史清理。
