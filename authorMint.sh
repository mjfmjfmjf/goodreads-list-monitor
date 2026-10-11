#!/bin/bash
date
echo starting authorMint.sh
npm run author-mint -- "$@"
echo ended authorMint.sh
date