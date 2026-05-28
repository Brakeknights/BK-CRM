#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
git config core.hooksPath .githooks
npm install

# Show commits on dev not yet merged to master
git fetch origin master dev --quiet 2>/dev/null || true
PENDING=$(git log origin/master..origin/dev --oneline 2>/dev/null)
if [ -n "$PENDING" ]; then
  echo ""
  echo "⚠️  Commits on dev not yet on master:"
  echo "$PENDING"
else
  echo ""
  echo "✅ dev and master are in sync — nothing pending."
fi
