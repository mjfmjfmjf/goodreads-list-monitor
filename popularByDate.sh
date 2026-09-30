#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./popularByDate.sh [options]"
  echo "Walks the Goodreads 'Popular By Date' release feed and harvests book details."
  echo ""
  echo "Examples:"
  echo "  ./popularByDate.sh                          (current year + current month → details)"
  echo "  ./popularByDate.sh --year 2026 --month 9    (one month page → details)"
  echo "  ./popularByDate.sh --year 2012              (one year page back to 2012 → details)"
  echo "  ./popularByDate.sh --year 2026 --year-back 2    (year pages 2026..2024)"
  echo "  ./popularByDate.sh --month 9 --month-back 3     (months 2026-9..2026-7)"
  echo "  ./popularByDate.sh --dryRun --year 2026 --month 9   (enumerate only, print ranked ids)"
  echo "  ./popularByDate.sh --no-details --year 2012   (enumerate + persist listing, no details)"
  echo "  ./popularByDate.sh --force --skip-days 0 --year 2026  (re-walk regardless of freshness)"
  echo "  ./popularByDate.sh --help   (verbose command help from the CLI itself)"
  exit 0
fi
date
echo starting popularByDate.sh
npm run popular-by-date -- "$@"
echo ended popularByDate.sh
date