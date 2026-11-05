#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./giveaways.sh [options]"
  echo "Walks the Goodreads Giveaways feed and detail-scrapes the books on offer."
  echo "Book-id only: the listing is used purely to discover book ids; the book"
  echo "detail page provides all book-level data."
  echo ""
  echo "Examples:"
  echo "  ./giveaways.sh                            (walk recent giveaways → detail-scrape)"
  echo "  ./giveaways.sh --limit 500000             (detail-scrape every not-yet-scraped book)"
  echo "  ./giveaways.sh --sort ending              (ending soon first)"
  echo "  ./giveaways.sh --dryRun                   (enumerate + print ids, no writes)"
  echo "  ./giveaways.sh --no-details               (enumerate only, no detail-scrape)"
  echo "  ./giveaways.sh --help                     (verbose command help from the CLI itself)"
  exit 0
fi
date
echo starting giveaways.sh
# Default: scrape every book on the feed (giveaways is a bounded ~1.8k feed,
# not an open-ended list) — only inject when the caller didn't pass --limit.
case " $* " in
  *" --limit "*) ;;
  *) set -- "$@" --limit 10000 ;;
esac
npm run giveaways -- "$@"
echo ended giveaways.sh
date
