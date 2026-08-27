# Praxis TUI Hybrid Redesign Spec

## 目标

将 Praxis 交互 TUI 改造成高性能、简洁美观、稳定易用的本地 Agent 工作台，
同时保持现有命令、快捷键、权限语义、screen-reader 输出、Claude 兼容行为和
native append-only JSONL transcript 不变。

非目标：加入账户、组织、RBAC、远程控制、IDE/Desktop surface、遥测控制面，
或把 Claude Code 源码引入实现。

## 方案选择与理由

采用 Hybrid 双渲染器，按 A → B 渐进迁移：

- 共享无框架 TuiKernel、语义 ScreenModel、Row IR 和布局引擎。
- Ink renderer 继续负责 classic、screen-reader、测试和能力不足时的 fallback。
- ANSI fullscreen renderer 负责交互 TTY 的高性能 cell/row diff 绘制。

理由：仅拆分 Ink 可降低风险但保留大范围 reconciliation；全量重写会破坏
现有兼容性和可访问性。Hybrid 可以先验证行为不变，再按性能证据替换 fullscreen。

## 架构设计

```text
RuntimeEvent / KeyInput
          ↓
       TuiStore
  reducer + effect runner + focus stack + lifecycle
          ↓
   Semantic ScreenModel
          ↓
     Layout / Row IR
          ↓
 Ink classic/sr  │  ANSI fullscreen
```

### TuiKernel

`TuiKernel` 位于 `src/cli/tui/kernel/`，不依赖 React 或 Ink。状态域：

- `session`：会话身份、resume/fork、cwd、模型和 effort。
- `transcript`：原始 `TranscriptItem[]`、增量 revision、可见窗口。
- `composer`：文本、cursor、shell/vim 模式、clipboard image marker。
- `overlays`：palette、picker、permission、question、plan、MCP、dashboard。
- `runtime`：busy、streaming、usage、cost、theme、renderer 能力。
- `viewport`：columns、rows、scroll offset、resize revision。
- `notifications`：错误、提示、外部编辑器和终端通知。

Reducer 只做同步、纯状态转换。service、文件、剪贴板、外部编辑器、MCP、
通知和 renderer 生命周期全部由可取消的 effect runner 执行，并带有 generation
token，过期结果不得提交。

### Row IR 与布局

布局引擎是唯一的换行和裁剪实现，取代“估算一套、渲染一套”的重复逻辑：

```ts
type TuiRow = {
  key: string
  segments: readonly { text: string; role: TuiTextRole }[]
  height: number
  source?: string
}
```

Row IR 负责 grapheme 宽度、Markdown/diff/tool output、截断标记、responsive
断点和 viewport slice。Row key 必须由源 transcript identity 或明确的临时事件
identity 派生，resize 和 append 不得导致无意义的 key 变化。

现有 `transcript-window-model.ts` 的持久化树、`transcript-viewport.ts` 的
Unicode 宽度能力和 `streaming-frame-buffer.ts` 的 33 ms 合并策略继续复用，
但输出统一转换为 Row IR。

### 视觉系统

- Logo/glyph：采用原创的「P-loop + spark」标识。几何环形表达抽象 `P` 和执行
  路径，下方斜带表达推进，四角火花表达智能响应。默认使用黑白单色；彩色
  主题使用 indigo/cyan；ANSI16、ASCII 和 no-color 使用稳定的简化 glyph。
  PNG 只用于文档/应用图标预览，TUI 不依赖位图。
- 语义 token：`body`、`heading`、`accent`、`muted`、`success`、`warning`、
  `error`、`tool`、`selection`、`input`、`diffAdded`、`diffRemoved`。
- primitive token：颜色、间距、边框、glyph、圆角和动画级别。
- 默认黑白/灰阶加单一品牌强调色；所有颜色满足高对比度目标，禁止组件内硬编码。
- Unicode glyph 必须有 ANSI16、ASCII 和 no-color fallback。
- transcript 默认无边框；dialog、危险操作、选择器才使用边框。
- 顶部显示 session/cwd/model/effort/status；底部显示 composer 和少量状态 chip。

响应式断点：≥100 列完整信息，80–99 常规布局，60–79 隐藏次要提示，
40–59 单列压缩，<40 只保留核心输入/状态语义。

### 输入与焦点

统一 `Action` 枚举和 `FocusStack`：`composer → overlay → dialog`。

- `Esc`：关闭当前焦点层；连续退出行为保持现有语义。
- `Enter`：提交或确认当前选择。
- `Tab`：在字段、操作和补充输入之间切换。
- `/`：命令 palette；`@`：文件/agent picker；`!`：shell mode。
- 现有 keybindings 文件、动作名和快捷键保持兼容；新增快捷键只能作为别名。

## 数据流

1. `RuntimeEvent` 进入 kernel reducer，streaming delta 先进入 frame buffer。
2. reducer 生成新的语义状态和 dirty region，不直接创建 ReactElement 或 ANSI 字符串。
3. selector 按区域读取状态，布局引擎生成受宽度、模式和 viewport 约束的 Row IR。
4. renderer 仅绘制可见 rows：Ink 使用现有测试适配器，ANSI 只提交 dirty rows/cells。
5. 所有 transcript 写入仍由 application/persistence 负责；TUI 只保留显示 projection。

## 错误处理与生命周期

- kernel 生命周期为 `mount → active → suspending → closing → closed`，每个退出路径
  exactly-once 恢复 raw mode、cursor、alternate screen 和 resize listener。
- effect 统一使用 `AbortSignal`；卸载、换 session、换 cwd、换 provider 或 renderer
  时取消旧 effect，旧 generation 的结果丢弃。
- ANSI renderer 初始化失败、终端能力不足或绘制异常时回退 Ink classic，并保留
  当前内存状态；不得修改 transcript。
- 布局异常只影响当前 surface，显示可读的 warning；权限拒绝、服务错误和持久化
  错误沿现有语义进入 transcript/通知路径。
- screen-reader 和 no-color 路径不依赖颜色、动画、边框或光标位置表达语义。

## 性能预算

- 输入回显 p95 < 50 ms。
- ANSI fullscreen 普通帧 p95 < 16.7 ms；低能力终端至少 < 33 ms。
- 120k transcript 冷投影 < 100 ms，单条 append < 5 ms。
- streaming 不丢字、不重复、不倒序；resize 在 100 ms 内稳定。
- 可见行之外不得创建视觉组件；Row/Markdown/Syntax cache 使用有上限的 LRU。

## 测试策略

- 纯函数：reducer、selector、layout、Row IR、focus transition、theme token。
- Ink fixtures：宽度 40/60/80/100/120、菜单栈、权限、错误、screen-reader。
- PTY：alternate screen、raw mode、cursor、SIGTSTP/SIGCONT、resize、ANSI diff。
- 性能：projection scaling、append、streaming frame、dirty-row 输出字节数。
- 兼容：现有 TUI/interactive 测试、Claude 2.1.208 黑盒基线、native transcript
  字节不变性和 keybindings 行为。

## 验收门槛

必须通过：

```sh
npm run build
npm test
npm run test:tui:pty
npm run test:performance
npm run check
```

并完成真实终端人工检查：首次启动、长 transcript、连续工具调用、权限等待、
MCP elicitation、resume/fork、窄终端、无色模式、screen-reader、挂起恢复和
renderer fallback。
