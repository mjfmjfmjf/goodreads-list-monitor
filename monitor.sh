#!/bin/bash
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 22
echo starting monitor.sh
date
# The DB snapshot is intentionally NOT part of this loop anymore: a
# consistent-snapshot backup of the multi-GB DB takes ~an hour under crawler
# load. Run it on its own schedule via ./backupDb.sh when nothing else is
# using the DB.
npm start
date
echo ended monitor.sh
