#!/bin/bash
date
echo starting genreStats.sh
npm run genre-stats -- "$@"
echo ended genreStats.sh
date
