#!/bin/bash
# watcher-ctl.sh — Manage the Whazaa watcher via macOS launchd
#
# On Linux (uname) it drives a systemd user unit instead of launchd.
#
# Usage:
#   watcher-ctl.sh start [iterm-session-id]
#   watcher-ctl.sh stop
#   watcher-ctl.sh status
#
# The watcher is managed as a launchd user agent with KeepAlive=true,
# so it auto-restarts if it dies. This makes it fully persistent —
# it survives Claude Code /clear, session resets, and terminal closures.
# The session ID is optional — the watcher discovers Claude sessions dynamically.

LABEL="com.whazaa.watcher"
NAME="whazaa"
# Test seams: WATCHER_PLATFORM (fake uname), WATCHER_PLIST, WATCHER_UNIT_DIR,
# WATCHER_LOG_DIR, WATCHER_NO_LOAD=1 (never call launchctl/systemctl/loginctl).
PLATFORM="${WATCHER_PLATFORM:-$(uname -s)}"
PLIST="${WATCHER_PLIST:-$HOME/Library/LaunchAgents/${LABEL}.plist}"
UNIT="${NAME}-watcher.service"
UNIT_DIR="${WATCHER_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT_PATH="$UNIT_DIR/$UNIT"
NODE="$(which node 2>/dev/null || echo /usr/local/bin/node)"
WHAZAA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Per-user log dir (0700); /tmp/whazaa-watch.log stays as a symlink for old tooling.
LOG_DIR="$HOME/Library/Logs/whazaa"
[ "$PLATFORM" = Linux ] && LOG_DIR="$HOME/.local/state/$NAME"
LOG_DIR="${WATCHER_LOG_DIR:-$LOG_DIR}"
LOG="$LOG_DIR/watch.log"
LEGACY_LOG="${WATCHER_CTL_LEGACY_LOG:-/tmp/whazaa-watch.log}"

xml_escape() {
  # sed, not ${//}: bash 5.2 treats a bare & in the replacement as the match
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# EnvironmentVariables body: PATH plus every exported AIBROKER_* / WHAZAA_* var
# of the invoking shell, so launchd children (Whisper -> ffmpeg) see the same env.
env_xml() {
  local name
  for name in PATH $(compgen -e | grep -E '^(AIBROKER|WHAZAA)_' | sort -u); do
    printf '    <key>%s</key>\n    <string>%s</string>\n' "$name" "$(xml_escape "${!name}")"
  done
}

prepare_log() {
  umask 077
  mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
  touch "$LOG" && chmod 600 "$LOG"
  [ "$PLATFORM" = Linux ] || ln -sf "$LOG" "$LEGACY_LOG" 2>/dev/null
}

# systemd_quote — double-quote a value for a unit file: escape \ " and %
systemd_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
}

# Environment= lines: same variables as env_xml, quoted for systemd.
env_unit() {
  local name
  for name in PATH $(compgen -e | grep -E '^(AIBROKER|WHAZAA)_' | sort -u); do
    printf 'Environment=%s\n' "$(systemd_quote "$name=${!name}")"
  done
}

# write_unit [session-id] — generate the systemd user unit (does not enable it)
write_unit() {
  local session_id="${1:-}"
  prepare_log
  mkdir -p "$UNIT_DIR"
  local exec_start
  # ExecStart also expands $VAR, so a literal $ is doubled there
  exec_start="$(systemd_quote "$NODE") $(systemd_quote "${WHAZAA_DIR}/dist/index.js") watch"
  [ -n "$session_id" ] && exec_start="$exec_start $(systemd_quote "$session_id")"
  exec_start="${exec_start//\$/\$\$}"
  local log_path="${LOG//%/%%}"
  cat > "$UNIT_PATH" <<UNITFILE
[Unit]
Description=Whazaa watcher (AIBroker WhatsApp adapter)

[Service]
ExecStart=${exec_start}
$(env_unit)
UMask=0077
Restart=on-failure
RestartSec=3
StandardOutput=append:${log_path}
StandardError=append:${log_path}

[Install]
WantedBy=default.target
UNITFILE
}

sysctl_user() { [ -n "${WATCHER_NO_LOAD:-}" ] || systemctl --user "$@"; }

linger_hint() {
  [ -n "${WATCHER_NO_LOAD:-}" ] && return
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
    echo "Linger is off: the watcher stops when you log out. Enable with: loginctl enable-linger $(id -un)"
  fi
}

# write_plist [session-id] — generate the launchd plist (does not load it)
write_plist() {
  local session_id="${1:-}"
  prepare_log

  # Build ProgramArguments — session ID is optional
  local args_xml="    <string>${NODE}</string>
    <string>${WHAZAA_DIR}/dist/index.js</string>
    <string>watch</string>"
  if [ -n "$session_id" ]; then
    args_xml="${args_xml}
    <string>${session_id}</string>"
  fi

  # Write plist
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args_xml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
$(env_xml)
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
PLIST
}

cmd_start() {
  local session_id="${1:-}"
  if [ "$PLATFORM" = Linux ]; then
    write_unit "$session_id"
    sysctl_user daemon-reload
    sysctl_user enable --now "$UNIT"
    echo "Watcher started (systemd user unit: ${UNIT}, log: ${LOG})"
    linger_hint
    return
  fi

  # Stop existing watcher if running
  cmd_stop 2>/dev/null

  write_plist "$session_id"

  # Load the agent
  [ -n "${WATCHER_NO_LOAD:-}" ] || launchctl load "$PLIST" 2>/dev/null
  if [ -n "$session_id" ]; then
    echo "Watcher started (launchd: ${LABEL}, session: ${session_id})"
  else
    echo "Watcher started (launchd: ${LABEL}, no initial session — will discover dynamically)"
  fi
}

cmd_stop() {
  if [ "$PLATFORM" = Linux ]; then
    if [ -f "$UNIT_PATH" ]; then
      sysctl_user disable --now "$UNIT" 2>/dev/null
      rm -f "$UNIT_PATH"
      sysctl_user daemon-reload
      echo "Watcher stopped (systemd unit removed)"
    else
      echo "Watcher not running (no unit found)"
    fi
    return
  fi
  if [ -f "$PLIST" ]; then
    [ -n "${WATCHER_NO_LOAD:-}" ] || launchctl unload "$PLIST" 2>/dev/null
    rm -f "$PLIST"
    echo "Watcher stopped (launchd agent removed)"
  else
    echo "Watcher not running (no plist found)"
  fi
}

cmd_status() {
  if [ "$PLATFORM" = Linux ]; then
    if [ -n "${WATCHER_NO_LOAD:-}" ]; then echo "Watcher: status skipped (WATCHER_NO_LOAD)"
    else systemctl --user status "$UNIT" --no-pager -n 3 2>&1 | sed -n 1,12p; fi
    linger_hint
    return
  fi
  if launchctl list "$LABEL" > /dev/null 2>&1; then
    # `launchctl list <label>` prints a plist dict, so its first column is "{".
    # The unfiltered listing is the tabular one: PID  STATUS  LABEL.
    local pid
    pid=$(launchctl list 2>/dev/null | awk -v l="$LABEL" '$3 == l { print $1 }')
    if [ -z "$pid" ] || [ "$pid" = "-" ]; then
      echo "Watcher: LOADED but not running (launchd will respawn it)"
    else
      echo "Watcher: RUNNING (launchd, PID: ${pid})"
    fi
  else
    echo "Watcher: NOT RUNNING"
  fi

  if [ -f "$LOG" ]; then
    echo "Log (last 3 lines):"
    tail -3 "$LOG"
  fi
}

case "${1:-}" in
  start)  cmd_start "$2" ;;
  plist)  if [ "$PLATFORM" = Linux ]; then write_unit "$2"; else write_plist "$2"; fi ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *)
    echo "Usage: watcher-ctl.sh {start|stop|status|plist} [session-id]"
    exit 1
    ;;
esac
