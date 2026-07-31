#!/usr/bin/env bash
# install-loop.sh — wire tick.sh into launchd (macOS) or print the cron line.
# Installing the schedule + writing autopilot=true IS the autopilot opt-in.
set -euo pipefail

RALPH_HOME="${RALPH_HOME:-$HOME/.ralph}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTERVAL_MIN="${RALPH_TICK_INTERVAL_MIN:-15}"
LABEL="com.ralph.tick"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-}" in
  --enable)
    mkdir -p "$RALPH_HOME"
    grep -q '^autopilot=true$' "$RALPH_HOME/config" 2>/dev/null || echo 'autopilot=true' >> "$RALPH_HOME/config"
    if [ "$(uname)" = "Darwin" ]; then
      cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>$REPO_ROOT/ralph/scripts/tick.sh</string>
  </array>
  <key>StartInterval</key><integer>$((INTERVAL_MIN * 60))</integer>
  <key>StandardErrorPath</key><string>$RALPH_HOME/tick-stderr.log</string>
</dict></plist>
EOF
      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load "$PLIST"
      echo "installed: $LABEL every ${INTERVAL_MIN}m ($PLIST); autopilot=true in $RALPH_HOME/config"
    else
      echo "add to crontab: */$INTERVAL_MIN * * * * /bin/bash $REPO_ROOT/ralph/scripts/tick.sh"
      echo "autopilot=true written to $RALPH_HOME/config"
    fi
    ;;
  --disable)
    if [ "$(uname)" = "Darwin" ]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      sed -i '' '/^autopilot=true$/d' "$RALPH_HOME/config" 2>/dev/null || true
      echo "loop disabled (launchd job removed, autopilot=false)"
    else
      sed -i '/^autopilot=true$/d' "$RALPH_HOME/config" 2>/dev/null || true
      echo "autopilot=false — tick.sh now refuses to run; remove the crontab line manually (crontab -e)"
    fi
    ;;
  *)
    echo "usage: install-loop.sh --enable | --disable" >&2
    echo "  --enable  writes autopilot=true, installs launchd job (or prints cron line)" >&2
    exit 64
    ;;
esac
