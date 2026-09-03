#!/bin/bash
# Rank the top similar non-genre tags for each genre, by book-set Jaccard
# similarity. Purely local — computes over the already-scraped tag_books,
# so a genre must be scraped (as a tag) to have a book set to compare.
#
# Usage:
#   ./genreTagPairings.sh                     # top 10 non-genre tags per genre
#   ./genreTagPairings.sh --genre dark-fantasy  # just one genre
#   ./genreTagPairings.sh --limit 5            # top 5 per genre
#   ./genreTagPairings.sh --allTags            # include tags that are also genres
#   ./genreTagPairings.sh --minMember 100000   # only big genres
#
# Output: per genre, the top-K tags by % Jaccard similarity (overlap / union)
# with the genre's own book set, plus the shared book count and union size.
# Scraped-but-unmatched genres show their real pairings; unscraped genres are
# skipped with a note (scrape them via gapGenreTagDiscovery.sh first).

date
echo "starting genreTagPairings.sh"
npm run genre-tag-pairings -- "$@"
echo "ended genreTagPairings.sh"
date
