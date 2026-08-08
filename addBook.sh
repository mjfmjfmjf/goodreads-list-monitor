#!/bin/bash
if [ $# -lt 1 ]; then
  echo "Usage: ./addBook.sh <bookId>"
  echo "Example: ./addBook.sh 51477729"
  echo "First copy the book text (from title to language) into the clipboard, then pass the book id."
  echo "Run ./addBook.sh --help for full details."
  exit 1
fi
echo "copy text from title to language into buffer, pass id on command-line"
npm run add-book -- "$@"
