#!/bin/sh
# Run bulk-tag-discovery for top shelves on Goodreads.
# Default: fetches shelves from pages 1-25, processes the first 10,
# scanning pages 1-25 of each shelf.
# Usage examples:
#   ./bulkTagDiscovery.sh                                          # defaults
#   ./bulkTagDiscovery.sh --pages 24-25 --start 1 --count 20      # shelves from pages 24-25
#   ./bulkTagDiscovery.sh --shelfPages 7-11                        # scan pages 7-11 of each shelf
#   ./bulkTagDiscovery.sh --pages 1 --start 10 --count 7 --shelfPages 7-11
date
echo starting bulkTagDiscovery.sh
npm run bulk-tag-discovery -- "$@"
echo ended bulkTagDiscovery.sh
date
