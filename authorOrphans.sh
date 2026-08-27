#!/bin/bash
date
echo starting authorOrphans.sh
npm run author-orphans -- "$@"
echo ended authorOrphans.sh
date