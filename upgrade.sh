#!/bin/bash
set -e
echo "🔄 Upgrading OpenClaw Studio..."
cd "$(dirname "$0")"
git pull
npm install
npm run build
launchctl unload ~/Library/LaunchAgents/com.openclaw-studio.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.openclaw-studio.plist
echo "✅ OpenClaw Studio upgraded and restarted"
