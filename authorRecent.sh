#!/bin/bash
# authorRecent.sh — wrapper for `author-recent`
#
# Rescrapes authors who have a book published within the last few years
# (default 10): page 1 of their works list, sorted by original_publication_year,
# so fresh output refreshes author stats and harvests their recent books.
# Candidates come from the books table (author has a qualifying recent book)
# and are ordered from most overall author-page ratings to least.
# Authors whose stats were updated within the last --minAge days are skipped
# (default 14).
#
# Usage:
#   ./authorRecent.sh                            # defaults: 10 years, 14d minAge, limit 100
#   ./authorRecent.sh --limit 200                # more authors per run
#   ./authorRecent.sh --years 5                  # only authors with a book in the last 5 years
#   ./authorRecent.sh --minAge 30                # wait 30 days before re-scraping an author
#   ./authorRecent.sh --withCookie               # cookie-authenticated pacing (slower, no auth needed)
date
echo starting authorRecent.sh
npm run author-recent -- "$@"
echo ended authorRecent.sh
date