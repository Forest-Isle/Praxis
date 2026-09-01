# Praxis

[English](README.md) | [简体中文](README_zh.md)

[![CI](https://github.com/Forest-Isle/Praxis/actions/workflows/ci.yml/badge.svg)](https://github.com/Forest-Isle/Praxis/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Forest-Isle/Praxis/actions/workflows/codeql.yml/badge.svg)](https://github.com/Forest-Isle/Praxis/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Forest-Isle/Praxis/badge)](https://scorecard.dev/viewer/?uri=github.com/Forest-Isle/Praxis)
[![npm](https://img.shields.io/npm/v/praxis-agent)](https://www.npmjs.com/package/praxis-agent)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/praxis-agent)
[![license](https://img.shields.io/github/license/Forest-Isle/Praxis)](https://github.com/Forest-Isle/Praxis/blob/main/LICENSE)

Praxis 是一个本地优先、面向单用户的命令行通用 Agent。

它提供交互式或无头 Agent 循环、本地工具、权限、会话、技能、钩子、MCP、
插件、后台 Agent，以及与提供商无关的 Anthropic/OpenAI 兼容模型访问。
Praxis 明确不包含账户、组织、计费、托管企业策略、远程控制、IDE 界面和遥测控制平面。

Claude Code 2.1.208 仅作为开发者 CLI 界面的 clean-room 行为参考，不是运行时依赖或数据源。
Praxis 只使用一个 native 数据平面，不读取或写入 Claude Code 会话、配置或兼容目录。

## 要求

- macOS 或 Linux
- Node.js 24 或更高版本
- 用于 Grep 工具的 [`ripgrep`](https://github.com/BurntSushi/ripgrep)（`rg`）
- Anthropic 或 OpenAI 兼容提供商的 API 密钥和模型 ID（稳定路径），或显式启用的
  实验性 ChatGPT-backed Codex 订阅集成

Praxis 不使用 Claude 订阅认证。Claude-shaped 消息、工具和 CLI 协议形状在公开界面需要时仍受支持，
但所有持久化状态都使用 Praxis native 格式。

Team 操作仅在本地显式启用。无法无损表示或不支持的 Team 负载会被拒绝，不会静默简化。

## 安装

```sh
npm install --global praxis-agent
praxis --version
```

每个 [GitHub 发布](https://github.com/Forest-Isle/Praxis/releases) 都附带发布 tarball、
SBOM、SHA-256 校验和及构建证明。
请使用 `praxis update` 执行事务式自更新；验证和恢复细节请参阅[入门指南](https://github.com/Forest-Isle/Praxis/blob/main/docs/GETTING_STARTED.md)。

## 快速开始

OpenAI 或 OpenAI 兼容端点是默认提供商：

```sh
export PRAXIS_API_KEY="your-api-key"
export PRAXIS_MODEL="your-model-id"
# 兼容网关的可选配置：
# export PRAXIS_BASE_URL="https://api.example.com/v1"

cd /path/to/project
praxis
```

对于 Anthropic Messages：

```sh
export PRAXIS_PROVIDER="anthropic"
export PRAXIS_API_KEY="your-api-key"
export PRAXIS_MODEL="claude-sonnet-4-20250514"

cd /path/to/project
praxis
```

Praxis 还提供实验性的 `openai-codex` 提供商，用于 ChatGPT-backed Codex 订阅。
它与 OpenAI API 密钥访问相互独立，需要设置
`experimental.codexSubscription: true`，OAuth 凭据存放在 native Vault 中。
从 `praxis auth login openai-codex` 开始；浏览器/设备流程及限制见[入门指南](docs/GETTING_STARTED.md)。
该功能依赖 OpenAI 未正式记录为稳定的第三方订阅/后端契约，可能发生变化；它不是 Claude 订阅认证。
订阅运行会保留 token 用量，但不提供 API 美元成本，也无法执行美元预算。

常见的非交互操作：

```sh
praxis -p "检查此项目"
praxis -p --output-format json "总结测试失败情况"
praxis --resume
praxis sessions --json
praxis doctor
```

请参阅
[入门指南](https://github.com/Forest-Isle/Praxis/blob/main/docs/GETTING_STARTED.md)
了解提供商设置、共享 Praxis 状态、权限、更新和故障排除。
运行 `praxis --help` 获取权威命令界面。

## Praxis 提供什么

- **结果驱动的评估** — `praxis eval <target>` 会在隔离工作区中运行受控用例，要求显式授权验证器，并在本地写入带版本的产物；用量和成本会明确标记为可用或未知。可用 `praxis eval compare` 比较两次独立运行；未知令牌/成本证据会产生 `null` 差值，门禁要求通过率和安全率均不回退，并在安全证据不完整时失败关闭。
- **本地 Agent 运行时** — C+ Quiet Operator 响应式 TUI，采用线性的
  `❯` 用户 / `⏺` 助手对话、`✻` 思考活动和 `!` Shell 输入语法，以及紧凑稳定的工具行、自适应密度、终端原生背景和精简的输入框/状态行。
  交互界面在不同终端中保持一致，并提供英文权限和配置选择文案，以及明确的 `❯` / Up/Down / Enter / Esc 交互语法。普通 turn 运行期间输入框仍可编辑：Enter 会在下一个安全 continuation boundary steering 当前 turn，Tab 或 Alt+Enter 会排队一个串行 follow-up turn，pending 输入会持续显示，并可用 Up 撤回编辑。界面还包括共享命令斜杠面板、带标签页的帮助和快捷键界面、可搜索的会话恢复选择器、恢复活动分支的对话历史、流式及可展开思考、分组多文件读取、可全局展开的工具结果、命令专用 `/add-dir`、代码感知 `/copy`、`/branch`、`/rename`、`/export`、无需提供商的只读共享 `/hooks`、由提供商支持的 `/compact`、原生 `/rewind`、运行时 `/cd`、不写入 transcript 的 `/btw` 旁支问题及后台 Agent 移交、交互式 `/background` 终端移交、统一的 `/status`/`/config`/`/usage` 设置标签页、`/sandbox` 模式/依赖/覆盖/配置控制、本地缓存的 `/release-notes`、兼容 Claude 的 `/statusline` 命令执行和设置 Agent、与源代码对齐的 `/init` 项目指令引导及增强的技能/钩子流程、无需提供商的每会话 `/color` 提示栏样式、`/mcp`、`/memory` 共享指令和自动记忆访问、实时扩展重载控制、
  并支持终端渲染失败时自动回退、screen-reader 以及无色输出；同时提供 hermetic PTY smoke，覆盖真实 `runInteractive` 的 ANSI 入口、可调整尺寸生命周期、Ctrl-C 恢复、fullscreen `Ctrl+L` 重绘，以及支持边缘自动滚动和 OSC 52 复制的鼠标滚轮/拖拽选择；光标/历史输入框、无需提供商的 `/cost` 用量和价格摘要、交互式 `/doctor` 诊断、每会话模型/effort/权限控制、上下文/状态/技能/任务面板、提示暂存和继续快捷键、可筛选的 `@` 文件和 Agent 引用、输入框撤销、`Ctrl+G` 外部编辑、共享 `/keybindings` 创建/编辑及支持动作重映射、共享内置及兼容 Claude 的自定义 `/theme` 配置并立即进行语义重着色、
  令牌编辑/重置、删除及在 transcript 代码和 diff 视图中持久化语法切换、减少动画的共享运行时偏好、spinner 提示、进度和回合耗时显示、编辑器模式、回顾、通知、自动更新通道、感知 gitignore 的文件引用、可配置的 AskUserQuestion 超时、无需提供商的 `/terminal-setup` 诊断及对受支持本地终端可重复执行的 Shift+Enter 设置、
  `Ctrl+V` 文本/图像剪贴板粘贴、`Ctrl+Z` shell 挂起和 `fg` 恢复、无需 provider 请求且会为后续普通 prompt 持久化 shell 输入/输出、不创建 assistant 回合的权限控制 `!` shell 回合、可导航的当前/每回合 Git diff 视图、具备完整 screen-reader 操作提示的语义化计划/问题决策面板、所有可选择界面的语义化 screen projection、URL/表单 elicitation 的确定性自适应终端尺寸渲染和可测量上下文预算；以及 print 模式、结构化 JSON/JSONL、上下文压缩、工具循环和有边界的执行。

- **内置工具** — read、write、edit、glob、search、shell、notebook、PDF、image、web、定时提示、工作流和 worktree。
- **Shell 生命周期** — 前台 Bash 最长可运行 10 分钟，并在同一会话的后续调用中沿用经过校验的最终工作目录；该状态不会跨会话泄漏，也不会覆盖显式 `/cd`。
- **权限边界** — 本地 allow/ask/deny 规则、安全和 bare 模式、可搜索的作用域规则创建/删除、本地/项目/用户设置的原子写入、针对 Bash/PowerShell/文件/notebook/WebFetch/Skill 的工具专用批准对话框、可编辑且可复用的 shell 和 Skill 规则、感知源根的 Claude 文件规则匹配、原子会话权限更新、由有界 Bash AST 支持的复合 shell 规则建议、按源代码形态进行精确/前缀/通配符匹配、包装器和环境规范化、带控制流变量作用域感知的失败关闭 Bash 语义检查、声明和仅字面量算术分析、精确 `cat` heredoc 处理、基于 argv 的命令/重定向路径校验、完整符号链接链检查、危险删除/敏感文件/可疑 Windows 路径门禁、按源顺序的严格 sed 约束、内部自动记忆/会话/任务路径处理、复合 `cd` + Git 保护、按模式顺序处理 `acceptEdits`、外部目录的实时原始/解析路径授权、
  兼容 Claude 的选择性 Bash sandbox（文件系统和网络隔离）、明确的 ask/deny 优先级、仅 sandbox 自动允许、写入允许列表及允许范围内拒绝执行、每命令覆盖和排除、违规报告及 bare repository 控制文件清理、安全属性 Skill 自动允许、交互式工作区目录添加/删除控制、路径限制、凭据脱敏、经过清理的子进程，以及精确指纹 workspace trust：在用户接受 canonical workspace 配置前，自动发现的 project/local provider/profile/model 选择、hooks 和 MCP 都会被阻止。
- **持久化本地工作** — 可恢复会话、完整历史分叉、文件检查点、任务、前台/后台 subagent、顶层 Agent，以及兼容 Claude 的主线程 Agent 定义，支持原生 prompt、model、tool、memory、first-turn 和 resume 行为。
  Agent 执行采用统一的持久生命周期术语，支持有界取消与排空、继续、通知及单一所有者的孤儿恢复。实验性本地 Team（`PRAXIS_ENABLE_TEAMS=true`）默认不会进入普通启动路径，
  并提供持久任务所有权以及唯一有序 mailbox，支持稳定身份、发送时固化的广播接收者、持久游标、有界保留和有界模型上下文投影。Team 仍是实验性功能，必须显式设置
  `PRAXIS_ENABLE_TEAMS=true` 才会启用；未启用时不会加载、发现或暴露 Team 代码。新 Team 默认使用 Hybrid Lead、sequential 执行和 Lead 持有提交权限，也可选 Coordinator 与 Swarm 策略。
  Swarm 只会接纳相互独立、依赖已就绪且无冲突的任务，并受持久化的 agent 数量、并发、token、时长和 shutdown drain 预算约束。子 agent 权限只能收紧父级权限；并发请求进入带来源信息的单一 FIFO Lead Decision 队列。Coordinator Lead 仅可编排，Team 自定义 agent 不获得 MCP 能力。
  原生 CLI 还提供 `praxis team status`、`logs` 和 `attach`，支持人类可读及 JSON 输出；durable-local attach 不要求 tmux。原生 task、notification、context 和 Team resume/inbox seam 已实现，并对不支持的负载执行 fail-closed 校验；这些状态以 Native Fixture Contracts 及 manifest 中的可执行证据为准。
- **原生资源生态** — 支持递归 `@` 导入的共享 Praxis 指令、记忆、技能、命令、Agent、钩子、设置、MCP 服务器、插件，以及位于 `~/.praxis` 下的 append-only `praxis.transcript` JSONL 会话；MCP 连接、发现和工具操作均有明确时限，断开后可安全恢复，且绝不重放已派发的调用。默认工具选择会把 `mcp__*` schema 延迟到 turn-scoped `ToolSearch` 后加载；每次查询最多为下一次模型请求激活 8 个确定性匹配，发布的 MCP 工具描述最多保留 2,048 个 Unicode 码点。超过 100,000 UTF-8 字节的纯文本 MCP 结果会先脱敏，再写入会话级 `tool-results` 目录下权限为 `0600` 的 `.txt` 文件；提供商和 transcript 只接收包含绝对文件路径的有界提示。未超过限制的结果仍内联，结构化、混合媒体和二进制资源处理保持不变。声明 `readOnlyHint: true` 的 MCP 工具会通过提供商无关的权限元数据默认放行；显式 PreToolUse 及权限 ask/deny 决策仍具有更高优先级，缺失或为 false 的 hint 保持现有默认行为。这是 Praxis 自身的权限契约，并不表示已经验证 Claude Code 2.1.208 parity。显式具体工具 `--tools` 选择会直接加载选中的工具，而 `--disallowedTools ToolSearch` 会恢复完整工具列表。 每次组装上下文时，Git 状态都会从调用方解析出的 cwd 刷新，而环境与记忆在生命周期内保持稳定；采集使用 `--no-optional-locks`，仓库或 status 出错时 fail-closed 并省略 Git 上下文，最终渲染结果限制为 2,048 个 UTF-8 字节。
- **提供商无关的模型** — 原生 Provider Registry/Vault 路由、API 适配器、实验性的 Codex OAuth 适配器、明确的能力检查、每次尝试独立的 connect、字节级 idle 与 absolute-total timeout、对 malformed 流式工具参数进行 typed recovery（不执行工具且不丢失会话恢复能力）、默认启用一次有界的 Anthropic 非流式重放以恢复符合条件的 stream/idle 故障且不暴露失败尝试的输出，以及订阅运行仅保留 token 用量且不提供 API 美元成本的计量。
- **事务式自更新** — `praxis update` 会在安装前验证软件包，拒绝并发更新，并可在中断或崩溃后回滚。

当前 qualification 状态和可执行证据位于
[Native Fixture Contracts](https://github.com/Forest-Isle/Praxis/blob/main/docs/NATIVE_FIXTURE_CONTRACTS.md)
及其机器可读的
[fixture manifest](https://github.com/Forest-Isle/Praxis/blob/main/test/fixtures/manifest.json)。
[兼容性矩阵](https://github.com/Forest-Isle/Praxis/blob/main/docs/PARITY_MATRIX.md)
和[路线图](https://github.com/Forest-Isle/Praxis/blob/main/docs/ROADMAP.md)是历史性的
clean-room 记录。

## Native 数据平面

Praxis 默认使用独立的本地 native 数据平面：

```text
Praxis ─── ~/.praxis（或 PRAXIS_HOME）
```

所有会话、记忆、任务、定时任务、资源和私有状态都位于 `~/.praxis`（或 `PRAXIS_HOME`）下。
权威 transcript 使用 append-only `praxis.transcript` v1 JSONL；旧 Claude transcript、索引、sidechain
和迁移/恢复路径已删除。`CLAUDE_CONFIG_DIR` 不参与 native 运行，旧目录不会被读取或写入。
Claude-shaped 消息和工具字段只描述协议形状，不改变 Praxis 的数据归属。

## 文档

| 需求                      | 文档                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 安装并运行首次会话        | [入门指南](https://github.com/Forest-Isle/Praxis/blob/main/docs/GETTING_STARTED.md)                          |
| 常用命令和环境变量        | [CLI 参考](https://github.com/Forest-Isle/Praxis/blob/main/docs/CLI_REFERENCE.md)                            |
| 查找全部用户和维护者文档  | [文档索引](https://github.com/Forest-Isle/Praxis/blob/main/docs/README.md)                                   |
| 了解模块和数据流边界      | [架构](https://github.com/Forest-Isle/Praxis/blob/main/docs/ARCHITECTURE.md)                                 |
| 查看安全假设              | [威胁模型](https://github.com/Forest-Isle/Praxis/blob/main/docs/THREAT_MODEL.md)                             |
| 验证原生行为和可执行证据  | [Native Fixture Contracts](https://github.com/Forest-Isle/Praxis/blob/main/docs/NATIVE_FIXTURE_CONTRACTS.md) |
| 查看交互式 TUI 设计和证据 | [Quiet Operator 规格](https://github.com/Forest-Isle/Praxis/blob/main/docs/TUI_REDESIGN_SPEC.md)             |
| 构建、测试和贡献          | [贡献指南](https://github.com/Forest-Isle/Praxis/blob/main/CONTRIBUTING.md)                                  |
| 验证发布和供应链控制      | [发布契约](https://github.com/Forest-Isle/Praxis/blob/main/docs/RELEASE.md)                                  |

## 项目边界

Praxis 面向一名在多个仓库和会话间工作的本地操作系统用户。
它仅提供 CLI，并感知提供商能力。
组织、租户、RBAC、计费、企业网关、IDE/Desktop/mobile 客户端、Remote Control、
Claude Desktop 导入以及托管评审产品界面均是永久的非目标。

## 安全与支持

请通过
[GitHub 私密漏洞报告](https://github.com/Forest-Isle/Praxis/security/advisories/new)
报告漏洞，不要创建公开 issue。
响应预期请参阅[SECURITY.md](https://github.com/Forest-Isle/Praxis/blob/main/SECURITY.md)。

请在 [GitHub Discussions](https://github.com/Forest-Isle/Praxis/discussions) 中提出问题和使用帮助；
对于可复现缺陷或范围明确的功能请求，请使用 issue。
请参阅[SUPPORT.md](https://github.com/Forest-Isle/Praxis/blob/main/SUPPORT.md)。

## 开发

```sh
git clone git@github.com:Forest-Isle/Praxis.git
cd Praxis
npm ci
npm run check
```

`npm run build:native` 会编译 Praxis 核心、提供商适配器和 native transcript/session 数据平面；
`npm run test:native:deletion` 会验证产物不含已删除的 Claude compatibility 模块，并执行 native 会话 smoke gate。
`npm run test:performance` 强制检查 TUI projection scaling、<=3.25 的 doubling ratio、绝对的 120k median <1000 ms 预算、确定性的注入式回归保护，以及 Quiet Operator 输入回显 <50 ms 和普通/低能力全帧 p95 <16.7/<33 ms 预算。
`npm run check` 还会强制执行对应的源代码依赖方向。
`npm run test:coverage` 使用 V8 覆盖 `src/**` 下的全部生产代码，并强制执行全局最低标准：
语句 79%、分支 70%、函数 85%、行 81%；同时拒绝存在语句但完全未覆盖的生产运行时模块（仅类型模块可以为零语句）。
`npm run test:fixtures` 会执行包含 70 条行为的 native contract，其中 62 条为 qualified、8 条明确 excluded。
`npm run verify:fixture-contracts` 执行结构校验，并包含在 `npm run check` 中。
`npm run test:core-completion` 保留为兼容别名，实际执行 `npm run test:fixtures`。

贡献使用 Conventional Commit pull request 标题和受保护的 squash-merge 工作流。
修改兼容性、持久化、发布或安全行为前，请阅读
[CONTRIBUTING.md](https://github.com/Forest-Isle/Praxis/blob/main/CONTRIBUTING.md)。

## 许可证

Praxis 采用 [MIT 许可证](https://github.com/Forest-Isle/Praxis/blob/main/LICENSE)。
Vendored 依赖归属列于
[THIRD_PARTY_NOTICES.md](https://github.com/Forest-Isle/Praxis/blob/main/THIRD_PARTY_NOTICES.md)。
