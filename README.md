# Whazaa

Your phone is now a Claude Code terminal. Send a WhatsApp message, Claude gets it. Claude responds, you see it on WhatsApp. Text, images, voice notes — in both directions.

Dictate a voice note while driving and Claude starts coding. Send an image from your phone and Claude interprets it. Get spoken responses back in any of 28 voices — all synthesized locally, nothing leaves your machine. Manage multiple Claude sessions from your couch with `/s`, switch between them, or `/kill` a stuck one and restart it fresh.

One command to set up. Zero cloud dependencies for voice. Works with any WhatsApp account.

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
                            whatsapp_tts / whatsapp_speak / whatsapp_voice_config
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

## Prerequisites

- Node.js >= 18
- macOS with [iTerm2](https://iterm2.com/) for the `watch` command and iTerm2 delivery
- [ffmpeg](https://ffmpeg.org/) for TTS voice note conversion (WAV to OGG Opus)
- [Whisper](https://github.com/openai/whisper) for voice note transcription (optional — only needed to receive audio/voice messages)

Install ffmpeg and Whisper via Homebrew:

```bash
brew install ffmpeg
pip install openai-whisper
```

The default transcription model is `large-v3-turbo`. Override it with the `WHAZAA_WHISPER_MODEL` environment variable (e.g. `WHAZAA_WHISPER_MODEL=base` for faster but less accurate transcription).

The Kokoro TTS model (~160 MB) is downloaded automatically on first use of `whatsapp_tts` or `whatsapp_speak` and cached locally. Subsequent calls are fast.

---

## How to Use

Once Whazaa is set up, you talk to Claude in plain language. You never need to know about tool names or parameters — just say what you want.

### Sending Messages

Tell Claude what to say and to whom:

- "Send Randolf a message saying I'll be late"
- "Tell Nicole the meeting is moved to 3pm"
- "Message my self-chat: pick up milk"

If you don't say who to send it to, Claude sends to your own WhatsApp — useful for notes to yourself.

### Voice Notes

Claude can send a WhatsApp voice note instead of a text message:

- "Send me a voice note saying good morning"
- "Send a voice note to Nicole saying I'm on my way"
- "Tell George via voice note that dinner is at 7"

You can choose whose voice to use:

- "Say it as George" or "Use George's voice"
- "Send that as a voice note in Daniel's voice"
- "Use Nicole's voice for this"

See the full voice list at the bottom of this section.

### Listening Locally (Mac Speakers)

Claude can speak out loud through your Mac — no WhatsApp needed:

- "Say that out loud"
- "Read that to me"
- "Talk to me" or "Say it through the speakers"

Great for when you want an audio response right now, without sending anything to your phone.

### Voice Mode — Hands-Free

Instead of switching to voice one message at a time, you can put Claude into a persistent voice mode so every response comes back as audio automatically.

**Voice notes to your phone:**

- "Voice mode on" or "Respond via voice" — every Claude response becomes a WhatsApp voice note
- "Back to text" or "Text mode" — back to normal text messages

**Audio through your Mac speakers:**

- "Talk to me locally" or "Local voice mode" — every response plays through your speakers
- "Back to text" — turns it off

Voice mode is perfect for driving, cooking, or any time you can't look at a screen.

### Switching Voices

The default voice is Fable (British male). You can switch voices by name:

- "Hi Nicole" — switches to Nicole's voice
- "Hi George" — switches to George's voice
- "Hi Daniel" — switches to Daniel's voice
- "Default voice" or "Back to default" — back to Fable

Voice switches are remembered for the session. You can also set a different default in the config.

### Chat History

Claude can look up your WhatsApp conversations directly — it reads from WhatsApp Desktop's local database, so it's fast and doesn't require your phone to be online:

- "Show me my chats" — lists your recent conversations
- "Show messages from Randolf" — shows recent messages from that contact
- "What did Nicole say last?" — Claude finds the conversation and reads it

### Sending Images

Send an image to your WhatsApp self-chat and Claude sees it. The watcher downloads the image and types the file path into your active Claude session — Claude reads it natively.

- Send an image from your phone with the caption "What's this error?"
- Send a photo of a whiteboard with "Transcribe this"
- Send a design mockup with "Implement this layout"

If the image has a caption, it arrives on the same line as the path so Claude gets both the image and your instruction in one go. Supports JPEG, PNG, WebP, GIF, and stickers.

### Voice Notes In

Send a voice note to your self-chat and Claude receives the transcription. The watcher downloads the audio, runs it through Whisper locally (`large-v3-turbo` model), and types the transcript into your Claude session.

- Record a voice note while walking: "Add a retry mechanism to the API client" — Claude gets the text and starts working
- Dictate a bug report: "The login page crashes when I tap submit without filling in email"
- Voice notes from other contacts are also transcribed and available via `whatsapp_receive`

Works in English, German, and 90+ other languages. Transcription runs entirely on your Mac — nothing leaves your machine.

### Screenshots

Send `/ss` from your phone and the watcher captures the active Claude session's iTerm2 window and sends it back to WhatsApp as an image. Useful for checking on long-running tasks without switching to your desk.

The watcher raises the correct window and selects the correct tab before capturing, so you always get the right session — even if iTerm2 is in the background or another window is on top. If no session is tracked yet (e.g. after a watcher restart), it auto-discovers the first live Claude session.

### Session Management (from Your Phone)

You can control your Claude sessions from WhatsApp itself. Send these commands to your self-chat:

- `/s` — see a list of your active Claude sessions (each Claude window is a session)
- `/2` — switch to session 2
- `/2 Cooking Project` — switch to session 2 and name it

This is useful when you have multiple Claude windows open for different projects.

### Available Voices

28 voices across four categories:

| Category | Voices |
|----------|--------|
| American Female | af_heart, af_alloy, af_aoede, af_bella, af_jessica, af_kore, af_nicole, af_nova, af_river, af_sarah, af_sky |
| American Male | am_adam, am_echo, am_eric, am_fenrir, am_liam, am_michael, am_onyx, am_puck, am_santa |
| British Female | bf_alice, bf_emma, bf_isabella, bf_lily |
| British Male | bm_daniel, **bm_fable** (default), bm_george, bm_lewis |

All TTS synthesis runs locally on your Mac — no audio is ever sent to any external service.

---

## MCP tools

Once configured, Claude Code has ten tools available:

| Tool | Description |
|------|-------------|
| `whatsapp_status` | Check connection state and phone number |
| `whatsapp_send` | Send a message to your WhatsApp self-chat (or any contact) |
| `whatsapp_receive` | Drain all queued incoming messages |
| `whatsapp_wait` | Block until a message arrives (up to timeout) |
| `whatsapp_login` | Trigger a new QR pairing flow |
| `whatsapp_chats` | List WhatsApp conversations (from Desktop DB or Baileys) |
| `whatsapp_history` | Fetch message history for a conversation |
| `whatsapp_tts` | Convert text to speech and send as a WhatsApp voice note |
| `whatsapp_speak` | Speak text aloud through Mac speakers (no WhatsApp needed) |
| `whatsapp_voice_config` | Get or set voice mode configuration |

### whatsapp_send

Sends a message to your self-chat. Supports Markdown formatting converted to WhatsApp format:

- `**bold**` becomes `*bold*`
- `*italic*` becomes `_italic_`
- `` `code` `` becomes ` ```code``` `

Optionally send as a TTS voice note by setting the `voice` parameter:

```
voice='true'         Use the configured default voice
voice='bm_george'    Use a specific voice
```

Supports an optional `recipient` parameter: a phone number (e.g. `+41764502698`), WhatsApp JID, or contact name.

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

### whatsapp_tts

Converts text to speech and sends it as a WhatsApp voice note.

- Uses [Kokoro-js](https://github.com/hexgrad/kokoro) — 100% local, no internet required after first run
- The model (~160 MB) is downloaded on first use and cached locally
- Requires `ffmpeg` for WAV to OGG Opus conversion
- Without a recipient, sends to your self-chat; with a recipient, sends to any contact or group

**Available voices (28 total):**

| Category | Voices |
|----------|--------|
| American Female | `af_heart`, `af_alloy`, `af_aoede`, `af_bella`, `af_jessica`, `af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky` |
| American Male | `am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`, `am_puck`, `am_santa` |
| British Female | `bf_alice`, `bf_emma`, `bf_isabella`, `bf_lily` |
| British Male | `bm_daniel`, `bm_fable`, `bm_george`, `bm_lewis` |

Default voice: `bm_fable`

Parameters:
- `message` (required) — text to convert to speech
- `voice` (optional) — voice name from the table above; omit to use the configured default
- `recipient` (optional) — phone number, JID, or contact name; omit for self-chat

### whatsapp_speak

Same TTS engine as `whatsapp_tts`, but plays audio through the Mac's speakers instead of sending a WhatsApp voice note. No WhatsApp connection required. Audio plays in the background without blocking other operations.

Parameters:
- `message` (required) — text to speak aloud
- `voice` (optional) — voice name (same list as `whatsapp_tts`); omit to use the configured default

### whatsapp_voice_config

Gets or sets the voice mode configuration. Configuration is persisted to `~/.whazaa/voice-config.json` and survives watcher restarts.

Parameters:
- `action` (required) — `'get'` to read current config, `'set'` to update it
- `voiceMode` (optional) — `true` to enable voice responses, `false` to use text
- `localMode` (optional) — when `true` and `voiceMode` is `true`, use `whatsapp_speak` (Mac speakers) instead of `whatsapp_tts` (WhatsApp voice notes)
- `defaultVoice` (optional) — default voice name (e.g. `'bm_fable'`)
- `personas` (optional) — map of names to voice IDs (e.g. `{"Nicole": "af_nicole", "George": "bm_george"}`)

Default personas: Nicole → `af_nicole`, George → `bm_george`, Daniel → `bm_daniel`, Fable → `bm_fable`

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
| `/sessions` or `/s` | List open Claude sessions with names; reply `/N` to switch, `/N name` to switch and rename |
| `/ss` or `/screenshot` | Capture the active Claude session's iTerm2 window and send it back as an image |
| `/kill N` or `/k N` | Kill a stuck Claude session and restart it fresh in the same directory |
| _(image)_ | Send an image — the watcher downloads it and types the path into Claude |
| _(voice note)_ | Send a voice note — the watcher transcribes it with Whisper and types the text into Claude |

### /relocate

```
/relocate ~/projects/myapp
/r ~/projects/myapp
```

If a Claude session is already open in that directory, Whazaa focuses it instead of creating a new tab. Tilde expansion is supported.

After relocating, subsequent messages are delivered to the new session.

### /sessions

Reply `/s` to get a numbered list of open Claude sessions with their working directories and names. The currently active session is marked with `*`.

Switch to a session with `/1`, `/2`, etc. Switch and rename in one step with `/1 My Project`. Session names are stored as iTerm2 session variables and persist across watcher restarts.

### /ss (screenshot)

```
/ss
/screenshot
```

Captures the active Claude session's iTerm2 window and sends it back as a WhatsApp image. The watcher finds the session, selects its tab, raises its window to the foreground, waits for macOS to redraw, then captures the screen region.

Session resolution for screenshots follows this priority:

1. **MCP registry** — the session registered by the active MCP client (most precise)
2. **Active session** — set by `/N` switch commands
3. **Auto-discover** — scans iTerm2 for any session running Claude
4. **Frontmost window** — last resort if no Claude sessions exist

If you have multiple Claude sessions, use `/s` then `/N` to select the one you want before taking a screenshot.

### /kill

```
/kill 1
/k 2
```

Kill a stuck Claude session (e.g. one that ran out of context and is unresponsive) and restart it. The watcher finds the Claude process via the session's TTY, sends SIGTERM, waits for the shell prompt to return, then types `claude` to restart in the same directory.

Use `/s` first to see which number corresponds to which session.

### Image forwarding

Send an image to your WhatsApp self-chat and the watcher will download it to a temp file and type the path into your active Claude session:

```
/tmp/whazaa-img-a3f92b.jpg
```

If the image has a caption, it is appended on the same line:

```
/tmp/whazaa-img-a3f92b.jpg Describe this image
```

Claude Code can read image files natively, so it will process the image immediately without any extra steps.

Supported formats: JPEG, PNG, WebP, GIF, and stickers.

---

## Multiple sessions

Whazaa supports multiple simultaneous Claude Code windows. Each MCP server instance registers its `TERM_SESSION_ID` when it starts. Whichever session most recently called `whatsapp_send` becomes the active recipient for incoming messages.

The watcher maintains a separate incoming message queue for each registered session. If no session has sent a message yet, the first registered session is used.

Sessions register with a name derived from the working directory (e.g. a Claude session in `~/projects/myapp` registers as `myapp`). Use `/s` to see all sessions and `/N name` to assign a custom name.

Routing is sticky: only the `/N` command changes the active session, not sending a message. This means switching sessions from your phone requires an explicit `/N` command.

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
| `WHAZAA_TTS_VOICE` | `bm_fable` | Default TTS voice (overridden by voice-config.json) |

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

**TTS fails with "ffmpeg not found"**

Install ffmpeg: `brew install ffmpeg`. The watcher searches `/opt/homebrew/bin/ffmpeg` and `/usr/local/bin/ffmpeg` before falling back to the system PATH, so Homebrew installs are found even in restricted launchd environments.

**First TTS call takes a long time**

The Kokoro model (~160 MB) is downloaded on first use and cached locally. Subsequent calls are fast. Check your network if the download stalls.

---

## Security

- Session credentials are stored locally in `~/.whazaa/auth/`. Treat them like passwords — they grant full access to your WhatsApp Web session.
- Whazaa only reads and sends messages in your self-chat. It cannot access other conversations.
- No data is sent to any third-party service. All communication is directly with WhatsApp's servers via Baileys.
- TTS synthesis is fully local (Kokoro-js runs on-device). Audio never leaves your machine.

---

## Requirements

- Node.js >= 18
- WhatsApp account (any — multi-device support is standard)
- macOS with [iTerm2](https://iterm2.com/) for the `watch` command and iTerm2 delivery
- [ffmpeg](https://ffmpeg.org/) for TTS voice note sending (`whatsapp_tts`)

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
