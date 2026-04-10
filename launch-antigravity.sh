#!/bin/bash
# Launch Antigravity with CDP enabled for AG Autopilot
# Usage: ./launch-antigravity.sh [optional: folder path]
#
# This enables --remote-debugging-port=9333 which is REQUIRED for:
#   - Smart Router (auto-select model by prompt)
#   - Quota Fallback (auto-switch model on quota exhaustion)
#   - CDP trusted click (isTrusted=true bypass)

APP="/Applications/Antigravity.app/Contents/MacOS/Electron"
PORT=9333

# Check if already running with CDP
if curl -s --connect-timeout 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1; then
    echo "✅ Antigravity already running with CDP on port $PORT"
    # Open folder if provided
    if [ -n "$1" ]; then
        /Applications/Antigravity.app/Contents/Resources/app/bin/antigravity "$1"
    fi
    exit 0
fi

echo "🚀 Launching Antigravity with --remote-debugging-port=$PORT"

if [ -n "$1" ]; then
    open -a Antigravity "$1" --args --remote-debugging-port=$PORT
else
    open -a Antigravity --args --remote-debugging-port=$PORT
fi

# Wait for CDP to be ready
for i in $(seq 1 15); do
    sleep 1
    if curl -s --connect-timeout 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1; then
        echo "✅ CDP ready on port $PORT"
        exit 0
    fi
    echo "   waiting... ($i/15)"
done

echo "⚠️  CDP not responding after 15s. Check if Antigravity started correctly."
echo "   Try manually: open -a Antigravity --args --remote-debugging-port=$PORT"
