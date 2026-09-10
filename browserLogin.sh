#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./browserLogin.sh [--reset]"
  echo "One-time interactive login for the headed browser session."
  echo ""
  echo "Opens a persistent Chromium window (profile at ~/.goodreads/browser-profile)."
  echo "Sign in with email + password once; every --engine browser run after that"
  echo "reuses the saved session."
  echo ""
  echo "Examples:"
  echo "  ./browserLogin.sh"
  echo "  ./browserLogin.sh --reset    (wipe the profile before re-logging-in)"
  echo "  ./browserLogin.sh --help     (verbose command help from the CLI itself)"
  exit 0
fi
date
echo starting browserLogin.sh
npm run browser-login -- "$@"
echo ended browserLogin.sh
date