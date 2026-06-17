#!/bin/bash

# Ensure we are in the project root
cd "$(dirname "$0")"

if [ -z "$1" ]; then
    echo "Usage: ./harvestList.sh [listId]"
    exit 1
fi

# Use the specific Node version from the user's environment
/Users/mitchellfriedman/.nvm/versions/node/v18.20.8/bin/node --loader ts-node/esm --no-warnings src/harvestList.ts "$1"
