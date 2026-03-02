#!/bin/bash
# Trigger Whazaa desk dictation via IPC.
#
# Sends a "dictate" command to the watcher socket. The watcher records from
# the Mac mic (sox), transcribes via Whisper, and types the result into the
# active Claude Code iTerm2 session.
#
# Bind to a macOS keyboard shortcut via:
#   System Settings > Keyboard > Keyboard Shortcuts > Services
#   or an Automator Quick Action (no input, runs shell script)
#
# Prerequisites: sox (brew install sox), whisper CLI, running watcher

SOCKET="/tmp/whazaa-watcher.sock"
ID="dict-$(date +%s)"

if [ ! -S "$SOCKET" ]; then
  echo "Watcher not running (no socket at $SOCKET)" >&2
  exit 1
fi

echo "{\"id\":\"$ID\",\"sessionId\":\"dictate-script\",\"method\":\"dictate\",\"params\":{}}" | nc -U "$SOCKET"
