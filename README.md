# Whazaa

WhatsApp MCP server for Claude Code — bidirectional self-chat messaging with terminal integration.

You message yourself on WhatsApp, Claude receives it. Claude responds, you see it on WhatsApp. Your phone becomes a parallel terminal.

---

## Features

- **Bidirectional messaging** — send from Claude, receive from your phone
- **Terminal watcher** — incoming messages are typed directly into your Claude Code session via iTerm2
- **Zero configuration** — auto-detects your phone number after first scan
- **First-run QR pairing** — scan once, connects automatically thereafter
- **Markdown support** — `**bold**`, `*italic*`, `` `code` `` converted to WhatsApp format
- **Deduplication** — outgoing messages never echo back as incoming
- **Exponential backoff** — reconnects automatically (1s to 60s)
- **MCP-safe** — all output except JSON-RPC goes to stderr

---

## Quick Start

One command does everything — configures Claude Code, opens a QR code in your browser, and pairs with WhatsApp:

```bash
npx -y whazaa setup
```

That's it. Restart Claude Code and you're connected.

---

## What `setup` does

1. Creates (or updates) `~/.claude/.mcp.json` with the Whazaa MCP entry
2. Opens a QR code in your browser
3. You scan it with WhatsApp (Settings → Linked Devices → Link a Device)
4. Pairing completes, credentials are saved to `~/.whazaa/auth/`
5. Restart Claude Code — Whazaa connects automatically from now on

---

## Usage

After setup, restart Claude Code. Whazaa connects automatically.

Messages go through your WhatsApp self-chat — the chat with yourself (sometimes called "Saved Messages" or "Message Yourself").

**Tell Claude to use WhatsApp:**

Just say something like:
- "Message me on WhatsApp when you're done"
- "Continue on WhatsApp"
- "Listen on WhatsApp" — Claude will start the watcher and receive your messages as terminal input

**Example:**
1. In Claude Code: "Refactor the auth module and message me on WhatsApp when done"
2. Walk away from your desk
3. Claude finishes and WhatsApps you: "Done. What's next?"
4. You reply from your phone: "Now run the tests"
5. Claude reads your reply and runs the tests

---

## Terminal Watcher (macOS + iTerm2)

> **Platform:** The watcher currently requires **macOS** with **iTerm2**. It uses AppleScript (`osascript`) to type into a specific iTerm2 session. Terminal.app and non-macOS platforms are not yet supported — contributions welcome.

The `watch` command bridges WhatsApp messages directly into a Claude Code terminal session. Incoming messages are typed into the terminal via AppleScript automation — Claude sees them as regular user input.

### How it works

1. Whazaa MCP server writes incoming messages to a log file
2. The watcher polls the log for new lines (every 2 seconds)
3. The watcher resolves the target iTerm2 session (see below)
4. New messages are typed into that session via `osascript`
5. Claude Code processes them as regular user input

### Session resolution

The watcher uses a fallback chain to find a usable iTerm2 session:

1. **Try the specified session ID** — uses the session ID passed on the command line
2. **Search by tab name** — if that session is gone, scans all iTerm2 sessions for one whose tab name contains "claude"
3. **Retry after 2 seconds** — if still not found, waits and tries again (AppleScript may need a moment to connect when the watcher starts fresh from launchd)
4. **Create a new tab** — if no session is found after the retry, opens a new iTerm2 tab, runs `claude`, waits for it to boot, then uses that session

This means the watcher can recover automatically if you close and reopen your Claude Code tab, or if it was started before iTerm2 was fully ready.

### Managing the watcher

Claude Code manages the watcher automatically — when you say "listen on WhatsApp" or use `/whatsapp on`, it starts the watcher as a macOS launchd agent targeting the current iTerm2 session. The control script is at `scripts/watcher-ctl.sh`:

```bash
scripts/watcher-ctl.sh start    # Install and start as launchd agent
scripts/watcher-ctl.sh stop     # Stop and unload the agent
scripts/watcher-ctl.sh status   # Show whether the agent is running
```

The launchd agent is configured with `KeepAlive: true`, so macOS automatically restarts the watcher if it crashes. It also uses `ProcessType: Interactive` and `LimitLoadToSessionType: Aqua`, which gives the agent access to the macOS GUI session. This is required because AppleScript needs a GUI context to control iTerm2 — without it, `osascript` calls from a launchd background agent would fail silently or be refused by the system.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WHAZAA_LOG` | `/tmp/whazaa-incoming.log` | Path to the incoming message log file |
| `WHAZAA_POLL_INTERVAL` | `2` | Seconds between file checks |

---

## Uninstall

```bash
npx -y whazaa uninstall
```

This removes Whazaa from `~/.claude/.mcp.json` and deletes stored credentials from `~/.whazaa/`. Restart Claude Code to apply.

---

## Manual Configuration

If you prefer to configure manually, add Whazaa to `~/.claude/.mcp.json` (or your project's `.mcp.json`):

### Using npx (always latest version)

```json
{
  "mcpServers": {
    "whazaa": {
      "command": "npx",
      "args": ["whazaa"]
    }
  }
}
```

### Using bunx

```json
{
  "mcpServers": {
    "whazaa": {
      "command": "bunx",
      "args": ["whazaa"]
    }
  }
}
```

### Using a local build

```json
{
  "mcpServers": {
    "whazaa": {
      "command": "node",
      "args": ["/path/to/whazaa/dist/index.js"]
    }
  }
}
```

After updating the MCP config, restart Claude Code. On first run, Whazaa prints a QR code to the Claude Code logs (check Settings → Developer → MCP Logs, or run it manually from a terminal first to complete pairing).

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `whatsapp_status` | Report connection state and phone number |
| `whatsapp_send` | Send a message to your own WhatsApp self-chat |
| `whatsapp_receive` | Drain queued incoming messages from your phone |
| `whatsapp_wait` | Block until a message arrives (up to timeout) |
| `whatsapp_login` | Trigger a new QR pairing flow |

## CLI Commands

| Command | Description |
|---------|-------------|
| `whazaa setup` | Interactive setup — configures MCP, pairs with WhatsApp |
| `whazaa watch <session-id>` | Start terminal watcher for iTerm2 session |
| `whazaa uninstall` | Remove MCP config and stored credentials |

---

## How It Works

Whazaa uses the [Baileys](https://github.com/WhiskeySockets/Baileys) library to maintain a persistent WebSocket connection to WhatsApp's servers using the same multi-device protocol as WhatsApp Web. It exposes MCP tools over stdin/stdout and routes all Baileys output to stderr to keep the JSON-RPC stream clean.

**Stale instance cleanup:**
When a new MCP server starts, it automatically finds and kills any existing Whazaa MCP processes (excluding watch processes and itself). This prevents multiple instances from competing for the same WhatsApp auth credentials, which would otherwise cause frequent disconnects as each instance races to own the session.

**Message flow (incoming):**
1. You type a message on your phone in the self-chat
2. Baileys receives it via WebSocket
3. Whazaa queues it in memory and writes it to the log file
4. The `watch` process detects the new line and types it into your terminal
5. Claude Code processes it as user input

**Message flow (outgoing):**
1. Claude calls `whatsapp_send` via MCP
2. Whazaa converts Markdown to WhatsApp formatting
3. Baileys sends it via WebSocket
4. The message appears on your phone

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHAZAA_AUTH_DIR` | `~/.whazaa/auth/` | Directory for WhatsApp session credentials |
| `WHAZAA_LOG` | `/tmp/whazaa-incoming.log` | Incoming message log file (used by `watch`) |
| `WHAZAA_POLL_INTERVAL` | `2` | Watcher poll interval in seconds |

---

## Troubleshooting

**"Logged out (401)" error**

Your session was invalidated (e.g. you unlinked the device in WhatsApp). Run `npx -y whazaa setup` again to re-pair.

**Messages not received**

Call `whatsapp_receive` to drain the queue. Only messages sent to your own number (the self-chat / "Saved Messages" chat) are captured. If using the watcher, check that it's running: `ps aux | grep "whazaa.*watch"`.

**"iTerm2 wants to control..." security prompt**

On first use, macOS will show a security dialog asking whether to allow the watcher (or `osascript`) to control iTerm2. Click "OK" to allow it. If you accidentally clicked "Don't Allow", go to System Settings → Privacy & Security → Automation and enable iTerm2 for the relevant app. Without this permission, the watcher cannot type messages into your terminal.

**Watcher not typing into terminal**

Verify the session ID matches your Claude Code tab: `echo $ITERM_SESSION_ID`. The watcher requires iTerm2 on macOS.

**Connection keeps dropping**

Whazaa uses exponential backoff to reconnect automatically. Check your network connection. If the problem persists, use `whatsapp_login` to re-establish the session.

**Multiple WhatsApp accounts**

Set `WHAZAA_AUTH_DIR` to a different directory for each account and run separate instances.

---

## Requirements

- Node.js >= 18
- WhatsApp account with multi-device support
- **For the `watch` command:** macOS with [iTerm2](https://iterm2.com/) (uses AppleScript to type into terminal sessions)

---

## Security Notes

- Session credentials are stored locally in `~/.whazaa/auth/`. Treat them like passwords.
- Whazaa only reads and sends messages in your self-chat. It does not have access to other conversations.
- No data is sent to any third-party service. The connection is directly to WhatsApp's servers via Baileys.

---

## License

MIT — see [LICENSE](LICENSE)

## Author

Matthias Nott — [github.com/mnott](https://github.com/mnott)
