---
name: setup
description: >
  Install and configure Whazaa from a local clone. USE WHEN user says "set up Whazaa",
  "install Whazaa", "configure Whazaa", "set up WhatsApp integration", OR user has just
  cloned the repo and asks Claude to get it running. Covers prerequisites, build, MCP
  config, watcher launchd service, WhatsApp pairing, and post-setup verification.
---

# Whazaa Setup Skill

Complete autonomous setup of Whazaa from a local clone. Ask the user for input only
when a QR code scan is required.

---

## Context

Whazaa has two components:

1. **MCP server** (`dist/index.js`) — a thin IPC proxy started by Claude Code. Provides
   the `whatsapp_*` tools. Connects to the watcher over a Unix Domain Socket.
2. **Watcher daemon** (`dist/index.js watch`) — a long-running background process that
   owns the WhatsApp (Baileys) connection and delivers incoming messages to iTerm2 via
   AppleScript. Managed by macOS launchd as `com.whazaa.watcher`.

The repo path is needed throughout. Determine it before starting:

```bash
REPO="$(pwd)"   # if already in the repo
# or use the path the user provided
```

---

## Step 1: Check Prerequisites

Run these checks. Report failures but continue to gather all issues before stopping.

```bash
# Node.js version (must be >= 18)
node --version

# macOS check (watcher requires macOS + iTerm2 + AppleScript)
sw_vers -productVersion

# iTerm2 installed
ls /Applications/iTerm.app 2>/dev/null && echo "iTerm2: OK" || echo "iTerm2: NOT FOUND — install from https://iterm2.com"

# ffmpeg (required for TTS voice notes — WAV to OGG conversion)
which ffmpeg && echo "ffmpeg: OK" || echo "ffmpeg: NOT FOUND — install with: brew install ffmpeg"

# whisper (optional — only needed to receive voice notes from phone)
which whisper 2>/dev/null && echo "whisper: OK" || echo "whisper: optional — install with: pip install openai-whisper"
```

If Node.js is below 18, stop and tell the user to upgrade.
If iTerm2 is missing, stop — the watcher cannot deliver messages without it.
ffmpeg and whisper can be installed after setup if needed.

---

## Step 2: Install Dependencies

```bash
cd "$REPO"
npm install
```

Verify `node_modules` was created. If npm fails, check Node.js version and network access.

---

## Step 3: Build

```bash
cd "$REPO"
npm run build
```

Verify `dist/index.js` exists after the build:

```bash
ls "$REPO/dist/index.js" && echo "Build OK" || echo "Build FAILED"
```

If the build fails, report the compiler error to the user and stop.

---

## Step 4: Configure MCP

Add Whazaa to `~/.claude.json` pointing to the local build. Using a local path
(not `npx whazaa`) ensures Claude Code uses this specific build.

Read the current file first to avoid clobbering existing entries:

```bash
cat ~/.claude.json 2>/dev/null || echo "File does not exist"
```

Then write the updated config. The key change from the `npx` default: use `node` +
the absolute path to `dist/index.js`.

Example config block to merge in:

```json
{
  "mcpServers": {
    "whazaa": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/Whazaa/dist/index.js"]
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/Whazaa` with the actual repo path.

Verification:

```bash
cat ~/.claude.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('whazaa entry:', d.get('mcpServers',{}).get('whazaa'))"
```

---

## Step 5: Set Up Watcher Launchd Service

The watcher must run as a persistent macOS launchd user agent so it:
- Starts automatically on login
- Restarts if it crashes
- Can call AppleScript to control iTerm2 (requires `LimitLoadToSessionType: Aqua`)

Use the control script bundled in the repo:

```bash
bash "$REPO/scripts/watcher-ctl.sh" start
```

The script writes the plist to `~/Library/LaunchAgents/com.whazaa.watcher.plist` and
loads it. It uses `KeepAlive: true` so launchd restarts the watcher automatically.

Verify the watcher loaded:

```bash
bash "$REPO/scripts/watcher-ctl.sh" status
```

Expected output: `Watcher: RUNNING (launchd, PID: XXXXX)`

If the watcher is not running after `start`, check the log:

```bash
tail -20 /tmp/whazaa-watch.log
```

Common causes of failure at this stage:
- Build not complete (dist/index.js missing) — run Step 3 again
- Node not found at the path watcher-ctl.sh resolved — check `which node`

---

## Step 6: WhatsApp Pairing (USER INTERACTION REQUIRED)

Tell the user:

> The next step requires you to scan a QR code with WhatsApp on your phone.
> I will trigger the pairing flow now. When the QR code appears in your browser,
> open WhatsApp on your phone, go to: Settings > Linked Devices > Link a Device,
> then scan the QR code.
>
> Ready? I will start the pairing flow now.

Run the built-in setup wizard which handles pairing interactively:

```bash
node "$REPO/dist/index.js" setup
```

This command:
1. Opens the GitHub repo in your browser (informational)
2. Detects if `~/.claude.json` already has Whazaa (skips if so)
3. Checks `~/.whazaa/auth/creds.json` — if it exists, verifies the existing session
4. If no session or session expired: generates a QR code in the browser
5. Waits for the phone scan and prints the connected phone number on success

Wait for the output: `Connected to WhatsApp as +XXXXXXXXXXX` and
`Setup complete! Restart Claude Code and Whazaa will be ready.`

If the QR code window does not open automatically, the user can find the URL in the
terminal output and open it manually.

Note: if an existing session is found and still valid, the wizard confirms it and exits
without showing a QR code. In that case, skip to Step 7.

---

## Step 7: Verify

Restart Claude Code is needed for the MCP config to take effect. Tell the user:

> Please restart Claude Code now so the Whazaa MCP server is loaded.

After Claude Code restarts (the user returns to this session or a new one), verify:

```bash
# Watcher is running
bash "$REPO/scripts/watcher-ctl.sh" status

# Watcher log shows connection
tail -5 /tmp/whazaa-watch.log

# Auth credentials exist
ls -la ~/.whazaa/auth/creds.json
```

Then call the MCP tool directly to confirm end-to-end connectivity:

```
whatsapp_status
```

Expected: `Connected. Phone: +XXXXXXXXXXX`

If `whatsapp_status` returns "Watcher not running", the launchd service did not load
correctly. Run `bash "$REPO/scripts/watcher-ctl.sh" start` again and check the log.

---

## Step 8: Post-Setup Recommendations

Tell the user the following CLAUDE.md additions will make Whazaa significantly more
useful. Offer to add them to `~/.claude/CLAUDE.md` (global) or a project-level
`CLAUDE.md`.

### Mirror every response to WhatsApp

```
Every response you give on the terminal MUST also be sent to WhatsApp via whatsapp_send.
Send the same content — do not shorten or paraphrase.
Adapt markdown for WhatsApp: use **bold** and *italic* only. No headers, no code blocks.
```

### Acknowledge before long tasks

```
If a task will take more than a few seconds, your FIRST tool call must be
whatsapp_send with a brief acknowledgment (e.g. "On it — researching that now.").
Then proceed with the actual work. Never leave WhatsApp silent while working.
```

### Drain the queue at session start

```
At the start of every session, call whatsapp_receive to drain any queued
messages that arrived while you were offline.
```

---

## Troubleshooting Reference

| Symptom | Fix |
|---------|-----|
| `Tools return "Watcher not running"` | `bash scripts/watcher-ctl.sh start` |
| `Logged out (401)` | `node dist/index.js setup` to re-pair |
| QR code not appearing | Check `tail -20 /tmp/whazaa-watch.log` |
| Messages not typing into Claude | Verify iTerm2 Automation permission in System Settings > Privacy & Security > Automation |
| TTS fails with "ffmpeg not found" | `brew install ffmpeg` |
| MCP server disconnects repeatedly | `pkill -f "whazaa"` then let Claude Code restart it |
| iTerm2 Automation dialog appeared | Click OK; if you clicked "Don't Allow", grant permission manually in System Settings |

---

## Summary Checklist

- [ ] Node.js >= 18
- [ ] iTerm2 installed
- [ ] ffmpeg installed (for TTS)
- [ ] `npm install` completed
- [ ] `npm run build` completed — `dist/index.js` exists
- [ ] `~/.claude.json` has `whazaa` entry pointing to local `dist/index.js`
- [ ] Watcher launchd service loaded and running (`com.whazaa.watcher`)
- [ ] WhatsApp session paired — `~/.whazaa/auth/creds.json` exists
- [ ] Claude Code restarted
- [ ] `whatsapp_status` returns `Connected`
- [ ] CLAUDE.md updated with WhatsApp mirroring rules (recommended)
