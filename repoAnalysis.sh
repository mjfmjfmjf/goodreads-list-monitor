#!/bin/sh
# Quick repo analysis: file count, sizes, file types, test count. See repoAnalysis.py.
exec python3 "$(dirname "$0")/repoAnalysis.py" "$@"
