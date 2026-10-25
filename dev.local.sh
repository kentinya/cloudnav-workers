#!/bin/sh
set -eu
cd "$(dirname "$0")"
export WRANGLER_SEND_METRICS=false
pnpm build
pnpm exec wrangler dev &
backend_pid=$!
cleanup() {
  kill "$backend_pid" 2>/dev/null || true
  wait "$backend_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pnpm exec vite --config vite.local.config.ts
