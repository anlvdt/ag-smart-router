#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Launch Antigravity with CDP for Grav
#  Usage:
#    ./launch-antigravity.sh              # launch Antigravity
#    ./launch-antigravity.sh ~/project    # launch with folder
#    ./launch-antigravity.sh --install    # install shell alias
# ═══════════════════════════════════════════════════════════

PORT=9333
APP_NAME="Antigravity"
APP_PATH="/Applications/Antigravity.app"
ELECTRON="$APP_PATH/Contents/MacOS/Electron"

# ── Install alias ─────────────────────────────────────────
if [ "$1" = "--install" ]; then
    SHELL_RC="$HOME/.zshrc"
    [ -f "$HOME/.bashrc" ] && [ ! -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.bashrc"

    ALIAS_LINE="alias antigravity='open -a Antigravity --args --remote-debugging-port=$PORT'"

    if grep -q "remote-debugging-port" "$SHELL_RC" 2>/dev/null; then
        echo "✅ Alias already exists in $SHELL_RC"
    else
        echo "" >> "$SHELL_RC"
        echo "# Grav CDP mode — launch Antigravity with debug port" >> "$SHELL_RC"
        echo "$ALIAS_LINE" >> "$SHELL_RC"
        echo "✅ Added alias to $SHELL_RC"
        echo "   Run: source $SHELL_RC"
        echo "   Then: antigravity"
    fi
    exit 0
fi

# ── Check if already running with CDP ─────────────────────
if curl -s --connect-timeout 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1; then
    echo "✅ Antigravity already running with CDP on port $PORT"
    [ -n "$1" ] && open -a "$APP_NAME" "$1"
    exit 0
fi

# ── Launch ────────────────────────────────────────────────
echo "🚀 Launching Antigravity with --remote-debugging-port=$PORT"

if [ -n "$1" ]; then
    open -a "$APP_NAME" "$1" --args --remote-debugging-port=$PORT
else
    open -a "$APP_NAME" --args --remote-debugging-port=$PORT
fi

# ── Wait for CDP ready ────────────────────────────────────
for i in $(seq 1 15); do
    sleep 1
    if curl -s --connect-timeout 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1; then
        echo "✅ CDP ready on port $PORT — Grav can now reach OOPIF buttons"
        exit 0
    fi
    printf "   waiting... (%d/15)\r" "$i"
done

echo ""
echo "⚠️  CDP not responding after 15s."
echo ""
echo "Troubleshooting:"
echo "  1. Close ALL Antigravity windows completely"
echo "  2. Run: $ELECTRON --remote-debugging-port=$PORT"
echo "  3. Or try: open -a Antigravity --args --remote-debugging-port=$PORT"
