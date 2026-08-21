#!/bin/sh
set -eu

if [ "${PRAXIS_COMPAT_SEED_CLAUDE_CONFIG:-}" = "1" ] &&
  [ -n "${CLAUDE_CONFIG_DIR:-}" ] &&
  [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] &&
  [ -z "${ANTHROPIC_API_KEY:-}" ] &&
  [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  node "$script_dir/lib/seed-claude-config.mjs" "$CLAUDE_CONFIG_DIR"
fi

case "$PRAXIS_REAL_CLAUDE_BINARY" in
  /*) ;;
  *) echo "PRAXIS_REAL_CLAUDE_BINARY must be absolute" >&2; exit 64 ;;
esac
exec "$PRAXIS_REAL_CLAUDE_BINARY" "$@"
