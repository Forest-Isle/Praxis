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

Claude Code 2.1.208 仍是已包含及必需的单用户开发者能力在架构、设计和可观察兼容性方面的基线。
只有标记为 `required` 的条目会阻塞开发者核心闭环；`deferred` 条目是可选且按需求实现的。
排除项包括现有企业、认证、托管和客户端界面，以及明确归类为订阅绑定集成、活动、隐藏维护者诊断和构建实验的命令。
Praxis 中相似的界面不能替代对应的 Claude 命令或运行时契约。

## 要求

- macOS 或 Linux
- Node.js 24 或更高版本
- 用于 Grep 工具的 [`ripgrep`](https://github.com/BurntSushi/ripgrep)（`rg`）
- Anthropic 或 OpenAI 兼容提供商的 API 密钥和模型 ID

Praxis 不使用 Claude 订阅认证。Claude Code 互操作性涵盖本地会话、配置、权限、记忆、
技能、钩子、Agent、插件和 MCP 数据。

## 安装

```sh
npm install --global praxis-agent
praxis --version
```

每个 [GitHub 发布](https://github.com/Forest-Isle/Praxis/releases) 都附带发布 tarball、
SBOM、SHA-256 校验和及构建证明。

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
了解提供商设置、共享 Claude 状态、权限、更新和故障排除。
运行 `praxis --help` 获取权威命令界面。

## Praxis 提供什么

- **本地 Agent 运行时** — Claude 风格的响应式 TUI，具备固定全屏视口、不会收缩的输入框/状态区和完整且有边界的欢迎界面；还包括共享命令斜杠面板、带标签页的帮助和快捷键界面、可搜索的会话恢复选择器、恢复活动分支的对话历史、流式及可展开思考、分组多文件读取、可全局展开的工具结果、命令专用 `/add-dir`、代码感知 `/copy`、`/branch`、`/rename`、`/export`、无需提供商的只读共享 `/hooks`、由提供商支持的 `/compact`、原生 `/rewind`、运行时 `/cd`、不写入 transcript 的 `/btw` 旁支问题及后台 Agent 移交、交互式 `/background` 终端移交、统一的 `/status`/`/config`/`/usage` 设置标签页、`/sandbox` 模式/依赖/覆盖/配置控制、本地缓存的 `/release-notes`、兼容 Claude 的 `/statusline` 命令执行和设置 Agent、与源代码对齐的 `/init` 项目指令引导及增强的技能/钩子流程、无需提供商的每会话 `/color` 提示栏样式、`/mcp`、`/memory` 共享指令和自动记忆访问、实时扩展重载控制、
  光标/历史输入框、无需提供商的 `/cost` 用量和价格摘要、交互式 `/doctor` 诊断、每会话模型/effort/权限控制、上下文/状态/技能/任务面板、提示暂存和继续快捷键、可筛选的 `@` 文件和 Agent 引用、输入框撤销、`Ctrl+G` 外部编辑、共享 `/keybindings` 创建/编辑及支持动作重映射、共享内置及兼容 Claude 的自定义 `/theme` 配置并立即进行语义重着色、
  令牌编辑/重置、删除及在 transcript 代码和 diff 视图中持久化语法切换、减少动画的共享运行时偏好、spinner 提示、进度和回合耗时显示、编辑器模式、回顾、通知、自动更新通道、感知 gitignore 的文件引用、可配置的 AskUserQuestion 超时、无需提供商的 `/terminal-setup` 诊断及对受支持本地终端可重复执行的 Shift+Enter 设置、
  `Ctrl+V` 文本/图像剪贴板粘贴、`Ctrl+Z` shell 挂起和 `fg` 恢复、权限控制的 `!` shell 回合、可导航的当前/每回合 Git diff 视图、具备完整 screen-reader 操作提示的语义化计划/问题决策面板和可测量上下文预算；以及 print 模式、结构化 JSON/JSONL、上下文压缩、工具循环和有边界的执行。

- **内置工具** — read、write、edit、glob、search、shell、notebook、PDF、image、web、定时提示、工作流和 worktree。
- **权限边界** — 本地 allow/ask/deny 规则、安全和 bare 模式、可搜索的作用域规则创建/删除、本地/项目/用户设置的原子写入、针对 Bash/PowerShell/文件/notebook/WebFetch/Skill 的工具专用批准对话框、可编辑且可复用的 shell 和 Skill 规则、感知源根的 Claude 文件规则匹配、原子会话权限更新、由有界 Bash AST 支持的复合 shell 规则建议、按源代码形态进行精确/前缀/通配符匹配、包装器和环境规范化、带控制流变量作用域感知的失败关闭 Bash 语义检查、声明和仅字面量算术分析、精确 `cat` heredoc 处理、基于 argv 的命令/重定向路径校验、完整符号链接链检查、危险删除/敏感文件/可疑 Windows 路径门禁、按源顺序的严格 sed 约束、内部自动记忆/会话/任务路径处理、复合 `cd` + Git 保护、按模式顺序处理 `acceptEdits`、外部目录的实时原始/解析路径授权、
  兼容 Claude 的选择性 Bash sandbox（文件系统和网络隔离）、明确的 ask/deny 优先级、仅 sandbox 自动允许、写入允许列表及允许范围内拒绝执行、每命令覆盖和排除、违规报告及 bare repository 控制文件清理、安全属性 Skill 自动允许、交互式工作区目录添加/删除控制、路径限制、凭据脱敏和经过清理的子进程。
- **持久化本地工作** — 可恢复会话、完整历史分叉、文件检查点、任务、前台/后台 subagent、顶层 Agent，以及兼容 Claude 的主线程 Agent 定义，支持原生 prompt、model、tool、memory、first-turn 和 resume 行为。
  Agent 执行采用统一的持久生命周期术语，支持有界取消与排空、继续、通知及单一所有者的孤儿恢复。实验性本地 Team（`PRAXIS_ENABLE_TEAMS=true`）默认不会进入普通启动路径，
  并提供持久任务所有权以及唯一有序 mailbox，支持稳定身份、发送时固化的广播接收者、持久游标、有界保留和有界模型上下文投影。Team 仍是实验性功能，必须显式设置
  `PRAXIS_ENABLE_TEAMS=true` 才会启用；未启用时不会加载、发现或暴露 Team 代码。新 Team 默认使用 Hybrid Lead、sequential 执行和 Lead 持有提交权限，也可选 Coordinator 与 Swarm 策略。
  Swarm 只会接纳相互独立、依赖已就绪且无冲突的任务，并受持久化的 agent 数量、并发、token、时长和 shutdown drain 预算约束。子 agent 权限只能收紧父级权限；并发请求进入带来源信息的单一 FIFO Lead Decision 队列。Coordinator Lead 仅可编排，Team 自定义 agent 不获得 MCP 能力。
- **Claude 兼容生态** — 支持递归 `@` 导入的共享指令、记忆、技能、命令、Agent、钩子、设置、MCP 服务器、插件和 transcript 数据。
- **提供商无关的模型** — 原生 Anthropic Messages 和 OpenAI 兼容的流式适配器，支持明确的能力检查和计量控制。

详细功能状态和可执行证据位于
[兼容性矩阵](https://github.com/Forest-Isle/Praxis/blob/main/docs/PARITY_MATRIX.md)，
而不是本入口 README。

## Claude Code 互操作性

Praxis 默认使用独立的本地数据平面：

```text
Praxis ─── ~/.praxis（或 PRAXIS_HOME）
```

需要使用旧版共享 Claude Code 布局（`~/.claude` 或 `CLAUDE_CONFIG_DIR`）时，请运行
`praxis --data-plane claude`。Praxis 可在该模式下恢复 Claude Code 会话，Claude Code 也可恢复写入其中的兼容会话。
每个类似 semver 的 Claude Code 生产者版本都会经过结构校验；当条目形状受支持时即可读写兼容。
schema 适配器依据 transcript 条目结构选择，而不是依据已安装或固定的生产者版本；格式错误或不受支持的形状会在任何写入前安全失败。
每条 transcript 记录保留其原始生产者版本，因此一个会话可以混合多个版本的受支持形状。
原生分叉创建是单独且受限的无损复制路径，会保留每条现有源记录的生产者版本，因此可以复制经过黑盒验证的特定外部形状，例如观测到的 Claude Code 2.1.233 记录；
不受支持的记录形状和未经验证的版本仍会安全失败并保持只读。
维护者可以通过以下命令证明混合版本 Claude JSONL 互操作性：
`npm run test:cross-version-session-compat`, `test:cross-version-fork-compat`,
`test:cross-version-sidechain-compat`, `test:cross-version-compaction-compat`,
以及 `test:cross-version-resume-at-compat`，覆盖线性恢复、原生分叉、前台旁支、压缩和
`--resume-session-at` 分支投影。
每个命令都要求设置 `PRAXIS_CLAUDE_BINARY`（Claude Code 2.1.208）和
`PRAXIS_CLAUDE_CROSS_VERSION_BINARY`（另一个 Claude Code 版本）。

请参阅
[兼容性契约](https://github.com/Forest-Isle/Praxis/blob/main/docs/COMPATIBILITY.md)，
了解准确的共享数据、版本边界、排除项和验证门禁。

## 文档

| 需求                      | 文档                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------- |
| 安装并运行首次会话        | [入门指南](https://github.com/Forest-Isle/Praxis/blob/main/docs/GETTING_STARTED.md) |
| 常用命令和环境变量        | [CLI 参考](https://github.com/Forest-Isle/Praxis/blob/main/docs/CLI_REFERENCE.md)   |
| 查找全部用户和维护者文档  | [文档索引](https://github.com/Forest-Isle/Praxis/blob/main/docs/README.md)          |
| 了解模块和数据流边界      | [架构](https://github.com/Forest-Isle/Praxis/blob/main/docs/ARCHITECTURE.md)        |
| 查看安全假设              | [威胁模型](https://github.com/Forest-Isle/Praxis/blob/main/docs/THREAT_MODEL.md)    |
| 检查 Claude Code 兼容性   | [兼容性矩阵](https://github.com/Forest-Isle/Praxis/blob/main/docs/PARITY_MATRIX.md) |
| 查看交互式 TUI 设计和证据 | [TUI 兼容性](https://github.com/Forest-Isle/Praxis/blob/main/docs/TUI_PARITY.md)    |
| 构建、测试和贡献          | [贡献指南](https://github.com/Forest-Isle/Praxis/blob/main/CONTRIBUTING.md)         |
| 验证发布和供应链控制      | [发布契约](https://github.com/Forest-Isle/Praxis/blob/main/docs/RELEASE.md)         |

## 项目边界

Praxis 面向一名在多个仓库和会话间工作的本地操作系统用户。
它仅提供 CLI，并感知提供商能力。
组织、租户、RBAC、订阅认证和计费、企业网关、IDE/Desktop/mobile 客户端、Remote Control、
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

`npm run build:native` 会编译当前由 Praxis 拥有的核心、提供商适配器和不含 Claude 兼容适配器的原生数据平面切片。
`npm run check` 还会强制执行对应的源代码依赖方向。

贡献使用 Conventional Commit pull request 标题和受保护的 squash-merge 工作流。
修改兼容性、持久化、发布或安全行为前，请阅读
[CONTRIBUTING.md](https://github.com/Forest-Isle/Praxis/blob/main/CONTRIBUTING.md)。

## 许可证

Praxis 采用 [MIT 许可证](https://github.com/Forest-Isle/Praxis/blob/main/LICENSE)。
Vendored 依赖归属列于
[THIRD_PARTY_NOTICES.md](https://github.com/Forest-Isle/Praxis/blob/main/THIRD_PARTY_NOTICES.md)。
