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

## Troubleshooting

**"Logged out (401)" error**

Your session was invalidated (e.g. you unlinked the device in WhatsApp). Run `npx -y whazaa setup` again to re-pair.

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
