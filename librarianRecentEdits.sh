#!/bin/bash
# REQUIRES CREDENTIALS: This script uses cookies from config.json (loadConfig().cookie)
# The Goodreads Librarian Recent Edits page requires authentication and will redirect without valid cookies.
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./librarianRecentEdits.sh [options]"
  echo "Walks Goodreads Librarian Recent Edits (requires authentication)."
  echo "Harvests book_id and author_id; inserts minimal rows for unseen items only."
  echo "No author back-catalog scraping, no book detail scraping."
  echo ""
  echo "REQUIRES CREDENTIALS in config.json"
  echo ""
  echo "Examples:"
  echo "  ./librarianRecentEdits.sh                (pages 1-100)"
  echo "  ./librarianRecentEdits.sh --pages 10     (first 10 pages)"
  echo "  ./librarianRecentEdits.sh --dryRun       (enumerate only)"
  exit 0
fi
date
echo "starting librarianRecentEdits.sh (REQUIRES CREDENTIALS)"
npm run librarian-recent-edits -- "$@"
echo "ended librarianRecentEdits.sh"
date
