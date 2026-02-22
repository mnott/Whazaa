# Whazaa Architecture

Technical reference for contributors and developers.

---

## Overview

Whazaa is a WhatsApp bridge for Claude Code. It has two main runtime components:

- **Watcher daemon** (`src/watch.ts`) — owns the Baileys/WhatsApp connection, serves IPC, delivers messages to iTerm2
- **MCP server** (`src/index.ts`) — thin IPC proxy started by Claude Code; no direct WhatsApp connection

Supporting modules:
- `src/ipc-client.ts` — client-side IPC transport used by the MCP server
- `src/auth.ts` — credentials directory resolution and QR code display
- `src/whatsapp.ts` — standalone Baileys connection used only by the setup wizard
- `src/tts.ts` — Kokoro-js TTS engine — text to WAV/OGG, local speaker playback

---

## Architecture diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Your phone                                                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ WhatsApp multi-device protocol
                           │ (Baileys WebSocket)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ Watcher daemon  (watch.ts)                                      │
│                                                                 │
│  connectWatcher()                                               │
│    ├── Baileys socket (sole owner)                              │
│    ├── messages.upsert handler                                  │
│    │     ├── self-chat filter                                   │
│    │     ├── deduplication (sentMessageIds)                     │
│    │     └── dispatchIncomingMessage()                          │
│    │           ├── clientQueues[activeClientId].push()          │
│    │           └── wake clientWaiters[activeClientId]           │
│    └── handleMessage()                                          │
│          ├── /relocate <path>  →  handleRelocate()              │
│          ├── /sessions         →  listClaudeSessions()          │
│          ├── /N                →  switch active session         │
│          ├── /N name           →  switch AND rename session     │
│          ├── dispatchIncomingMessage() (IPC queue)              │
│          └── deliverMessage() (iTerm2 via AppleScript)          │
│                                                                 │
│  startIpcServer()  →  /tmp/whazaa-watcher.sock                  │
│    Methods: register | status | send | receive | wait | login   │
│             chats | history | tts | speak | voice_config        │
│             rename | contacts                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Unix Domain Socket (NDJSON)
                           │ /tmp/whazaa-watcher.sock
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ MCP server  (index.ts)                                          │
│                                                                 │
│  WatcherClient (ipc-client.ts)                                  │
│    ├── sessionId = TERM_SESSION_ID ?? "unknown-session"         │
│    └── per-call socket: connect → send → receive → close        │
│                                                                 │
│  MCP tools (stdio JSON-RPC)                                     │
│    ├── whatsapp_status        →  watcher.status()               │
│    ├── whatsapp_send          →  watcher.send(message)          │
│    ├── whatsapp_receive       →  watcher.receive()              │
│    ├── whatsapp_wait          →  watcher.wait(timeoutMs)        │
│    ├── whatsapp_login         →  watcher.login()                │
│    ├── whatsapp_chats         →  watcher.chats(search?, limit?) │
│    ├── whatsapp_history       →  watcher.history(jid, count?)   │
│    ├── whatsapp_tts           →  watcher.tts(text, voice, jid?) │
│    ├── whatsapp_speak         →  watcher.speak(text, voice?)    │
│    └── whatsapp_voice_config  →  watcher.voiceConfig(action)    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ MCP stdio JSON-RPC
                           ▼
                    Claude Code (AI)
```

---

## IPC protocol

The watcher and MCP server communicate over a Unix Domain Socket at `/tmp/whazaa-watcher.sock` using NDJSON (newline-delimited JSON). Each call is a single request-response exchange over a fresh connection.

### Request format

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "sessionId": "w2:E4B9D3A1-...",
  "method": "send",
  "params": {
    "message": "Hello from Claude"
  }
}
```

- `id` — UUID generated per call, echoed in the response for correlation
- `sessionId` — the calling MCP server's `TERM_SESSION_ID` (set by iTerm2)
- `method` — one of the methods listed below
- `params` — method-specific parameters

### Response format

Success:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "ok": true,
  "result": { "preview": "Hello from Claude" }
}
```

Error:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "ok": false,
  "error": "WhatsApp is not connected."
}
```

### IPC methods

#### chats

Returns a list of conversations. The watcher first queries the WhatsApp Desktop macOS SQLite database; if that is unavailable it falls back to the Baileys in-memory store.

```json
// params: { "search": "alice", "limit": 50 }
// result: { "chats": [{ "jid": "15551234567@s.whatsapp.net", "name": "Alice", "lastMessage": 1708000000000 }] }
```

#### history

Returns message history for a conversation JID. Reads from the Desktop DB when available; otherwise requests history from Baileys on demand (phone must be online for the fallback path).

```json
// params: { "jid": "15551234567@s.whatsapp.net", "count": 50 }
// result: { "messages": [{ "body": "text", "timestamp": 1708000000000, "fromMe": false }] }
```

#### register

Registers the calling session as a known client and initializes its message queue. The watcher assigns a human-readable name derived from the session's working directory. No params. The client is not made active until it calls `send`.

```json
// params: {}
// result: { "registered": true }
```

#### rename

Updates the display name for a registered session.

```json
// params: { "name": "My Project" }
// result: { "success": true, "name": "My Project" }
```

#### status

Returns the current WhatsApp connection state.

```json
// params: {}
// result: { "connected": true, "phoneNumber": "1234567890", "awaitingQR": false }
```

#### send

Send a message via the watcher's Baileys socket. Sets the caller as the active session (routing future incoming messages to this client's queue). Markdown is converted to WhatsApp format before sending.

```json
// params: { "message": "**Hello** from Claude" }
// result: { "preview": "**Hello** from Claude" }
```

The preview is truncated to 80 characters for the response.

#### receive

Drain and return all messages in the caller's queue. Returns an empty array if none are queued.

```json
// params: {}
// result: { "messages": [{ "body": "text", "timestamp": 1708000000000 }] }
```

#### wait

Long-poll: blocks until a message arrives in the caller's queue or the timeout expires. Returns immediately if messages are already queued. If the client socket closes before the timeout, the waiter is cleaned up without sending a response.

```json
// params: { "timeoutMs": 120000 }
// result: { "messages": [] }   // on timeout
// result: { "messages": [{ "body": "text", "timestamp": 1708000000000 }] }
```

The IPC client uses a 310-second transport timeout (slightly above the max 300-second wait timeout) to ensure the socket is never closed before a valid long-poll response arrives.

#### login

Triggers a new Baileys QR pairing flow on the watcher. The QR code is printed to the watcher's stderr. Returns immediately — the caller does not wait for the scan to complete.

```json
// params: {}
// result: { "message": "QR pairing initiated. Check the watcher terminal..." }
```

#### tts

Converts text to speech using the Kokoro-js engine and sends the result as a WhatsApp voice note (OGG Opus). The TTS engine is lazy-initialized on first call and cached for subsequent calls. Requires ffmpeg for WAV to OGG conversion.

```json
// params: { "text": "Hello from Claude", "voice": "bm_fable", "jid": "15551234567@s.whatsapp.net" }
// result: { "voice": "bm_fable", "bytesSent": 24680, "targetJid": "15551234567@s.whatsapp.net" }
```

If `jid` is omitted, the voice note is sent to the caller's self-chat.

#### speak

Synthesizes text using the same Kokoro-js engine as `tts` and plays the audio through the Mac's local speakers via `afplay`. Non-blocking: playback runs in the background while the watcher continues. No WhatsApp connection required.

```json
// params: { "text": "Hello from Claude", "voice": "bm_fable" }
// result: { "success": true, "voice": "bm_fable" }
```

#### voice_config

Gets or updates the voice mode configuration. Configuration is persisted to `~/.whazaa/voice-config.json`.

```json
// params: { "action": "get" }
// result: { "success": true, "config": { "voiceMode": false, "localMode": false, "defaultVoice": "bm_fable", "personas": { "Nicole": "af_nicole" } } }

// params: { "action": "set", "updates": { "voiceMode": true, "defaultVoice": "af_bella" } }
// result: { "success": true, "config": { ... updated config ... } }
```

---

## Session routing

The watcher maintains per-client state to support multiple simultaneous Claude Code sessions.

```typescript
interface RegisteredSession {
  sessionId: string;       // TERM_SESSION_ID
  name: string;            // Human-readable name (derived from working directory)
  itermSessionId?: string; // iTerm2 session UUID (for tab title)
  registeredAt: number;    // timestamp
}

// Registry of all connected MCP sessions
const sessionRegistry = new Map<string, RegisteredSession>();

// The session ID of the most-recently-active MCP client
let activeClientId: string | null = null;

// Per-client incoming message queues
const clientQueues = new Map<string, QueuedMessage[]>();

// Per-client long-poll waiters
const clientWaiters = new Map<string, Array<(msgs: QueuedMessage[]) => void>>();
```

**Active session selection:** Whichever MCP client most recently called `send` becomes `activeClientId`. Incoming WhatsApp messages are routed to that client's queue only. Registration via `register` does not change the active client — it only initializes the queue.

**Named sessions:** When a session registers, the watcher assigns a display name derived from the Claude process's working directory (e.g. a session in `~/projects/myapp` registers as `myapp`). Names can be updated via `/N name` from WhatsApp or via the `rename` IPC method.

**Sticky routing:** Only the `/N` command changes the active session. Sending a message does NOT switch routing. This prevents accidental session-switches when Claude sends WhatsApp acks.

**iTerm2 delivery is unconditional:** The watcher types all incoming messages into iTerm2 regardless of which MCP client is active. IPC queue routing is additive — it does not replace iTerm2 delivery.

**Wake-up for wait:** When a new message arrives for `activeClientId`, any pending `wait` waiters are resolved immediately:

```typescript
function dispatchIncomingMessage(body: string, timestamp: number): void {
  if (activeClientId !== null) {
    clientQueues.get(activeClientId)!.push({ body, timestamp });

    const waiters = clientWaiters.get(activeClientId);
    if (waiters && waiters.length > 0) {
      const msgs = clientQueues.get(activeClientId)!.splice(0);
      const resolved = waiters.splice(0);
      for (const resolve of resolved) resolve(msgs);
    }
  }
}
```

---

## TTS pipeline

The `tts.ts` module implements local text-to-speech using [Kokoro-js](https://github.com/hexgrad/kokoro).

```
textToVoiceNote(text, voice?)
  │
  ├── ensureInitialized()       // lazy-load KokoroTTS singleton (~160 MB model, cached)
  ├── ttsInstance.generate()    // Float32 PCM at 24 kHz
  ├── audio.toWav()             // write temp WAV file
  ├── ffmpeg -c:a libopus       // convert WAV → OGG Opus (64 kbps, mono, 24 kHz)
  └── return OGG buffer         // ready for Baileys sendMessage({ audio, ptt: true })

speakLocally(text, voice?)
  │
  ├── ensureInitialized()       // same singleton
  ├── ttsInstance.generate()    // Float32 PCM
  ├── audio.toWav()             // write temp WAV file
  └── afplay <wavPath>          // macOS speaker playback (detached, non-blocking)
```

**Voices:** 28 Kokoro voices across four categories — American Female (11), American Male (9), British Female (4), British Male (4). Default: `bm_fable`.

**ffmpeg resolution:** The module resolves the ffmpeg binary at load time by checking `/opt/homebrew/bin/ffmpeg` and `/usr/local/bin/ffmpeg` before falling back to a bare `ffmpeg` PATH lookup. This ensures the watcher (which runs under launchd with a stripped PATH) can find Homebrew-installed ffmpeg.

**Temp file cleanup:** WAV and OGG temp files are always deleted in a `finally` block. The `speakLocally` cleanup happens asynchronously in the `afplay` close handler.

---

## Voice config persistence

Voice mode configuration is loaded at watcher startup and written on every update.

```
~/.whazaa/voice-config.json
  {
    "defaultVoice": "bm_fable",
    "voiceMode": false,
    "localMode": false,
    "personas": {
      "Nicole": "af_nicole",
      "George": "bm_george",
      "Daniel": "bm_daniel",
      "Fable":  "bm_fable"
    }
  }
```

`voiceMode: true` signals that Claude should respond with voice (via `whatsapp_tts` or `whatsapp_speak`). `localMode: true` selects local speaker playback over WhatsApp voice notes. The `personas` map lets Claude address voice responses to named voices (e.g. "speak as Nicole").

---

## Baileys connection lifecycle

The watcher holds the sole Baileys connection. It never shares the socket with MCP server instances.

```
openSocket()
  │
  ├── useMultiFileAuthState(authDir)   // load/create credentials
  ├── fetchLatestBaileysVersion()      // fetch current WA version from GitHub
  └── makeWASocket({ ... })
        │
        ├── creds.update   → saveCreds()
        ├── connection.update
        │     ├── qr         → printQR() to stderr
        │     ├── open       → set watcherStatus.connected = true
        │     └── close
        │           ├── 401 (loggedOut) → permanentlyLoggedOut = true, stop
        │           └── other           → scheduleReconnect()
        └── messages.upsert → self-chat filter → onMessage()
```

**Reconnection:** Exponential backoff from 1s to 60s max. Counter resets on successful open.

**Self-echo suppression:** When `send` is called, the outgoing message ID is added to `sentMessageIds` with a 30-second TTL. If that ID appears in `messages.upsert`, it is dropped silently.

**Self-chat detection:** Three checks in OR:
1. `remoteJid` (device-stripped) matches `selfJid` (`number@s.whatsapp.net`)
2. `remoteJid` (device-stripped) matches `selfLid` (Linked Identity JID, `@lid`)
3. `remoteJid` starts with the phone number string

All JIDs are stripped of device suffixes (`strip(':N@')`) before comparison.

---

## iTerm2 integration

The watcher uses AppleScript (`osascript`) for all iTerm2 interaction. All `spawnSync("osascript", ...)` calls have a 10-second timeout.

### Message delivery

`typeIntoSession(sessionId, text)` iterates all iTerm2 windows/tabs/sessions, finds the matching session ID, and types the text followed by a carriage return.

### Session resolution fallback chain

`deliverMessage(text)` uses this sequence:

1. **Cached session** — call `isClaudeRunningInSession(sessionId)`. If it returns `"running"`, type into it. Skip if `"shell"` (Claude has exited) or `"not_found"`.
2. **Search** — `findClaudeSession()` scans all sessions for a tab name containing "claude" (case-insensitive). Verify with `isClaudeRunningInSession`.
3. **Create** — `createClaudeSession()` opens a new iTerm2 tab (or window if none exist), runs `cd $HOME && claude`, and waits 8 seconds for Claude Code to boot.

### Claude running check

`isClaudeRunningInSession` uses the iTerm2 AppleScript `is at shell prompt` property. A session at the shell prompt means Claude has exited. A non-shell-prompt session is assumed to be running Claude.

### TTY-to-cwd resolution

`cwdFromTty(tty)` resolves the working directory of a Claude process on a given TTY:

1. `ps -eo pid,tty,comm` to find the Claude process PID for the TTY
2. `lsof -a -d cwd -p <pid> -Fn` to read the current working directory

Used by `listClaudeSessions()` to show meaningful paths in `/sessions` output and to derive session names on registration.

---

## WhatsApp commands (watcher-intercepted)

Before forwarding a message to iTerm2 or the IPC queue, `handleMessage` checks for watcher commands.

### /relocate (and /r)

Pattern: `/relocate <path>` or `/r <path>`

1. Tilde-expand the path (`expandTilde`)
2. `findClaudeInDirectory(expandedPath)` — scan sessions for one with `name.includes("claude")` and `session.path === targetDir`
3. If found, focus that session in iTerm2 and set it as active
4. If not found, open a new iTerm2 tab with `cd "<path>" && claude`
5. Update `activeSessionId`

### /sessions (and /s)

1. `listClaudeSessions()` — return all sessions whose tab name contains "claude"
2. Build a numbered list, marking the currently active session with `*`
3. Include the session's registered name and working directory
4. Send the list to WhatsApp via `watcherSendMessage`
5. User replies `/1`, `/2`, etc. to switch active session
6. User replies `/1 My Project` to switch AND rename the session

### /N (numeric session switch)

Pattern: `/1`, `/2`, `/3`, ...

1. Look up the Nth session in `listClaudeSessions()` order
2. Set it as `activeClientId` (sticky routing)
3. Optionally rename if text follows the number (e.g. `/2 Backend`)

---

## Setup wizard

`npx whazaa setup` runs through `index.ts → setup()` using `whatsapp.ts` (not the watcher):

1. Write/update `~/.claude/.mcp.json` with the whazaa entry
2. If `~/.whazaa/auth/creds.json` exists, attempt a verification connection with a 10-second timeout. Race: connected / logout / QR / timeout
3. If already connected: exit successfully
4. If stale credentials: delete auth dir, fall through to pairing
5. If timeout (another instance running): warn and exit
6. Call `triggerLogin()` to start a fresh Baileys connection
7. Open QR code in browser (`auth.ts → printQRBrowser`)
8. `waitForConnection()` blocks until pairing completes
9. 5-second sync delay, then exit

The setup wizard uses `whatsapp.ts` rather than `watch.ts` because it needs a temporary, standalone connection that can be verified and torn down cleanly without starting the full watcher daemon.

---

## Stale instance cleanup

When the MCP server starts in normal mode (not setup/uninstall/watch), it does not kill stale instances — this was removed in favor of relying on the watcher's IPC socket to serialize access.

Previous MCP server instances that are still running will compete for the IPC socket but do not hold WhatsApp connections (the watcher does). Multiple MCP server instances sending to the same watcher is safe.

---

## File structure

```
src/
  index.ts        Entry point. CLI dispatch (setup/uninstall/watch) + MCP server
  watch.ts        Watcher daemon: Baileys connection, IPC server, iTerm2 delivery
  ipc-client.ts   WatcherClient: per-call socket transport for IPC methods
  auth.ts         Auth directory resolution, QR display (terminal + browser)
  whatsapp.ts     Standalone Baileys connection (setup wizard only)
  desktop-db.ts   Readonly SQLite reader for WhatsApp Desktop macOS database
  tts.ts          Kokoro-js TTS engine — text to WAV/OGG, local speaker playback

scripts/
  watcher-ctl.sh  launchd agent install/start/stop/status helper

dist/             Compiled JavaScript output (generated by tsc)
```

---

## Desktop DB integration

The `chats` and `history` IPC methods read from WhatsApp Desktop's local SQLite database before falling back to Baileys.

**Database path:**
```
~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
```

**Strategy:**

| Source | When used | What it provides |
|--------|-----------|-----------------|
| Desktop DB (primary) | WhatsApp Desktop is installed and has synced | Complete conversation history; no phone connection required |
| Baileys store (fallback) | Desktop DB not found or unreadable | ~100–150 most recent chats; phone must be online for on-demand history fetch |

**Why two sources:** The Desktop DB contains full message history synced from the phone over time. Baileys only keeps recent messages in its in-memory or persisted store, so the Desktop DB is strongly preferred when available.

`desktop-db.ts` uses `better-sqlite3` for synchronous, readonly access. It never writes to the database.

---

## stdout discipline

The MCP server communicates with Claude Code over stdin/stdout using the JSON-RPC protocol. Any non-JSON bytes on stdout break the protocol silently.

Rules enforced throughout the codebase:
- All debug output, errors, and QR codes go to `process.stderr`
- `console.log` is only used in setup/uninstall/watch modes where stdout is a terminal
- Baileys uses a `pino` logger configured to `level: "silent"` to prevent internal log output
- `printQRInTerminal: false` in Baileys options prevents the default QR terminal output

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server and stdio transport |
| `@whiskeysockets/baileys` | WhatsApp Web multi-device protocol |
| `better-sqlite3` | Readonly access to WhatsApp Desktop macOS SQLite database |
| `kokoro-js` | Local TTS engine (Kokoro-82M ONNX model, 28 voices) |
| `pino` | Logger (used silenced, required by Baileys) |
| `qrcode` | SVG QR generation for browser display |
| `qrcode-terminal` | ASCII QR rendering for terminal display |
| `zod` | MCP tool parameter schema validation |

**System requirements:**
- `ffmpeg` — required for WAV to OGG Opus conversion in `whatsapp_tts`; must be installed separately (e.g. `brew install ffmpeg`)
- `afplay` — macOS built-in audio player, used by `whatsapp_speak`
