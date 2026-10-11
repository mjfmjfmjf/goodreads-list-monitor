#!/bin/bash
date
echo starting authorRekey.sh
npm run author-rekey -- "$@"
echo ended authorRekey.sh
date
