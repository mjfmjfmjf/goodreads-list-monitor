#!/bin/bash
# Report the contributor roles Goodreads appends to author strings.
#
# Book pages say "Vincenzo Bellini(Composer)", "John Joseph Adams(Editor)" —
# that raw form survives in books.author, and this script parses it against a
# curated role vocabulary so org-name parens ("British Museum (Natural
# History)", "(USA)") don't pollute the counts. Roles are a per-book
# contribution; nothing is captured on the authors table.
#
# Purely local: streams books.author with a LIKE prefilter, no network, no
# writes, O(1) memory.
#
# Usage:
#   ./authorRoles.sh                            # roles by book count (top 40)
#   ./authorRoles.sh --min-books 500            # only big roles
#   ./authorRoles.sh --role composer            # books credited as Composer
#   ./authorRoles.sh --role editor --authors    # authors credited as Editor
#   ./authorRoles.sh --all                      # unfiltered paren candidates
#   ./authorRoles.sh --help                     # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,18p' "$0"
  exit 0
fi
date
echo starting authorRoles.sh
npm run author-roles -- "$@"
echo ended authorRoles.sh
date
