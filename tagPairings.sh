#!/bin/bash
# Inverse of genreTagPairings.sh: for each NON-genre tag, rank the top GENRE-tags
# (scraped tags whose name is also a genre) it's most similar to, by book-set
# Jaccard similarity. Purely local over the already-scraped tag_books.
#
# Usage:
#   ./tagPairings.sh                         # top 5 genres per non-genre tag
#   ./tagPairings.sh --tag ya                # just one non-genre tag
#   ./tagPairings.sh --limit 10              # top 10 genres per tag
#   ./tagPairings.sh --minBooks 500          # only tags with >= 500 books
#   ./tagPairings.sh --maxResults 20         # only first 20 non-genre tags
#   ./tagPairings.sh --minJaccard 50         # only tags whose best genre match
#                                            #   is >= 50%, showing only matches
#                                            #   at/above 50% (good for scanning
#                                            #   auto-xref candidates)
#   ./tagPairings.sh --loadXref 50           # incrementally SYNC tag->genre
#                                            #   xref rows (kind=similarity):
#                                            #   insert new mappings, re-point
#                                            #   changed ones, drop rows now
#                                            #   below 50%, report each change,
#                                            #   then exit; curated exact/cognate
#                                            #   rows always preserved
#
# Output: per non-genre tag, the top-K GENRE-tags by % Jaccard similarity
# (overlap / union of book sets), with shared count and union size.

date
echo "starting tagPairings.sh"
npm run tag-pairings -- "$@"
echo "ended tagPairings.sh"
date
