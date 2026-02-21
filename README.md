# Whazaa

WhatsApp MCP server for Claude Code — bidirectional self-chat messaging.

You message yourself on WhatsApp, Claude receives it. Claude responds, you see it on WhatsApp. Your phone becomes a parallel terminal.

---

## Features

- **Bidirectional messaging** — send from Claude, receive from your phone
- **Zero configuration** — auto-detects your phone number after first scan
- **First-run QR pairing** — scan once, connects automatically thereafter
- **Markdown support** — `**bold**`, `*italic*`, `` `code` `` converted to WhatsApp format
- **Deduplication** — outgoing messages never echo back as incoming
- **Exponential backoff** — reconnects automatically (1s to 60s)
- **MCP-safe** — all output except JSON-RPC goes to stderr

---

## Quick Start

### Option 1: Run directly with npx / bunx

No installation required:

```bash
npx whazaa
```

or with Bun:

```bash
bunx whazaa
```

The first run prints a QR code to your terminal. Scan it with WhatsApp (Settings -> Linked Devices -> Link a Device). Credentials are saved to `~/.whazaa/auth/` and all subsequent runs connect automatically.

### Option 2: Install globally

```bash
npm install -g whazaa
whazaa
```

### Option 3: Build from source

```bash
git clone https://github.com/mnott/whazaa.git
cd whazaa
npm install
npm run build
node dist/index.js
```

---

## Claude Code MCP Configuration

Add Whazaa to `~/.claude/.mcp.json` (or your project's `.mcp.json`):

### Using npx (always latest version)

```json
{
  "mcpServers": {
    "whazaa": {
      "command": "npx",
      "args": ["whazaa"],
      "description": "Whazaa — WhatsApp self-chat MCP server for Claude Code"
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
      "args": ["whazaa"],
      "description": "Whazaa — WhatsApp self-chat MCP server for Claude Code"
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
      "args": ["/path/to/whazaa/dist/index.js"],
      "description": "Whazaa — WhatsApp self-chat MCP server for Claude Code"
    }
  }
}
```

After updating the MCP config, restart Claude Code. On first run, Whazaa prints a QR code to the Claude Code logs (check Settings -> Developer -> MCP Logs or run it manually from a terminal first to complete pairing).

---

## Available Tools

| Tool | Description |
|------|-------------|
| `whatsapp_status` | Report connection state and phone number |
| `whatsapp_send` | Send a message to your own WhatsApp self-chat |
| `whatsapp_receive` | Drain queued incoming messages from your phone |
| `whatsapp_login` | Trigger a new QR pairing flow |

---

## How It Works

Whazaa uses the [Baileys](https://github.com/WhiskeySockets/Baileys) library to maintain a persistent WebSocket connection to WhatsApp's servers using the same multi-device protocol as WhatsApp Web. It exposes four MCP tools over stdin/stdout and routes all Baileys output to stderr to keep the JSON-RPC stream clean. Incoming messages from your phone are queued in memory and returned when `whatsapp_receive` is called.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHAZAA_AUTH_DIR` | `~/.whazaa/auth/` | Directory for WhatsApp session credentials |

### Example: custom auth directory

```json
{
  "mcpServers": {
    "whazaa": {
      "command": "node",
      "args": ["/path/to/whazaa/dist/index.js"],
      "env": {
        "WHAZAA_AUTH_DIR": "/custom/path/whatsapp-creds"
      }
    }
  }
}
```

---

## First-Time Pairing

1. Run Whazaa from a terminal so you can see the QR code:
   ```bash
   npx whazaa
   ```

2. A QR code prints on stderr. Open WhatsApp on your phone:
   - iOS: Settings -> Linked Devices -> Link a Device
   - Android: Menu (three dots) -> Linked Devices -> Link a Device

3. Scan the QR code. Whazaa logs `Connected. Phone: +XXXXXXXXXXX`.

4. Add the MCP config to Claude Code. Credentials are now saved; subsequent connections are automatic.

---

## Troubleshooting

**QR code not appearing**

Run Whazaa directly from a terminal (`npx whazaa`) rather than from within Claude Code's MCP runner, which may not show stderr. Once paired, restart Claude Code.

**"Logged out (401)" error**

Your session was invalidated (e.g. you unlinked the device in WhatsApp). Use the `whatsapp_login` tool or delete `~/.whazaa/auth/` and restart Whazaa to re-pair.

**Messages not received**

Call `whatsapp_receive` to drain the queue. Only messages sent to your own number (the self-chat / "Saved Messages" chat) are captured.

**Connection keeps dropping**

Whazaa uses exponential backoff to reconnect automatically. Check your network connection. If the problem persists, use `whatsapp_login` to re-establish the session.

**Multiple WhatsApp accounts**

Set `WHAZAA_AUTH_DIR` to a different directory for each account and run separate instances.

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
