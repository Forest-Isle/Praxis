// Product-scope disposition: required work blocks developer-core closure,
// while deferred work is optional and excluded work remains a documented non-goal.
export type ClaudeCommandDisposition =
  'included' | 'required' | 'deferred' | 'excluded'

export type ClaudeCommandVisibility = 'visible' | 'hidden' | 'conditional'

export interface ClaudeCommandInventoryEntry {
  name: string
  disposition: ClaudeCommandDisposition
  visibility: ClaudeCommandVisibility
  reason?: string
}

// Authoritative external COMMANDS registry from the ~/dev/claude-code 2.1.208
// source snapshot. Duplicate interactive/non-interactive implementations share
// one command name here. Build-feature commands remain conditional rather than
// disappearing from the parity inventory.
export const CLAUDE_2_1_208_COMMAND_INVENTORY = [
  { name: 'add-dir', disposition: 'included', visibility: 'visible' },
  {
    name: 'advisor',
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'Conditional advice mode is an optional, demand-driven feature that does not block developer-core closure.',
  },
  { name: 'agents', disposition: 'included', visibility: 'visible' },
  { name: 'branch', disposition: 'included', visibility: 'visible' },
  { name: 'btw', disposition: 'included', visibility: 'visible' },
  {
    name: 'chrome',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Claude-AI subscription-gated Chrome Beta; a future provider-neutral browser feature is separate from this command.',
  },
  { name: 'clear', disposition: 'included', visibility: 'visible' },
  { name: 'color', disposition: 'included', visibility: 'visible' },
  { name: 'compact', disposition: 'included', visibility: 'visible' },
  { name: 'config', disposition: 'included', visibility: 'visible' },
  { name: 'copy', disposition: 'included', visibility: 'visible' },
  {
    name: 'desktop',
    disposition: 'excluded',
    visibility: 'visible',
    reason: 'Desktop handoff/import is outside the CLI-only product boundary.',
  },
  { name: 'context', disposition: 'included', visibility: 'conditional' },
  {
    name: 'cost',
    disposition: 'included',
    visibility: 'conditional',
    reason:
      'The dedicated /cost contract is included; /status is not a substitute.',
  },
  { name: 'diff', disposition: 'included', visibility: 'visible' },
  {
    name: 'doctor',
    disposition: 'required',
    visibility: 'conditional',
    reason:
      'Interactive /doctor is required; the top-level command is not a substitute.',
  },
  { name: 'effort', disposition: 'included', visibility: 'visible' },
  { name: 'exit', disposition: 'included', visibility: 'visible' },
  {
    name: 'fast',
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'The /fast state flow is an optional convenience; model and effort controls cover the core flow, so it is deferred without blocking developer-core closure.',
  },
  {
    name: 'files',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'The source command is restricted to the internal Ant user type.',
  },
  {
    name: 'heapdump',
    disposition: 'excluded',
    visibility: 'hidden',
    reason:
      'Hidden V8 maintainer diagnostic that writes a heap dump to Desktop; not a developer-core command.',
  },
  { name: 'help', disposition: 'included', visibility: 'visible' },
  {
    name: 'ide',
    disposition: 'excluded',
    visibility: 'visible',
    reason: 'IDE integration is outside the CLI-only product boundary.',
  },
  { name: 'init', disposition: 'included', visibility: 'visible' },
  { name: 'keybindings', disposition: 'included', visibility: 'conditional' },
  {
    name: 'install-github-app',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Hosted GitHub app setup is outside the local-only boundary.',
  },
  {
    name: 'install-slack-app',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Hosted Slack app setup is outside the local-only boundary.',
  },
  { name: 'mcp', disposition: 'included', visibility: 'visible' },
  { name: 'memory', disposition: 'included', visibility: 'visible' },
  {
    name: 'mobile',
    disposition: 'excluded',
    visibility: 'visible',
    reason: 'Mobile app handoff is outside the CLI-only product boundary.',
  },
  { name: 'model', disposition: 'included', visibility: 'visible' },
  { name: 'output-style', disposition: 'included', visibility: 'hidden' },
  {
    name: 'remote-env',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Remote-session environments are outside the local-only boundary.',
  },
  { name: 'plugin', disposition: 'included', visibility: 'visible' },
  { name: 'pr-comments', disposition: 'included', visibility: 'visible' },
  { name: 'release-notes', disposition: 'included', visibility: 'visible' },
  { name: 'reload-plugins', disposition: 'included', visibility: 'visible' },
  { name: 'rename', disposition: 'included', visibility: 'visible' },
  { name: 'resume', disposition: 'included', visibility: 'visible' },
  {
    name: 'session',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Remote-session URLs and QR codes are outside the local-only boundary.',
  },
  { name: 'skills', disposition: 'included', visibility: 'visible' },
  {
    name: 'stats',
    disposition: 'deferred',
    visibility: 'visible',
    reason:
      'Historical usage statistics are an optional, demand-driven feature that does not block developer-core closure.',
  },
  { name: 'status', disposition: 'included', visibility: 'visible' },
  { name: 'statusline', disposition: 'included', visibility: 'visible' },
  {
    name: 'stickers',
    disposition: 'excluded',
    visibility: 'visible',
    reason: 'Merchandise ordering is not an agent capability.',
  },
  {
    name: 'tag',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'The source command is restricted to the internal Ant user type.',
  },
  { name: 'theme', disposition: 'included', visibility: 'visible' },
  {
    name: 'feedback',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Anthropic product-feedback submission is a hosted control-plane surface.',
  },
  { name: 'review', disposition: 'included', visibility: 'visible' },
  {
    name: 'ultrareview',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Ultrareview runs on the hosted Claude Code web surface.',
  },
  { name: 'rewind', disposition: 'included', visibility: 'visible' },
  { name: 'security-review', disposition: 'included', visibility: 'visible' },
  {
    name: 'terminal-setup',
    disposition: 'included',
    visibility: 'conditional',
  },
  {
    name: 'upgrade',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Claude subscription upgrades are outside the authentication boundary.',
  },
  {
    name: 'extra-usage',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Claude subscription overage billing is outside the authentication boundary.',
  },
  {
    name: 'rate-limit-options',
    disposition: 'excluded',
    visibility: 'hidden',
    reason:
      'Claude subscription rate-limit purchasing is outside the authentication boundary.',
  },
  { name: 'usage', disposition: 'included', visibility: 'conditional' },
  {
    name: 'insights',
    disposition: 'deferred',
    visibility: 'visible',
    reason:
      'Retrospective insights are an optional, demand-driven feature that does not block developer-core closure.',
  },
  { name: 'vim', disposition: 'included', visibility: 'visible' },
  {
    name: 'web-setup',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Remote setup is outside the local-only boundary.',
  },
  { name: 'fork', disposition: 'included', visibility: 'conditional' },
  {
    name: 'buddy',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Compile/build-feature-gated experiment, not a stable single-user developer-core command.',
  },
  {
    name: 'proactive',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Compile/build-feature-gated experiment, not a stable single-user developer-core command.',
  },
  {
    name: 'brief',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Compile/build-feature-gated experiment, not a stable single-user developer-core command.',
  },
  {
    name: 'assistant',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Compile/build-feature-gated experiment, not a stable single-user developer-core command.',
  },
  {
    name: 'remote-control',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Bridge mode is a remote-control surface.',
  },
  {
    name: 'remote-control-server',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Remote Control is outside the local-only boundary.',
  },
  {
    name: 'voice',
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'Conditional voice input is an optional, demand-driven feature that does not block developer-core closure.',
  },
  {
    name: 'think-back',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'The 2025 year-in-review campaign surface; a marketing flow, not a stable developer-core command.',
  },
  {
    name: 'thinkback-play',
    disposition: 'excluded',
    visibility: 'hidden',
    reason:
      'Hidden animation for the 2025 year-in-review campaign; a marketing flow, not a stable developer-core command.',
  },
  { name: 'permissions', disposition: 'included', visibility: 'visible' },
  { name: 'plan', disposition: 'included', visibility: 'visible' },
  {
    name: 'privacy-settings',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Claude subscriber privacy controls require the excluded account surface.',
  },
  { name: 'hooks', disposition: 'included', visibility: 'visible' },
  { name: 'export', disposition: 'included', visibility: 'visible' },
  { name: 'sandbox', disposition: 'included', visibility: 'conditional' },
  {
    name: 'login',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Claude subscription authentication is explicitly excluded.',
  },
  {
    name: 'logout',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Claude subscription authentication is explicitly excluded.',
  },
  {
    name: 'passes',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Claude subscription referrals are outside the product boundary.',
  },
  {
    name: 'peers',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'Peer inbox collaboration is a multi-user surface.',
  },
  { name: 'tasks', disposition: 'included', visibility: 'visible' },
  { name: 'workflows', disposition: 'included', visibility: 'conditional' },
  {
    name: 'torch',
    disposition: 'excluded',
    visibility: 'conditional',
    reason:
      'Compile/build-feature-gated experiment, not a stable single-user developer-core command.',
  },
] as const satisfies readonly ClaudeCommandInventoryEntry[]

export const CLAUDE_2_1_208_COMMAND_BY_NAME: ReadonlyMap<
  string,
  ClaudeCommandInventoryEntry
> = new Map(
  CLAUDE_2_1_208_COMMAND_INVENTORY.map((entry) => [entry.name, entry]),
)
