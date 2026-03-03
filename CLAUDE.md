# Whazaa

WhatsApp MCP bridge for Claude Code — bidirectional self-chat via Baileys.

## Build

```bash
npm install
npm run build    # tsc -> dist/
```

## Architecture

- `src/index.ts` — MCP server + tool definitions
- `src/watcher/` — WhatsApp connection, message handling, IPC
- `src/ipc-client.ts` — WatcherClient for socket communication
- Shared core: `aibroker` (logging, state, TTS, IPC, persistence)
- Watcher socket: `/tmp/whazaa-watcher.sock`
- Auth data: `~/.whazaa/auth/`

## Key Rules

- dist/ is gitignored — always rebuild after pulling
- MCP schema loads at Claude Code session start — restart session after tool changes
- Never import baileys in aibroker (hard boundary)
- npm package: `whazaa` (unscoped)
- Test with `whatsapp_status` tool after any watcher changes
