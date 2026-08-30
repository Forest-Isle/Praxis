# Active-turn steering and follow-up input

Issue: [#514](https://github.com/Forest-Isle/Praxis/issues/514)

## 目标

Praxis 的交互式 TUI 在普通 agent turn 运行期间保持 composer 可编辑，并提供两种明确的输入语义：

- Enter 把文本作为 steering，在当前 turn 的下一个安全 continuation boundary 交给模型。
- Alt+Enter 或 Tab 把文本加入 follow-up 队列，在当前 turn 完成后作为新的 turn 串行执行。

输入不能通过并发 `resume()`、隐式中断或覆盖 transcript 来实现。权限、计划审批、提问、elicitation 和 picker 等 decision surface 继续拥有更高输入优先级。

## 方案选择 & 理由

采用“分离队列 + turn 生命周期边界”：session service 持有 active steering mailbox，交互层持有 follow-up FIFO。

- Steering 必须进入正在运行的 `AgentRuntime`，所以 mailbox 由 session service 注册，并通过 runtime request port 在安全点读取。
- Follow-up 是一个新的用户 turn，需要独立的 turn terminal state、hook lifecycle、用量和成本记录，所以由 TUI 在前一 turn 成功完成后调用下一次 `resume()`；它不在同一个 runtime run 内伪装成 tool follow-up。
- 两种输入只在实际交付时写入 native transcript。队列状态是短暂的本地操作状态，不是 transcript event。

不采用并发 `resume()`，因为它会争用 transcript lease 和 active turn。也不采用提交时 abort，因为那会把 steering 变成 cancellation。

## 架构设计

### Active steering mailbox

新增一个小型、同步的 FIFO mailbox，状态为 `accepting` 或 `sealed`。每个普通 prompt turn 在 session service 进入第一个异步步骤前注册一个 mailbox，并在结束时移除。

Mailbox 提供：

- `enqueue(content)`：仅接受非空文本，并返回带稳定 ID 的 pending item。
- `takeSteering()`：只弹出一个 item。
- `takeCompletionInputOrSeal()`：有 item 时弹出一个；为空时原子地 seal。
- `withdraw(id)`：仅移除尚未交付的 item。
- `close()`：返回所有未交付 item，供失败或取消路径显式拒绝。

Session service 暴露有判别结果的 `steer` 和 `withdrawSteering` 命令。结果至少区分 `accepted`、`no-active-turn`、`not-steerable`、`turn-completing` 和 `not-pending`；调用方不得把拒绝当成功。

Shell turn 不注册 steering mailbox。重复 active turn 注册必须失败，不能替换既有 mailbox。

### Runtime safe boundaries

`AgentRunRequest` 接收一个可选 steering input port。Runtime 每次最多交付一个 item：

1. Provider 返回无 tool calls 时，在运行 stop hook 前尝试一次 steering。
2. Stop hook 有 await，因此 stop hook 返回且没有内部 continuation 时，再以 completion 操作检查 steering；为空则 seal 并允许完成。
3. Provider 返回 tool calls 时，等待整批 tools settle、持久化 tool results 和内部 tool/hook follow-up，再尝试一次 steering，然后继续模型循环。

交付顺序为：observer 追加 native user message成功 → runtime messages 可见 → 发出 `user-input-delivered` presentation event。持久化失败会失败当前 turn，不能只在内存中继续。

现有 `followUpUserMessages` 保持 tool/hook 内部上下文语义，不复用为用户队列。

### Follow-up turn pump

交互层维护独立 FIFO。Tab 或 busy 状态下的 Alt+Enter 清空 composer 并入队；当前 turn 成功完成后，turn pump 弹出一个 item，把它作为普通 prompt 启动新的 `resume()`。后续 item 继续逐个执行，直到队列为空才退出 busy 状态并发送 terminal completion notification。

Follow-up 在 pump 弹出并开始新 turn 时才显示为已交付的 user message并写 transcript。当前 turn 失败或取消时，尚未开始的 follow-up 保留为 pending，最新一项可撤回 composer 编辑。

### TUI routing and presentation

- Busy policy只特殊处理 cancel、background 和 transcript toggle；普通 composer edit 继续走现有纯 router。
- Busy Enter 提交 steering；busy Tab 或 Alt+Enter 排队 follow-up；Shift+Enter 仍插入换行。
- Decision surface 的 layer routing 位于 busy input 之前，因此它们的反馈不会误入 steering。
- Busy 且 composer 为空时，history-previous/Up 撤回最近入队且仍 pending 的 item，并放回 composer。若该 item 已交付，显示明确 race 提示。
- Quiet frame 在 active output 与 composer 之间显示有稳定 key 的 pending rows，区分 `steer` 和 `follow-up`；窄屏裁剪和 viewport 预算沿用现有 frame 规则。
- `/btw` 不进入任何一个队列。

## 数据流

Steering：keystroke → TUI `steer` command → session mailbox → runtime safe boundary → session observer append native user message → provider next request → delivered event removes pending row。

Follow-up：keystroke → TUI FIFO → current turn success → turn pump dequeue → ordinary `resume()` → native prompt append → provider request。

Withdraw：Up on empty busy composer → newest local pending item → mailbox withdraw（steering）或 local dequeue（follow-up）→ composer restore。

## 错误处理

- Empty text is ignored before enqueue.
- A completion race keeps/restores composer text and renders a warning.
- A withdrawal race leaves delivered history unchanged and renders a warning.
- Cancellation/failure emits rejection events for undelivered steering; text remains visible to the user.
- A service without active-turn commands reports the feature as unavailable instead of falling back to concurrent `resume()`.
- Closing the interactive service rejects pending steering before resources are disposed.

## 测试策略

- Mailbox unit tests: FIFO, one-at-a-time drain, seal/enqueue race, withdraw, close.
- Runtime tests: no-tool boundary, post-tool-batch boundary, stop-hook await race, one-per-boundary ordering, observer-before-provider visibility.
- Session service tests: active registration timing, native transcript append only on delivery, shell/non-active rejection, cancellation rejection, mailbox cleanup.
- Router tests: busy editing, cancellation priority, decision-layer priority, delegated submit/follow-up actions.
- Interactive Ink tests: Enter steering, Tab and Alt+Enter follow-up, FIFO turn pump, pending rows, Up-to-edit, failure preservation, `/btw` independence.
- Quiet-frame tests: semantic pending labels, stable keys, clipping and bounded viewport.
- Acceptance batch: focused Vitest files, formatter, lint, typecheck, build, `npm run check`, `npm run test:tui:pty`, `npm run test:package`, `npm run test:performance`, and `npm audit --omit=dev`.
