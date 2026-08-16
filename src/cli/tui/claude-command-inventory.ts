export type ClaudeCommandDisposition = 'included' | 'deferred' | 'excluded'

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
      'Conditional advice mode is required parity work and is not implemented yet.',
  },
  { name: 'agents', disposition: 'included', visibility: 'visible' },
  { name: 'branch', disposition: 'included', visibility: 'visible' },
  { name: 'btw', disposition: 'included', visibility: 'visible' },
  {
    name: 'chrome',
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'The CLI-driven Chrome integration is required parity work and is not implemented yet.',
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
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'The dedicated /cost contract is required; /status is not a substitute.',
  },
  { name: 'diff', disposition: 'included', visibility: 'visible' },
  {
    name: 'doctor',
    disposition: 'deferred',
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
      'The /fast state flow is required; model and effort controls are not a substitute.',
  },
  {
    name: 'files',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'The source command is restricted to the internal Ant user type.',
  },
  {
    name: 'heapdump',
    disposition: 'deferred',
    visibility: 'hidden',
    reason:
      'The hidden heap-diagnostic contract is required parity work and is not implemented yet.',
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
      'Historical usage statistics are required parity work and are not implemented yet.',
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
  {
    name: 'usage',
    disposition: 'excluded',
    visibility: 'conditional',
    reason: 'The source command is the Claude subscription plan-usage panel.',
  },
  {
    name: 'insights',
    disposition: 'deferred',
    visibility: 'visible',
    reason:
      'Retrospective insights are required parity work and are not implemented yet.',
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
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'This conditional source mode is required parity work and is not implemented yet.',
  },
  {
    name: 'proactive',
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'This conditional source mode is required parity work and is not implemented yet.',
  },
  {
    name: 'brief',
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'This conditional source mode is required parity work and is not implemented yet.',
  },
  {
    name: 'assistant',
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'This conditional source mode is required parity work and is not implemented yet.',
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
      'Conditional voice input is required parity work and is not implemented yet.',
  },
  {
    name: 'think-back',
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'The conditional retrospective flow is required parity work and is not implemented yet.',
  },
  {
    name: 'thinkback-play',
    disposition: 'deferred',
    visibility: 'hidden',
    reason:
      'The hidden retrospective playback flow is required parity work and is not implemented yet.',
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
    disposition: 'deferred',
    visibility: 'conditional',
    reason:
      'This source-gated behavior is required conditional parity work and is not implemented yet.',
  },
] as const satisfies readonly ClaudeCommandInventoryEntry[]

export const CLAUDE_2_1_208_COMMAND_BY_NAME: ReadonlyMap<
  string,
  ClaudeCommandInventoryEntry
> = new Map(
  CLAUDE_2_1_208_COMMAND_INVENTORY.map((entry) => [entry.name, entry]),
)
