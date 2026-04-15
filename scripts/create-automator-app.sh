#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Create macOS Automator app for launching Antigravity + CDP
#  Run once: ./scripts/create-automator-app.sh
#  Creates: ~/Desktop/Antigravity CDP.app
# ═══════════════════════════════════════════════════════════

APP_NAME="Antigravity CDP"
APP_DIR="$HOME/Desktop/$APP_NAME.app"
PORT=9333

echo "🔧 Creating $APP_NAME.app on Desktop..."

# Create app bundle structure
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>launch</string>
    <key>CFBundleName</key>
    <string>Antigravity CDP</string>
    <key>CFBundleIdentifier</key>
    <string>com.grav.antigravity-cdp</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST

# Create launcher script
cat > "$APP_DIR/Contents/MacOS/launch" << SCRIPT
#!/bin/bash
PORT=$PORT

# Check if already running
if curl -s --connect-timeout 1 http://127.0.0.1:\$PORT/json/version > /dev/null 2>&1; then
    osascript -e 'display notification "Antigravity already running with CDP" with title "Grav"'
    exit 0
fi

# Launch
open -a Antigravity --args --remote-debugging-port=\$PORT

# Wait and notify
for i in \$(seq 1 10); do
    sleep 1
    if curl -s --connect-timeout 1 http://127.0.0.1:\$PORT/json/version > /dev/null 2>&1; then
        osascript -e 'display notification "CDP ready — Grav can reach all buttons" with title "Grav ✅"'
        exit 0
    fi
done

osascript -e 'display notification "CDP not responding — check Antigravity" with title "Grav ⚠️"'
SCRIPT

chmod +x "$APP_DIR/Contents/MacOS/launch"

# Copy Antigravity icon if available
AG_ICON="/Applications/Antigravity.app/Contents/Resources/antigravity.icns"
if [ -f "$AG_ICON" ]; then
    cp "$AG_ICON" "$APP_DIR/Contents/Resources/applet.icns"
    echo "   ✓ Copied Antigravity icon"
fi

echo "✅ Created: $APP_DIR"
echo "   Double-click to launch Antigravity with CDP mode"
echo "   Then enable in Grav: grav.cdpEnabled = true"
