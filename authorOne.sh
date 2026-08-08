#!/bin/bash
if [ $# -lt 1 ]; then
  echo "Usage: ./authorOne.sh <urlOrSlug>"
  echo "Example: ./authorOne.sh 14018357.Steve_the_Noob"
  echo "Example: ./authorOne.sh https://www.goodreads.com/author/show/14018357.Steve_the_Noob"
  echo "Run ./authorOne.sh --help for full details."
  exit 1
fi
date
echo starting authorOne.sh
npm run author-one -- "$@"
echo ended authorOne.sh
date
