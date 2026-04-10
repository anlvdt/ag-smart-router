#!/bin/bash
# Switch model in Antigravity IDE via OS-level mouse simulation
# Uses cliclick to generate isTrusted=true mouse events
# Usage: ./switch-model.sh [model-name]
# Example: ./switch-model.sh "Gemini 3.1 Pro"

TARGET="${1:-Gemini 3.1 Pro (High)}"
echo "[AG] Switching model to: $TARGET"

# Get Antigravity window position
WIN_INFO=$(osascript -e '
tell application "System Events"
    tell process "Electron"
        set w to front window
        set p to position of w
        set s to size of w
        return {item 1 of p, item 2 of p, item 1 of s, item 2 of s}
    end tell
end tell
' 2>/dev/null)

if [ -z "$WIN_INFO" ]; then
    echo "[AG] Antigravity window not found"
    exit 1
fi

WX=$(echo $WIN_INFO | cut -d',' -f1 | tr -d ' ')
WY=$(echo $WIN_INFO | cut -d',' -f2 | tr -d ' ')
WW=$(echo $WIN_INFO | cut -d',' -f3 | tr -d ' ')
WH=$(echo $WIN_INFO | cut -d',' -f4 | tr -d ' ')
echo "[AG] Window: x=$WX y=$WY w=$WW h=$WH"

# Model selector is near bottom of chat panel, left side
# Typically at ~70% width from left edge, ~92% height from top
# These are approximate — adjust based on your layout
MODEL_X=$((WX + WW * 15 / 100))
MODEL_Y=$((WY + WH * 95 / 100))

echo "[AG] Clicking model selector at ($MODEL_X, $MODEL_Y)"

# Focus Antigravity first
osascript -e 'tell application "Antigravity" to activate' 2>/dev/null
sleep 0.3

# Click model selector
cliclick c:$MODEL_X,$MODEL_Y
sleep 0.8

# Now need to find and click the target model in dropdown
# Dropdown appears above the selector, items are ~30px apart
# Use keyboard to search: type first few chars of model name
# Then press Enter to select

# Type model name to filter
SEARCH=$(echo "$TARGET" | cut -c1-10)
cliclick t:"$SEARCH"
sleep 0.5

# Press Enter to select
cliclick kp:return
sleep 0.3

echo "[AG] Model switch attempted: $TARGET"
