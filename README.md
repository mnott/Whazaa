# Whazaa

WhatsApp bridge for Claude Code. You message yourself on WhatsApp, Claude receives it. Claude responds, you see it on WhatsApp. Your phone becomes a parallel terminal.

---

## How it works

Whazaa has two components:

**Watcher daemon** — a long-running process that owns the WhatsApp connection (via the [Baileys](https://github.com/WhiskeySockets/Baileys) library). It delivers incoming messages to iTerm2 by typing them into your Claude session via AppleScript. It also serves a Unix Domain Socket so MCP server instances can send and receive messages without holding their own connection.

**MCP server** — a thin IPC proxy started by Claude Code. It has no direct WhatsApp connection. Every tool call is forwarded to the watcher over the socket and the response returned to Claude.

```
Your phone
    |
    | WhatsApp (Baileys WebSocket)
    |
  Watcher daemon  ←── launchd, auto-restarts
    |
    |── AppleScript ──> iTerm2 ──> Claude Code (types message into terminal)
    |
    |── Unix Domain Socket (/tmp/whazaa-watcher.sock)
              |
              └──> MCP Server (started by Claude Code)
                       |
                       └──> whatsapp_send / receive / status / wait / login
```

The separation means you can have multiple Claude Code sessions open simultaneously. Each MCP server instance registers its `TERM_SESSION_ID` with the watcher, and whichever session most recently sent a message becomes the active recipient for incoming messages.

---

## Quick start

One command does everything:

```bash
npx -y whazaa setup
```

This will:
1. Add Whazaa to `~/.claude/.mcp.json`
2. Open a QR code in your browser
3. You scan it with WhatsApp: Settings > Linked Devices > Link a Device
4. Credentials are saved to `~/.whazaa/auth/`

Restart Claude Code. Whazaa connects automatically from now on.

---

## MCP tools

Once configured, Claude Code has seven tools available:

| Tool | Description |
|------|-------------|
| `whatsapp_status` | Check connection state and phone number |
| `whatsapp_send` | Send a message to your WhatsApp self-chat |
| `whatsapp_receive` | Drain all queued incoming messages |
| `whatsapp_wait` | Block until a message arrives (up to timeout) |
| `whatsapp_login` | Trigger a new QR pairing flow |
| `whatsapp_chats` | List WhatsApp conversations (from Desktop DB or Baileys) |
| `whatsapp_history` | Fetch message history for a conversation |

### whatsapp_send

Sends a message to your self-chat. Supports Markdown formatting converted to WhatsApp format:

- `**bold**` becomes `*bold*`
- `*italic*` becomes `_italic_`
- `` `code` `` becomes ` ```code``` `

### whatsapp_wait

Efficient alternative to polling. Blocks the tool call until a message arrives or the timeout expires (default 120 seconds, max 300). Use this in the background while working:

```
"Message me on WhatsApp when you're done. I'll wait."
```

### whatsapp_chats

Lists WhatsApp conversations. Reads from the WhatsApp Desktop macOS SQLite database for a complete inbox view, falling back to Baileys in-memory store (~100–150 recent chats) if the Desktop app is not installed.

Parameters:
- `search` (optional) — filter results by contact name or phone number
- `limit` (optional, default 50, max 200) — maximum number of conversations to return

Returns conversation JIDs, display names, and last-message timestamps. JIDs can be passed directly to `whatsapp_history`.

### whatsapp_history

Fetches message history for a conversation. Reads from the WhatsApp Desktop macOS SQLite database (no phone connection required). Falls back to requesting history from Baileys on demand, which requires the phone to be online.

Parameters:
- `jid` (required) — the conversation JID (e.g. `15551234567@s.whatsapp.net`), as returned by `whatsapp_chats`
- `count` (optional, default 50, max 500) — number of messages to return (most recent first)

---

## CLI commands

```bash
# First-time setup: configure MCP and pair with WhatsApp
npx -y whazaa setup

# Start the watcher daemon (manages iTerm2 delivery and IPC)
npx whazaa watch [session-id]

# Remove MCP config and stored credentials
npx -y whazaa uninstall
```

---

## Watcher daemon

The watcher is the core of Whazaa. It runs as a macOS launchd agent so it starts automatically and restarts if it crashes.

### Starting manually

```bash
npx whazaa watch
```

Pass an iTerm2 session ID to target a specific terminal:

```bash
npx whazaa watch $ITERM_SESSION_ID
```

### launchd setup (auto-start)

Claude Code can manage the watcher automatically. Use the control script:

```bash
scripts/watcher-ctl.sh start    # Install and start as launchd agent
scripts/watcher-ctl.sh stop     # Stop and unload
scripts/watcher-ctl.sh status   # Show running state
```

The agent uses `KeepAlive: true` and `ProcessType: Interactive`. The Interactive process type and `LimitLoadToSessionType: Aqua` are required so the watcher can access the macOS GUI session and call AppleScript to control iTerm2.

### Session resolution

When a message arrives, the watcher delivers it to Claude using this fallback chain:

1. Try the cached session ID — but only if Claude is actually running there (not at a shell prompt)
2. Search all iTerm2 sessions for one whose tab name contains "claude"
3. Create a new iTerm2 tab, `cd $HOME`, run `claude`, wait for it to boot

The watcher recovers automatically if you close and reopen your Claude tab.

> **Platform requirement:** The watcher requires macOS with [iTerm2](https://iterm2.com/). It uses AppleScript (`osascript`) to type into terminal sessions. Terminal.app and non-macOS platforms are not yet supported.

---

## WhatsApp commands

Certain messages sent from your phone are intercepted by the watcher and handled as commands rather than forwarded to Claude.

| Command | Description |
|---------|-------------|
| `/relocate <path>` or `/r <path>` | Open a new iTerm2 tab in the given directory and start Claude there |
| `/sessions` or `/s` | List open Claude sessions and offer to switch between them |

### /relocate

```
/relocate ~/projects/myapp
/r ~/projects/myapp
```

If a Claude session is already open in that directory, Whazaa focuses it instead of creating a new tab. Tilde expansion is supported.

After relocating, subsequent messages are delivered to the new session.

### /sessions

Reply `/s` to get a numbered list of open Claude sessions with their working directories. Switch with `/1`, `/2`, etc.

---

## Multiple sessions

Whazaa supports multiple simultaneous Claude Code windows. Each MCP server instance registers its `TERM_SESSION_ID` when it starts. Whichever session most recently called `whatsapp_send` becomes the active recipient for incoming messages.

The watcher maintains a separate incoming message queue for each registered session. If no session has sent a message yet, the first registered session is used.

---

## Best practices for CLAUDE.md

To get the most out of Whazaa, add these rules to your `CLAUDE.md` (or `~/.claude/CLAUDE.md` for global config):

### Mirror every response to WhatsApp

Tell Claude to send the same content it prints on the terminal to WhatsApp, so you can follow along from your phone:

```
Every response you give on the terminal MUST also be sent to WhatsApp via whatsapp_send.
Send the same content — do not shorten or paraphrase.
Adapt markdown for WhatsApp: use **bold** and *italic* only. No headers, no code blocks.
```

### Acknowledge before long tasks

If Claude is about to spawn agents, read multiple files, or do anything that takes more than a few seconds, it should send a brief WhatsApp message **first** — before calling any other tools. Otherwise your phone goes silent and you don't know if Claude heard you.

```
If a task will take more than a few seconds, your FIRST tool call must be
whatsapp_send with a brief acknowledgment (e.g. "On it — researching that now.").
Then proceed with the actual work. Never leave WhatsApp silent while working.
```

### Drain the queue at session start

Messages you send from your phone while Claude is generating a response may be queued. Call `whatsapp_receive` early in each session to catch them:

```
At the start of every session, call whatsapp_receive to drain any queued
messages that arrived while you were offline.
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WHAZAA_AUTH_DIR` | `~/.whazaa/auth/` | Directory for WhatsApp session credentials |

---

## Manual MCP configuration

If you prefer to configure manually, add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "whazaa": {
      "command": "npx",
      "args": ["-y", "whazaa"]
    }
  }
}
```

Using bunx:

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

Using a local build:

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

---

## Troubleshooting

**"Logged out (401)" error**

Your session was invalidated. Run `npx -y whazaa setup` to re-pair.

**Tools return "Watcher not running"**

The watcher daemon is not running. Start it with `npx whazaa watch` or use `scripts/watcher-ctl.sh start` to install it as a launchd agent.

**Messages not appearing in Claude**

Check that the watcher is running: `ps aux | grep "whazaa.*watch"`. Verify the session ID matches your Claude tab: `echo $ITERM_SESSION_ID`.

**"iTerm2 wants to control..." security prompt**

Click OK. If you clicked "Don't Allow", go to System Settings > Privacy & Security > Automation and enable iTerm2 for the relevant app.

**MCP server disconnects frequently**

This happens when multiple Whazaa MCP processes compete for the same WhatsApp session. Whazaa automatically kills stale instances on startup. If the problem persists, run `pkill -f "whazaa"` and let Claude Code restart the MCP server.

**Connection keeps dropping**

Whazaa reconnects automatically with exponential backoff (1s to 60s). Check your network. If the issue persists, call `whatsapp_login` to re-establish the session.

---

## Security

- Session credentials are stored locally in `~/.whazaa/auth/`. Treat them like passwords — they grant full access to your WhatsApp Web session.
- Whazaa only reads and sends messages in your self-chat. It cannot access other conversations.
- No data is sent to any third-party service. All communication is directly with WhatsApp's servers via Baileys.

---

## Requirements

- Node.js >= 18
- WhatsApp account (any — multi-device support is standard)
- macOS with [iTerm2](https://iterm2.com/) for the `watch` command and iTerm2 delivery

---

## Uninstall

```bash
npx -y whazaa uninstall
```

Removes Whazaa from `~/.claude/.mcp.json` and deletes credentials from `~/.whazaa/`. Restart Claude Code to apply.

---

## License

MIT — see [LICENSE](LICENSE)

## Author

Matthias Nott — [github.com/mnott](https://github.com/mnott)
