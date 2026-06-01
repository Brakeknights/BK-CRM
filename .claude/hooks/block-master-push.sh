#!/bin/bash
# PreToolUse(Bash) hard stop for master deploys.
#
# brakeknights.com deploys from the `master` branch. CLAUDE.md requires the
# user to type "go master" in chat before any master push. This hook makes
# that a HARD gate the model cannot bypass: any Bash command that pushes to
# master (or sets MASTER_OVERRIDE) is forced into a user approval prompt via
# permissionDecision "ask". Only the user can approve that prompt — the model
# cannot self-approve it, even in auto-approve permission modes.
#
# Pushes to dev and feature branches are unaffected.

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# Trip conditions:
#   1. Command sets the MASTER_OVERRIDE escape hatch, OR
#   2. Command both pushes AND references master/main.
trip=0
if printf '%s' "$cmd" | grep -q 'MASTER_OVERRIDE'; then
  trip=1
elif printf '%s' "$cmd" | grep -Eq '\bgit[[:space:]].*push' && \
     printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_/-])(master|main)([^a-zA-Z0-9_/-]|$)'; then
  trip=1
fi

if [ "$trip" -eq 1 ]; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"⛔ MASTER DEPLOY GATE: This command pushes to the live master branch (brakeknights.com). Per CLAUDE.md, this requires the user to have typed \"go master\" in chat. Claude must NOT approve this itself — only approve if you (the user) explicitly authorized a master push this turn."}}
JSON
  exit 0
fi

# Not a master push — allow silently.
exit 0
