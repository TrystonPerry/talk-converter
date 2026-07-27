#!/usr/bin/env bash
set -euo pipefail

# Talks are now detected from the captions, so one command covers a whole event.
# Sanity-check the boundaries with --list first, then drop it to slice.
npm run start -- "https://www.youtube.com/watch?v=AifVBwTPLYc"

# If detection gets one wrong, cut that talk by hand instead:
# npm run start -- "https://www.youtube.com/watch?v=AifVBwTPLYc" \
#   --range "32:38,53:29" --title "Finite State Machines by AJ Caldwell"
