#!/bin/bash
input=$(cat 2>/dev/null || true)
PCT=0
if [ -n "$input" ]; then
  PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' 2>/dev/null | cut -d. -f1)
fi
PCT=${PCT:-0}

BAR_WIDTH=12
FILLED=$((PCT * BAR_WIDTH / 100))
EMPTY=$((BAR_WIDTH - FILLED))
BAR=""
[ "$FILLED" -gt 0 ] && printf -v FILL "%${FILLED}s" && BAR="${FILL// /▓}"
[ "$EMPTY"  -gt 0 ] && printf -v PAD  "%${EMPTY}s"  && BAR="${BAR}${PAD// /░}"

if   [ "$PCT" -ge 90 ]; then COLOR="🔴"
elif [ "$PCT" -ge 70 ]; then COLOR="🟡"
else                         COLOR="🟢"
fi

echo "${COLOR} Context: [${BAR}] ${PCT}%"
