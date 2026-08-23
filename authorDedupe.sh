#!/bin/bash
cd "$(dirname "$0")"
npm run author-dedupe -- "$@"
date
