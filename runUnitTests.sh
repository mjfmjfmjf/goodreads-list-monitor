#!/bin/bash
# Runs the unit test suite (Vitest) WITH code coverage (v8): fast, offline,
# pure-function tests in src/*.test.ts. These never hit the network and are
# safe to run after every feature change or dependency/tool upgrade.
#
# Also runs two offline guards that vitest alone cannot provide:
#   1. tsc --noEmit  — full typecheck. ts-node typechecks at load time in
#      production, so a type error that vitest (transpile-only) misses crashes
#      EVERY command with an unreadable null-prototype dump.
#   2. CLI smoke — spawns the real CLI under the production ts-node/esm loader.
cd "$(dirname "$0")"
set -e
npx tsc --noEmit
npm run test:coverage
npx vitest run --config vitest.config.integration.mjs src/integration/cliSmoke.integration.ts
