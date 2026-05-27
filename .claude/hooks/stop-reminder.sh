#!/bin/bash

input=$(cat)

stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active // empty')
if [[ "$stop_hook_active" = "true" ]]; then
  exit 0
fi

claude_md="$CLAUDE_PROJECT_DIR/CLAUDE.md"

if [[ ! -f "$claude_md" ]]; then
  exit 0
fi

if grep -q "\[update this when you know what's next\]" "$claude_md"; then
  echo "REMINDER: The 'Next steps' field in CLAUDE.md still has the placeholder text. Please tell Claude what you worked on this session so it updates CLAUDE.md before you go — this is how Claude remembers context next session." >&2
  exit 2
fi

exit 0
