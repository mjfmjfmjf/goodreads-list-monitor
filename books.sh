#!/bin/bash
if [ $# -lt 1 ]; then
  echo "Usage: ./books.sh [pattern] [--title <regex>] [--authorLast <regex>] [--authorFirst <regex>] [--sort ratings|numRatings|numReviews|avgRatings|numShelves|numTags|currentlyReading|toRead|editionCount|reviewRatio|ratingsMean|ratingsMedian|ratingsMode|ratingsVariance|ratingsStddev|ratingsSkewness|ratingsKurtosis|ratingsTotal|year|title|author] [--limit N] [--minRatings N] [--tag <name>] [--genre <a,b>] [--notGenre <a,b>] [--minPages N] [--maxPages N] [--hasDetails] [--dedupe] [--excludeReviewed --export|--import <path>]"
  echo "Example: ./books.sh '^j'"
  echo "Example: ./books.sh --authorLast '^sanderson' --sort year"
  echo "Example: ./books.sh --title '^[jqx]' --minRatings 1000 --limit 20"
  echo "Example: ./books.sh --sort numReviews --minRatings 100000 --limit 20"
  echo "Example: ./books.sh --sort numShelves --dedupe --limit 20"
  echo "Example: ./books.sh --tag fantasy --minRatings 100 --dedupe --limit 20"
  echo "Example: ./books.sh --genre fiction --minPages 100 --dedupe --sort avgRatings --asc --limit 20"
  echo "Example: ./books.sh --genre comics,graphic-novels --notGenre manga --limit 20"
  echo "Example: ./books.sh --hasDetails --minRatings 3000 --sort avgRatings --desc --limit 100000   # only books with details pages"
  echo "Example: ./books.sh '^j' --excludeReviewed   # uses cached library import"
  echo "Example: ./books.sh '^j' --excludeReviewed --export ~/Downloads/goodreads_library_export.csv   # refresh cached import first"
  echo "Example: ./books.sh --export ~/Downloads/goodreads_library_export.csv   # import + validate + cache, report library stats"
  echo "Run ./books.sh --help for full details."
  exit 1
fi
npm run books -- "$@"
