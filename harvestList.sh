#!/bin/bash
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 22 > /dev/null

if [ -z "$1" ]; then
    echo "Usage: ./harvestList.sh <listId>"
    echo "Example: ./harvestList.sh 1831"
    exit 1
fi

node --loader ts-node/esm --no-warnings src/harvestList.ts "$1"
