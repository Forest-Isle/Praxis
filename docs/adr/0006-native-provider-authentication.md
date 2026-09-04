# ADR 0006: Native provider authentication and routing

Status: accepted — 2026-08-28

Issue: #477

## Goal

Praxis supports multiple model providers and ChatGPT-backed Codex sessions
without depending on a third-party model SDK. The Praxis Core Contract remains
the only model-facing contract used by the Agent loop.

## Decision

Provider configuration, secret persistence, credential resolution, and wire
protocols are separate Modules with small Interfaces. Provider-specific
behavior is capability-gated and stays inside protocol Adapters.

Praxis keeps the existing `ModelRequest`, `ModelStreamEvent`,
`ModelProviderError`, retry/fallback, tool lifecycle, usage metering, and
Transcript behavior. No provider wire type enters those contracts.

The implementation does not read Claude settings or credentials and does not
depend on pi-ai.

## Configuration contract

User configuration lives in `PRAXIS_HOME/settings.json`. Plaintext secrets are
not accepted in provider definitions.

```json
{
  "provider": "deepseek",
  "providerProfile": "default",
  "model": "deepseek-chat",
  "providers": {
    "deepseek": {
      "protocol": "openai-compatible",
      "profiles": {
        "default": {
          "baseUrl": "https://api.deepseek.com/v1",
          "credential": {
            "source": "env",
            "name": "DEEPSEEK_API_KEY"
          }
        }
      }
    }
  },
  "experimental": {
    "codexSubscription": true
  }
}
```

Built-in provider IDs are `openai`, `openai-responses`, `anthropic`, and
`openai-codex`. Custom providers use `openai-compatible`, `openai-responses`,
or `anthropic-messages`. A selected target is the tuple `providerId`,
`profileId`, and `modelId`.

Selection precedence is explicit CLI input, `PRAXIS_PROVIDER`,
`PRAXIS_PROVIDER_PROFILE`, `PRAXIS_MODEL`, trusted local defaults, trusted
project defaults, user defaults, then existing native defaults. `PRAXIS_BASE_URL` remains an explicit
legacy endpoint override except for `openai-codex`.

Project and local settings may select provider, profile, and model only after
the current workspace-controlled configuration receives an exact canonical
fingerprint trust assessment (see [ADR 0005](0005-workspace-executable-trust.md)).
The provider/profile must resolve to a built-in or user-defined global profile;
project settings cannot define endpoints, credential sources, or command
helpers. Background consumers preserve provider, profile, model, base URL, and
per-attempt deadline controls. Detached API-key workers receive only the
parent-resolved credential normalized as `PRAXIS_API_KEY`; arbitrary configured
credential-variable names and unrelated ambient secrets are not inherited.
Codex workers reopen the same Vault, and the explicit credential-store backend
selection is preserved across the process boundary.

## Credential contract

A credential is keyed by provider ID and profile ID and is one of:

- API key: secret, revision, and update time.
- OAuth: access token, refresh token, expiry, optional account ID, revision,
  and update time.

The preferred macOS implementation is Keychain. The fallback is
`PRAXIS_HOME/.provider-credentials.json`, written atomically with mode `0600`;
the Praxis home directory is mode `0700`. Read-only access rejects an unsafe
root; mutation tightens an owned legacy root to `0700` before reading any
credential state. The vault also rejects symlinks, wrong ownership, unsafe
credential-file modes, malformed or oversized data, and unsupported versions.
Keychain and file records are reconciled by revision so a stale primary record
cannot hide a newer fallback.

Vault mutation is serialized with a cross-process file lease. The Interface is
`read`, `list`, `modify`, and `delete`; callers never handle storage envelopes.

Credential resolution accepts a one-shot explicit secret, a configured
environment variable, a configured argv-based helper, or a vault profile.
Helper commands are user-scope only, bypass the shell, have bounded output and
time, and never appear in project settings. Legacy `PRAXIS_API_KEY` remains the
highest non-Codex environment override. OAuth refresh failure never falls back
to an API key.

## Provider routing

One Provider Registry creates protocol Adapters at the existing `ModelProvider`
Seam:

- `OpenAICompatibleProvider` for OpenAI-compatible chat completions.
- `OpenAIResponsesProvider` for the public OpenAI Responses API-key transport.
- `AnthropicCompatibleProvider` for Anthropic Messages.
- `CodexSubscriptionProvider` for the ChatGPT Codex responses transport.

Adapter selection happens before a request. Unsupported capabilities fail
closed; request fields are never silently discarded. A request cannot switch
protocols after output or tool side effects begin.

For each main run or resume, the CLI creates a fresh turn-scoped client. One
wrapper owns bounded retry, failed-attempt buffering, request-aware fallback
admission, and the sealed route through that turn's tool continuations.
Incompatible fallback routes fail closed, and each new main user turn starts
from the primary route. A `prompt_too_long` reactive compaction retry retains
the same turn client. The same optional turn factory is propagated to
multi-completion auxiliary consumers: each Agent initial execution, Workflow
invocation, Team generation, and Project-memory extraction/selection operation
gets one fresh client that remains sticky through that logical Turn's tool
continuations; each later background follow-up and recovered execution gets a
new client and starts from its selected primary route. Session-memory requests
reuse a service-owned completion-scoped client whose routing restarts from
primary for every request; auto-mode critics and eval-judge votes remain
independently constructed one-shot clients. Recovery hydration performs no
provider work. A recovered Agent reconstructs its fresh client from only an
optional provider-neutral selected `model` in native sidechain metadata;
provider/profile, route/fallback seal, protocol, response, credential, and wire
state are never persisted or restored. This decision does not expand the small
`ModelProvider` contract or place provider-native state in core or transcripts.

`AnthropicCompatibleProvider` also owns Anthropic model-spec resolution. It
keeps the selected model public while deriving any wire-model suffix removal,
long-context beta, and advertised context capability inside the Anthropic
adapter. This preserves protocol isolation and does not introduce a shared
provider-wire abstraction.

### Public OpenAI Responses transport

`openai-responses` is an explicit built-in or custom API-key provider. The
built-in target uses `https://api.openai.com/v1`, resolves `OPENAI_API_KEY`, and
posts the standard JSON/SSE Responses request to `/responses`. The existing
`openai` provider remains OpenAI-compatible Chat Completions; model IDs never
switch protocols implicitly. The public adapter uses API billing and the
ordinary provider deadlines, and does not receive Anthropic's non-streaming
replay behavior.

The public API-key transport and `CodexSubscriptionProvider` share one
stateless Responses codec for provider-neutral history-to-item mapping and SSE
parsing. It sends `store:false`, carries full local history, and keeps encrypted
reasoning, function-call, and output continuity locally. It never sends
`previous_response_id` and never puts provider-native transcript fields into
core or transcripts. Authentication and headers remain transport-owned: the
public adapter uses standard Bearer/JSON/SSE headers, while Codex retains its
OAuth/account/private headers and fixed endpoint.

## Codex OAuth and transport

`openai-codex` is a distinct, experimental subscription provider. It accepts
only a vault OAuth record, requires the explicit
`experimental.codexSubscription` setting, fixes the provider endpoint, and
does not accept an API key or endpoint override.

Login uses authorization-code PKCE with a loopback-only callback, an
unpredictable one-use state, strict callback path/state checks, bounded waits,
and device authorization when explicitly requested. The default browser launch
passes only an unpredictable `127.0.0.1` one-use bridge URL to the browser
process. The bridge returns a non-cacheable redirect to the authorization URL
and closes; the already printed authorization URL remains the manual fallback.
Tokens are refreshed within five minutes of expiry with in-process singleflight
and cross-process double-checked vault mutation. Rotated refresh tokens are
committed before the lock is released.

The first transport is SSE. Codex headers, account identity, and fixed endpoint
stay private to `CodexSubscriptionProvider`; its request mapping and streaming
parsing use the shared Responses codec. Subscription usage reports tokens and
model usage but does not calculate pay-as-you-go API
charges. API pricing tables are ignored for subscription runs; USD budgets and
plugin-eval paid LLM judges reject before inference when numeric API-billed cost
is unavailable. Subscription usage is never represented as a fabricated zero
cost.

This integration is experimental because official OpenAI documentation did
not establish a stable third-party contract for reusing ChatGPT subscription
OAuth and the Codex backend. A kill switch must disable login and inference
without affecting API-key providers.

## Error handling

Configuration and credential failures are actionable local errors. Provider
responses map to existing Praxis error kinds. Secrets, authorization URLs,
PKCE verifiers, token responses, and credential helper output are redacted
from logs, errors, Transcripts, debug output, and process arguments.

Malformed settings, unsafe credential storage, OAuth state mismatch, missing
account identity, refresh failure, and unsupported capability all fail closed.

## Test strategy

- Schema, precedence, trust, and legacy environment fixtures.
- Vault permission, symlink, malformed data, atomicity, stale-primary, and
  concurrent mutation fixtures.
- Resolver source, helper, redaction, and no-OAuth-fallback fixtures.
- Shared provider contract tests for request, stream, tool, usage, error, and
  cancellation behavior.
- Public Responses request-capture and shared-codec fixtures cover explicit
  protocol selection, local continuity, `store:false`, and transport-owned
  authentication/headers.
- Fake OAuth and Codex HTTP servers; no real credential is required by CI.
- Browser-launch fixtures verify that authorization state and PKCE challenges
  never enter child-process arguments.
- Existing native provider, package, performance, security, and full project
  gates remain required.

## Consequences

Praxis owns the maintenance cost of provider and Codex protocol changes, but
its runtime stays independent from external SDK types and release cycles.
Adding an OpenAI-compatible vendor is primarily configuration; a new Adapter is
introduced only for a genuinely different wire protocol.
