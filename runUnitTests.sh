#!/bin/bash
# Runs the unit test suite (Vitest) WITH code coverage (v8): fast, offline,
# pure-function tests in src/*.test.ts. These never hit the network and are
# safe to run after every feature change or dependency/tool upgrade.
cd "$(dirname "$0")"
npm run test:coverage
