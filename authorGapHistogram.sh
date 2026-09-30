#!/bin/bash
date
echo starting authorGapHistogram.sh
npm run author-gap-histogram -- "$@"
echo ended authorGapHistogram.sh
date