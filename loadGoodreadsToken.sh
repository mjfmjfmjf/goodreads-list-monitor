#!/bin/bash

# ==============================================================================
# HOW TO FIND AND GET YOUR GOODREADS COOKIE TOKEN:
# ==============================================================================
# 1. Open Google Chrome and make sure you are logged in to Goodreads.
# 2. Open Developer Tools:
#    - Right-click anywhere on the page and select "Inspect", OR
#    - Press Cmd+Option+I (Mac) or Ctrl+Shift+I (Windows).
# 3. Navigate to the "Network" tab in Developer Tools.
# 4. Refresh the Goodreads page (e.g., go to https://www.goodreads.com/).
# 5. Look for any request under the "Name" column targeting "www.goodreads.com" 
#    (usually the first document request is easiest).
# 6. Click on that request, and in the panel that opens, ensure "Headers" is selected.
# 7. Scroll down to the "Request Headers" section and locate the "Cookie:" header.
# 8. Copy the entire cookie value (the long string starting with something like 
#    "more_ro=true; ...").
# 9. Paste this entire string into a file named "rawGoodreadsToken.txt" in this directory.
# 10. Run this script:
#     ./loadGoodreadsToken.sh
# ==============================================================================

# Ensure rawGoodreadsToken.txt exists
if [ ! -f "rawGoodreadsToken.txt" ]; then
  echo "Error: rawGoodreadsToken.txt not found!"
  echo "Please create a file named rawGoodreadsToken.txt in this directory and paste your raw cookie there."
  exit 1
fi

# Run Node.js to safely read, clean, and write the token to config.json
node -e '
const fs = require("fs");
const path = require("path");

try {
  const rawPath = path.join(process.cwd(), "rawGoodreadsToken.txt");
  const configPath = path.join(process.cwd(), "config.json");

  // Read raw token
  let rawCookie = fs.readFileSync(rawPath, "utf8");

  // Remove newlines and carriage returns
  rawCookie = rawCookie.replace(/[\r\n]+/g, "");

  // Remove leading "Cookie: " or "cookie: " if present
  rawCookie = rawCookie.replace(/^cookie:\s*/i, "");

  // Trim spaces
  rawCookie = rawCookie.trim();

  // Remove surrounding single or double quotes
  if ((rawCookie.startsWith("\"") && rawCookie.endsWith("\"")) || 
      (rawCookie.startsWith("\u0027") && rawCookie.endsWith("\u0027"))) {
    rawCookie = rawCookie.slice(1, -1);
  }

  // Remove any backslash escapes
  rawCookie = rawCookie.replace(/\\/g, "");

  // Final trim
  rawCookie = rawCookie.trim();

  if (!rawCookie) {
    console.error("Error: The token in rawGoodreadsToken.txt is empty!");
    process.exit(1);
  }

  // Read existing config.json or start from scratch
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      console.warn("Warning: config.json was not valid JSON. Overwriting with new config.");
    }
  }

  // Update cookie
  config.cookie = rawCookie;

  // Write updated config
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  console.log("Success! config.json has been successfully updated with the cleaned cookie.");
} catch (err) {
  console.error("An error occurred while updating config.json:", err.message);
  process.exit(1);
}
'
