#!/bin/bash
# Publish the static site locally, then upload it to HostPapa.
# Scheduled by launchd agent com.goodreads.publishsite (daily 09:00, see
# ~/Library/LaunchAgents/com.goodreads.publishsite.plist).
#
# Output goes to ~/goodreadsZeitgeist, the same directory
# uploadHostpapa.py uses by default. The upload does NOT delete remote files;
# removed local reports stay on the server until explicitly cleaned up.
set -euo pipefail
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 22 > /dev/null

out="$HOME/goodreadsZeitgeist"
envfile="$HOME/.hostpapa-ftp.env"

echo starting publishAndUpload.sh
date
./publishSite.sh --out "$out"
bash ./uploadHostpapa.sh "$envfile" "$out"
echo ended publishAndUpload.sh
date
