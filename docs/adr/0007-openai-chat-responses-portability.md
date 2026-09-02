# ADR 0007: OpenAI Chat Completions and Responses portability

Status: accepted — 2026-09-02

Issue: #580

## Scope and source pin

This is a clean-room, schema-level comparison of the public OpenAI Chat
Completions and Responses request and continuation contracts. It does not
authorize cross-protocol fallback, infer a protocol from a model name, or
adopt hosted response state. The comparison is deliberately separate from
Praxis's current provider-neutral `ModelProvider` contract and from private
Codex OAuth or transport behavior.

The external source is the official
[`openai/openai-openapi` schema at commit `18a43ed13461a01fce5b9cc93c86843c550734a3`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json),
dated 2026-09-01. References below name the exact path or component in that
file. No live API call is evidence for this record.

## Official public schema facts

The pinned schema establishes these public shapes:

- `POST /chat/completions` (`createChatCompletion`) accepts
  `CreateChatCompletionRequest`, whose required top-level fields are `model`
  and `messages`; its successful response is either
  `CreateChatCompletionResponse` or streamed
  `CreateChatCompletionStreamResponse` ([`/chat/completions` `post`,
  `CreateChatCompletionRequest`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json)).
- `POST /responses` accepts `CreateResponse`. Its `input` is `InputParam`,
  which is either text or an array of typed `InputItem` values. The request
  also has separate `instructions`, `reasoning`, `include`, `store`, and
  streaming fields ([`/responses` `post`, `CreateResponse`, `InputParam`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json)).
- Chat messages are the role-discriminated
  `ChatCompletionRequestMessage` union. Assistant tool calls are represented
  by `ChatCompletionRequestAssistantMessage.tool_calls`; tool results are
  `ChatCompletionRequestToolMessage` values with `tool_call_id`. A Chat
  function tool is `ChatCompletionTool`, with a nested `function` object
  ([`ChatCompletionRequestMessage`,
  `ChatCompletionRequestAssistantMessage`,
  `ChatCompletionRequestToolMessage`, `ChatCompletionTool`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json)).
- Responses function tools are flat `FunctionTool` values. A model call is a
  `FunctionToolCall` with `type: function_call`, `call_id`, `name`, and JSON
  string `arguments`; its result is a `FunctionCallOutputItemParam` with
  `type: function_call_output`, a matching `call_id`, and string or typed
  content `output` ([`FunctionTool`, `FunctionToolCall`,
  `FunctionCallOutputItemParam`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json)).
- Responses reasoning is a typed `ReasoningItem` containing a summary and
  optional `encrypted_content`. Its schema description explicitly requires
  reasoning items in subsequent manually managed stateless turns; the
  `CreateResponse.include` description identifies
  `reasoning.encrypted_content` as the encrypted reasoning required for such
  stateless use ([`ReasoningItem`, `CreateResponse.include`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json)).
- Responses streaming has distinct `ResponseCompletedEvent` and
  `ResponseIncompleteEvent` schemas. The former carries a completed
  `Response`; the latter carries an incomplete response and its
  `incomplete_details`. The response representation includes an `id` and
  `previous_response_id` in the event schema examples ([`ResponseCompletedEvent`,
  `ResponseIncompleteEvent`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json)).
- Chat usage is `CompletionUsage`: required `prompt_tokens`,
  `completion_tokens`, and `total_tokens`, with prompt and completion detail
  objects including cache, audio, reasoning, text, image, and prediction
  counters. Responses usage is `ResponseUsage`: required
  `input_tokens`, `output_tokens`, `total_tokens`, input details with cached
  and cache-write tokens, and output details with reasoning tokens
  ([`CompletionUsage`, `ResponseUsage`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json)).

The resulting comparison is:

| Dimension                             | Chat Completions                                                                                                                                                                                                                                                                                                                                                                                            | Responses                                                                                                                                                                                                                                                                                               | Portability consequence                                                                                                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint and top-level shape          | `POST /chat/completions`; `model` plus a required `messages` array; completion or completion-chunk response ([`/chat/completions` `post`, `CreateChatCompletionRequest`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                                                    | `POST /responses`; `CreateResponse` with `input`, separate `instructions`, and response/event objects ([`/responses` `post`, `CreateResponse`, `InputParam`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                            | A plain text request can be structurally rebuilt, but the envelopes and continuation item model are different.                                                                                                                                                                      |
| Instruction placement                 | System/developer instructions are message roles in `ChatCompletionRequestMessage` ([`ChatCompletionRequestMessage`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                                                                                                         | `instructions` is a separate system/developer string; typed input messages may also carry instruction hierarchy ([`CreateResponse.instructions`, `InputMessage`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                        | Concatenation/order policy is adapter-owned; it is not a wire-compatible history copy. Current `ModelMessage`/`ModelRequest` has no distinct provider-neutral developer role, so the captured adapters expose no such control; absence does not prove equivalent provider defaults. |
| Tool definition                       | `ChatCompletionTool` has `type: function` and nested `function` definition ([`ChatCompletionTool`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                                                                                                                          | `FunctionTool` has flat `type`, `name`, `description`, `parameters`, and `strict` fields ([`FunctionTool`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                              | Name, description, and JSON parameter schema are comparable for the narrow function subset; strict/output-schema/deferred-caller features are not generic Praxis fields.                                                                                                            |
| Tool selection and parallel execution | Chat exposes request-level `tool_choice` and `parallel_tool_calls` controls ([`CreateChatCompletionRequest`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                                                                                                                | Responses exposes request-level `tool_choice` and `parallel_tool_calls` controls ([`CreateResponse`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                    | Current `ModelMessage`/`ModelRequest` has neither provider-neutral control, so captured requests contain no adapter controls; absence is unsupported evidence, not proof of equivalent defaults, and fallback must fail closed.                                                     |
| Tool call and result identity         | Assistant `tool_calls` and tool-message `tool_call_id` ([`ChatCompletionRequestAssistantMessage`, `ChatCompletionRequestToolMessage`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                                                                                       | `FunctionToolCall` has `call_id` plus item `id`; output uses matching `call_id` and may contain typed content ([`FunctionToolCall`, `FunctionCallOutputItemParam`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                      | A single local id/name/JSON-arguments call with plain text output is comparable. Item ids, status, namespace, caller, or rich output are not losslessly represented by the current provider-neutral call/result types.                                                              |
| Reasoning continuity                  | The inspected Chat request/assistant message schemas provide `reasoning_effort` at request level but the Chat wire has no matching encrypted reasoning continuation, even though Core retains an opaque signature ([`CreateChatCompletionRequest`, `ChatCompletionRequestAssistantMessage`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json)) | `ReasoningItem` carries summary and encrypted content, and the schema calls for replay in subsequent stateless turns ([`ReasoningItem`, `CreateResponse.include`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                       | Encrypted reasoning cannot cross into Chat losslessly; a fallback must reject it before sending.                                                                                                                                                                                    |
| Terminal representation               | Chat uses completion/chunk response schemas; the pinned operation examples show choice-level `finish_reason` in streamed chunks ([`/chat/completions` `post`, `CreateChatCompletionStreamResponse`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                         | Responses has typed `response.completed` and `response.incomplete` events; incomplete responses carry `incomplete_details` ([`ResponseCompletedEvent`, `ResponseIncompleteEvent`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))       | A normalized terminal reason is only safe where the protocol-specific reason is in the provider-neutral enum; incomplete details must not be silently discarded.                                                                                                                    |
| Usage and cache                       | `CompletionUsage` uses prompt/completion/total names and exposes detailed cache/audio/reasoning/text/image/prediction counters ([`CompletionUsage`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                                                                         | `ResponseUsage` uses input/output/total names and exposes cached/cache-write input details and reasoning output details ([`ResponseUsage`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                              | Basic input/output usage is symmetric in the current adapters. Cached input is represented generically, but Chat does not currently normalize that detail while Responses does; cached usage is not currently cross-protocol lossless.                                              |
| Storage and response identity         | Chat requests include a `store` option in `CreateChatCompletionRequest`; the completion response is a distinct completion object ([`CreateChatCompletionRequest`, `/chat/completions` `post`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                               | `CreateResponse.store` controls API storage, and response/event objects carry response identity and `previous_response_id` ([`CreateResponse.store`, `ResponseCompletedEvent`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))          | Hosted state or response-id continuation is protocol state, not a provider-neutral transcript fact; it cannot be assumed during fallback.                                                                                                                                           |
| Provider capabilities                 | Public schema offers function tools, images/audio modalities, reasoning effort, and several usage/stream options, but model support can vary ([`CreateChatCompletionRequest`, `ChatCompletionTool`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json))                                                                                         | Public schema offers typed input/output items, function tools, reasoning, storage/conversation controls, and additional tool families ([`CreateResponse`, `InputParam`, `FunctionTool`](https://raw.githubusercontent.com/openai/openai-openapi/18a43ed13461a01fce5b9cc93c86843c550734a3/openapi.json)) | Schema availability is not an assertion that a particular model or Praxis adapter supports a field; fallback admission must use declared adapter capabilities.                                                                                                                      |

## Hermetic Praxis observations

These are observations of the current source and tests, not additional OpenAI
guarantees.

The current `ModelMessage`/`ModelRequest` cannot express a distinct developer
role, tool selection/tool choice, or a parallel-tool execution preference. The
captured requests therefore contain no adapter controls for those settings;
their absence is evidence of an unsupported provider-neutral control, not proof
of equivalent provider defaults.

The executed `content_filter` Chat finish reason and Responses incomplete event
are retained as separate terminal evidence under `content-filter-and-incomplete`;
they do not constitute refusal coverage. Refusal identity is not representable
in `ModelStreamEvent` or `ModelTerminalReason`, so the versioned decision marks
`response-refusal-semantics` not comparable. This is explicit unsupported
evidence, not a live-provider or adapter-behavior claim; any future fallback
depending on refusal semantics must fail closed.

- The provider-neutral seam is `ModelMessage`, `ModelRequest`,
  `ModelStreamEvent`, `ModelUsage`, `ModelToolCall`, `ModelTerminalReason`,
  and `ModelProviderCapabilities` in `src/core/runtime.ts:18-193`. It has
  local text, image/document blocks, opaque signed thinking blocks, tool
  calls/results, basic usage/cache fields, and four terminal reasons; it has no
  provider-native response IDs, item IDs, hosted-store state, namespace/caller
  metadata, or rich usage fields. Only the Responses codec serializes a
  thinking block's opaque signature as `encrypted_content` for reasoning
  continuity; the Chat serializer has no corresponding wire continuation and
  its adapter advertises thinking disabled only.
- `OpenAICompatibleProvider` in `src/providers/openai-compatible.ts:279-460`
  serializes all history to `messages`, uses `/chat/completions`, nests
  function schemas, emits assistant `tool_calls`, uses role-`tool` results,
  sends `stream_options.include_usage`, and declares streaming, usage, tools,
  images, and terminal reasons with thinking mode `disabled` only. User/tool
  documents are rejected. The adapter does not carry response IDs or hosted
  continuation state.
- `ResponsesCodec` in `src/providers/responses-codec.ts:129-267` maps system
  messages to `instructions`, maps local history to typed input items, maps
  thinking blocks to `reasoning` items with `encrypted_content`, and maps
  calls/results to local `function_call`/`function_call_output` items. It
  sends `store:false` and `include:['reasoning.encrypted_content']`, and does
  not send `previous_response_id` (`:774-850` exposes this as the public codec
  seam). It rejects user/tool documents, web search, beta features, and
  thinking token budgets.
- `OpenAIResponsesProvider` in `src/providers/openai-responses.ts:119-198`
  uses `/responses`, standard Bearer/JSON/SSE headers, and declares streaming,
  usage, tools, images, terminal reasons, and thinking modes `disabled`,
  `enabled`, and `adaptive`; documents and web search are false.
- The Chat request-capture tests in
  `src/providers/openai-compatible.test.ts:113-205,469-564` prove only the
  hermetic fixture behavior: `/chat/completions`, streamed usage capture,
  nested function serialization, assistant `tool_calls`, role-`tool` results,
  and fragmented argument assembly. They do not prove a live provider's
  behavior.
- The Responses request-capture/parser tests in
  `src/providers/openai-responses.test.ts:67-238` prove only the hermetic
  fixture behavior: complete local history, `store:false`, no
  `previous_response_id`, encrypted reasoning replay, local function-call
  continuity, cached usage, and one normalized terminal event.

## Praxis policy and decision

### Lossless narrow subset

Current Praxis can represent these trajectories in both adapters when the
request stays within both declared capability sets:

1. A plain text user turn followed by a plain text assistant terminal.
2. A plain text user turn followed by one or more ordinary function calls
   whose local identity is just `id`/`call_id`, function name, valid JSON
   arguments, and a plain text tool result, followed by a text terminal.
3. Basic input/output token usage. Cached input has a generic field, but it is
   not currently symmetric: Responses maps cached input while Chat does not
   normalize that detail.

This is structural comparability, not a claim that either endpoint accepts
every model or that a model will produce equivalent prose. The current tests
are the hermetic evidence for the request and continuation mappings described
above.

### Non-lossless or provider-state semantics

The following cannot be treated as portable between the current adapters:

- Responses encrypted reasoning and its required stateless replay; the Chat
  wire has no matching encrypted reasoning continuation even though Core
  retains an opaque signature, and the Chat adapter advertises thinking
  disabled only.
- Hosted response identity, `previous_response_id`, conversation/store
  state, or any requirement to retrieve a provider-owned response. Praxis's
  current Responses path deliberately stores no response and replays local
  history; this does not make hosted state portable.
- Protocol-specific terminal status/detail, including a Responses incomplete
  event's `incomplete_details` or any Chat finish reason outside the generic
  `ModelTerminalReason` set.
- Rich tool metadata/content (Responses item IDs, status, namespace, caller,
  output content arrays; Chat-only message/function fields), images or
  documents whose exact placement changes the trajectory, and tool error
  semantics not represented by the generic call/result contract.
- Usage detail beyond generic input/output fields, including cached-input
  details (Responses maps them while Chat does not), cache-write, audio,
  image, prediction, or reasoning counters when a caller depends on those
  details.
- Provider-specific effort/reasoning settings, web search, beta features, or
  any field not declared and serialized identically by both selected adapters.

### Fail-closed admission boundary for any future fallback

Before a fallback attempt starts, it must reject the combination if any of the
following is present:

- thinking enabled/adaptive, any prior thinking block or encrypted reasoning,
  or a requirement to preserve reasoning continuity;
- a hosted response/conversation identity, `previous_response_id`, stored
  response retrieval, provider-native transcript, or any other state not in
  the local `ModelMessage` history;
- a tool call/result requiring item IDs, status, namespace, caller, rich
  content, non-text output, protocol-specific error markers, or malformed
  arguments whose exact wire representation is significant;
- a terminal status/detail that has no exact `ModelTerminalReason` mapping;
- usage, cache, billing, or budget behavior that depends on fields outside
  `ModelUsage`;
- images, documents, web search, beta features, effort, or other capabilities
  not positively declared by both target adapters with equivalent
  serialization;
- an implicit protocol choice based on model name, endpoint probing, or an
  unverified provider capability.
- a required developer-role instruction, tool selection/tool choice, or
  parallel-tool execution preference, because the current provider-neutral
  request types cannot express these controls. Any future fallback depending
  on them must fail closed and must not infer them from adapter defaults.

These checks are pre-attempt checks. Once output or tool side effects begin,
the route remains sealed; a protocol switch is not permitted.

### Decision on implementation work

The now-accepted executable fixture and primary review conclude that no
automatic cross-protocol fallback implementation issue is justified. The
evidence establishes only a narrow, provider-neutral subset and the
boundaries that make broader fallback unsafe. The executable fixture module
compares representative Chat and Responses request/continuation trajectories,
including negative cases and terminal and usage details, followed by an
acceptance review. This ADR therefore authorizes no production fallback, no
protocol inference, no hosted state, and no expansion of `ModelProvider`, Core,
Transcript, or lifecycle contracts.

## Executable evidence

The accepted observations are bound to the native fixture contract by
`src/providers/openai-protocol-comparison.test.ts`, whose two exact tests
exercise the public injected-fetch adapters and compare their normalized
request, continuation, terminal, usage, capability, and failure behavior to
`test/fixtures/native/providers/openai-chat-responses-v1.json`. The behavior is
registered as `providers.openai.protocol.portability` in
`test/fixtures/manifest.json`. The fixture is a deterministic local capture;
it does not claim live endpoint or model compatibility.

The fixture's automatic-cross-protocol-fallback decision remains
`not_authorized`. Its portable subset is limited to plain text, ordinary
function call/output histories with local identity and plain text output, and
basic input/output usage. Reasoning-enabled or signed-reasoning histories,
protocol-native terminal/refusal/incomplete details, cached or richer usage,
and hosted response state remain fail-closed boundaries.
