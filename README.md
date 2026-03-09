# Whazaa

Your phone is now a Claude Code terminal. Send a WhatsApp message, Claude gets it. Claude responds, you see it on WhatsApp. Text, images, voice notes -- in both directions.

Dictate a voice note while driving and Claude starts coding. Send an image from your phone and Claude interprets it. Get spoken responses back in any of 28 voices -- all synthesized locally, nothing leaves your machine. Take complete control of your computer using `/t` to open and manage any number of terminal sessions. Manage multiple Claude sessions from your couch with `/s`, switch between them, or `/kill` a stuck one and restart it fresh. Navigate interactive TUIs, menus, and shell prompts from your phone using keyboard control commands like `/cc`, `/esc`, `/up`, `/down`, and `/pick N`. Take screenshots of any session using `/ss` and have the screenshot sent to you via WhatsApp.

One command to set up. Zero cloud dependencies for voice. Works with any WhatsApp account.

---

## How it works

Whazaa is a thin **adapter plugin** for the [AIBroker](https://github.com/mnott/AIBroker) hub. It owns exactly one thing: the WhatsApp connection via the [Baileys](https://github.com/WhiskeySockets/Baileys) library.

Everything else -- commands, session management, TTS/STT, screenshots, image generation, vision, and MCP tools -- is owned by the AIBroker hub daemon. Whazaa registers with the hub on startup via a Unix Domain Socket and heartbeats every 30 seconds. Without AIBroker running, Whazaa does not function.

```
AIBroker Hub (daemon, launchd: com.aibroker.daemon)
|-- Commands, session management, TTS/STT, screenshots, image gen
|-- Unified MCP server (whatsapp_*, telegram_*, pailot_*, aibroker_*)
|-- IPC socket: /tmp/aibroker.sock
|
|-- Whazaa adapter (this package, launchd: com.whazaa.watcher)
|   └-- Baileys WhatsApp connection only
|
|-- Telex adapter (Telegram, launchd: com.telex.watcher)
|   └-- GramJS MTProto connection only
|
└-- PAILot (iOS app, WebSocket on port 8765)
```

When a WhatsApp message arrives, Whazaa forwards it to the hub over IPC. The hub handles delivery to the active Claude session (by typing into iTerm2 via AppleScript), session routing, media transcription, and all command processing. Whazaa is purely a transport layer.

For more detail on hub architecture, see the [AIBroker repository](https://github.com/mnott/AIBroker).

---

## Quick start

Tell Claude Code:

> Clone https://github.com/mnott/Whazaa and set it up for me

Claude clones the repo, finds the setup skill, and handles everything autonomously -- prerequisites, build, launchd registration, and WhatsApp pairing. The only thing you do is scan a QR code with your phone when prompted.

### Alternative: npx

If you prefer a traditional install without cloning:

```bash
npx -y whazaa setup
```

This will:
1. Verify that AIBroker is installed and running
2. Register Whazaa as a launchd agent (`com.whazaa.watcher`)
3. Open a QR code in your browser
4. You scan it with WhatsApp: Settings > Linked Devices > Link a Device
5. Credentials are saved to `~/.whazaa/auth/`

Restart Claude Code. Whazaa connects automatically from now on.

---

## Prerequisites

- Node.js >= 18
- **[AIBroker](https://github.com/mnott/AIBroker) daemon running** (required -- Whazaa is an adapter plugin and cannot run standalone)
- macOS with [iTerm2](https://iterm2.com/) for iTerm2 delivery
- [ffmpeg](https://ffmpeg.org/) for TTS voice note conversion (WAV to OGG Opus)
- [Whisper](https://github.com/openai/whisper) for voice note transcription (optional -- only needed to receive audio/voice messages)

Install ffmpeg and Whisper via Homebrew:

```bash
brew install ffmpeg
pip install openai-whisper
```

The default transcription model is `large-v3-turbo`. Override it with the `WHAZAA_WHISPER_MODEL` environment variable (e.g. `WHAZAA_WHISPER_MODEL=base` for faster but less accurate transcription).

The Kokoro TTS model (~160 MB) is downloaded automatically on first use and cached locally. Subsequent calls are fast.

---

## How to Use

Once Whazaa is set up, you talk to Claude in plain language. You never need to know about tool names or parameters -- just say what you want.

### Sending Messages

Tell Claude what to say and to whom:

- "Send Randolf a message saying I'll be late"
- "Tell Nicole the meeting is moved to 3pm"
- "Message my self-chat: pick up milk"

If you don't say who to send it to, Claude sends to your own WhatsApp -- useful for notes to yourself.

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

Claude can speak out loud through your Mac -- no WhatsApp needed:

- "Say that out loud"
- "Read that to me"
- "Talk to me" or "Say it through the speakers"

Great for when you want an audio response right now, without sending anything to your phone.

### Voice Mode -- Hands-Free

Instead of switching to voice one message at a time, you can put Claude into a persistent voice mode so every response comes back as audio automatically.

**Voice notes to your phone:**

- "Voice mode on" or "Respond via voice" -- every Claude response becomes a WhatsApp voice note
- "Back to text" or "Text mode" -- back to normal text messages

**Audio through your Mac speakers:**

- "Talk to me locally" or "Local voice mode" -- every response plays through your speakers
- "Back to text" -- turns it off

Voice mode is perfect for driving, cooking, or any time you can't look at a screen.

### Switching Voices

The default voice is Fable (British male). You can switch voices by name:

- "Hi Nicole" -- switches to Nicole's voice
- "Hi George" -- switches to George's voice
- "Hi Daniel" -- switches to Daniel's voice
- "Default voice" or "Back to default" -- back to Fable

Voice switches are remembered for the session. You can also set a different default in the config.

### Chat History

Claude can look up your WhatsApp conversations directly -- it reads from WhatsApp Desktop's local database, so it's fast and doesn't require your phone to be online:

- "Show me my chats" -- lists your recent conversations
- "Show messages from Randolf" -- shows recent messages from that contact
- "What did Nicole say last?" -- Claude finds the conversation and reads it

### Sending Images

Send an image to your WhatsApp self-chat and Claude sees it. The hub downloads the image and types the file path into your active Claude session -- Claude reads it natively.

- Send an image from your phone with the caption "What's this error?"
- Send a photo of a whiteboard with "Transcribe this"
- Send a design mockup with "Implement this layout"

If the image has a caption, it arrives on the same line as the path so Claude gets both the image and your instruction in one go. Supports JPEG, PNG, WebP, GIF, and stickers.

### Voice Notes In

Send a voice note to your self-chat and Claude receives the transcription. The hub downloads the audio, runs it through Whisper locally (`large-v3-turbo` model), and types the transcript into your Claude session.

- Record a voice note while walking: "Add a retry mechanism to the API client" -- Claude gets the text and starts working
- Dictate a bug report: "The login page crashes when I tap submit without filling in email"
- Voice notes from other contacts are also transcribed and available via `whatsapp_receive`

Works in English, German, and 90+ other languages. Transcription runs entirely on your Mac -- nothing leaves your machine.

### Screenshots

Send `/ss` from your phone and the hub captures the active Claude session's iTerm2 window and sends it back to WhatsApp as an image. Useful for checking on long-running tasks without switching to your desk.

The hub raises the correct window and selects the correct tab before capturing, so you always get the right session -- even if iTerm2 is in the background or another window is on top.

### Session Management (from Your Phone)

You can control your Claude sessions from WhatsApp itself. Send these commands to your self-chat:

- `/s` -- see a list of your active Claude sessions (each Claude window is a session)
- `/2` -- switch to session 2
- `/2 Cooking Project` -- switch to session 2 and name it

This is useful when you have multiple Claude windows open for different projects. Session state is managed entirely by the AIBroker hub.

### Available Voices

28 voices across four categories:

| Category | Voices |
|----------|--------|
| American Female | af_heart, af_alloy, af_aoede, af_bella, af_jessica, af_kore, af_nicole, af_nova, af_river, af_sarah, af_sky |
| American Male | am_adam, am_echo, am_eric, am_fenrir, am_liam, am_michael, am_onyx, am_puck, am_santa |
| British Female | bf_alice, bf_emma, bf_isabella, bf_lily |
| British Male | bm_daniel, **bm_fable** (default), bm_george, bm_lewis |

All TTS synthesis runs locally on your Mac -- no audio is ever sent to any external service.

---

## MCP tools

The `whatsapp_*` tools are served by the **AIBroker unified MCP server** -- not by Whazaa itself. Whazaa has no MCP server. Claude Code connects to AIBroker's MCP server, which routes WhatsApp tool calls to the Whazaa adapter over IPC.

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

Lists WhatsApp conversations. Reads from the WhatsApp Desktop macOS SQLite database for a complete inbox view, falling back to Baileys in-memory store (~100-150 recent chats) if the Desktop app is not installed.

Parameters:
- `search` (optional) -- filter results by contact name or phone number
- `limit` (optional, default 50, max 200) -- maximum number of conversations to return

Returns conversation JIDs, display names, and last-message timestamps. JIDs can be passed directly to `whatsapp_history`.

### whatsapp_history

Fetches message history for a conversation. Reads from the WhatsApp Desktop macOS SQLite database (no phone connection required). Falls back to requesting history from Baileys on demand, which requires the phone to be online.

Parameters:
- `jid` (required) -- the conversation JID (e.g. `15551234567@s.whatsapp.net`), as returned by `whatsapp_chats`
- `count` (optional, default 50, max 500) -- number of messages to return (most recent first)

### whatsapp_tts

Converts text to speech and sends it as a WhatsApp voice note.

- Uses [Kokoro-js](https://github.com/hexgrad/kokoro) -- 100% local, no internet required after first run
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
- `message` (required) -- text to convert to speech
- `voice` (optional) -- voice name from the table above; omit to use the configured default
- `recipient` (optional) -- phone number, JID, or contact name; omit for self-chat

### whatsapp_speak

Same TTS engine as `whatsapp_tts`, but plays audio through the Mac's speakers instead of sending a WhatsApp voice note. No WhatsApp connection required. Audio plays in the background without blocking other operations.

Parameters:
- `message` (required) -- text to speak aloud
- `voice` (optional) -- voice name (same list as `whatsapp_tts`); omit to use the configured default

### whatsapp_voice_config

Gets or sets the voice mode configuration. Configuration is persisted and survives adapter restarts.

Parameters:
- `action` (required) -- `'get'` to read current config, `'set'` to update it
- `voiceMode` (optional) -- `true` to enable voice responses, `false` to use text
- `localMode` (optional) -- when `true` and `voiceMode` is `true`, use `whatsapp_speak` (Mac speakers) instead of `whatsapp_tts` (WhatsApp voice notes)
- `defaultVoice` (optional) -- default voice name (e.g. `'bm_fable'`)
- `personas` (optional) -- map of names to voice IDs (e.g. `{"Nicole": "af_nicole", "George": "bm_george"}`)

Default personas: Nicole -> `af_nicole`, George -> `bm_george`, Daniel -> `bm_daniel`, Fable -> `bm_fable`

---

## CLI commands

```bash
# First-time setup: verify AIBroker, register launchd agent, and pair with WhatsApp
npx -y whazaa setup

# Start the Whazaa adapter manually (connects to AIBroker hub on /tmp/aibroker.sock)
npx whazaa watch

# Remove launchd agent and stored credentials
npx -y whazaa uninstall
```

---

## launchd agent

Whazaa runs as the `com.whazaa.watcher` launchd agent. It connects to the AIBroker hub at startup and heartbeats every 30 seconds to maintain its registration.

### Manual control

```bash
scripts/watcher-ctl.sh start    # Install and start as launchd agent
scripts/watcher-ctl.sh stop     # Stop and unload
scripts/watcher-ctl.sh status   # Show running state
```

The agent uses `KeepAlive: true` and `ProcessType: Interactive`. The Interactive process type and `LimitLoadToSessionType: Aqua` are required so the adapter process can run in the macOS GUI session context.

> **Note:** Whazaa requires AIBroker to be running before it starts. If the hub is not available, Whazaa will retry the IPC connection on a backoff schedule.

---

## WhatsApp commands

Certain messages sent from your phone are intercepted by the hub and handled as commands rather than forwarded to Claude.

| Command | Description |
|---------|-------------|
| `/relocate <path>` or `/r <path>` | Open a new iTerm2 tab in the given directory and start Claude there |
| `/t` or `/t <command>` | Open a plain terminal tab (no Claude); optionally run a command |
| `/sessions` or `/s` | List open sessions (Claude and terminal) with names; reply `/N` to switch, `/N name` to switch and rename |
| `/ss` or `/screenshot` | Capture the active Claude session's iTerm2 window and send it back as an image |
| `/kill N` or `/k N` | Kill a stuck session (Claude: restarts it; terminal: closes the tab) |
| `/cc` | Send Ctrl+C to the active session (interrupt) |
| `/esc` | Send Escape to the active session |
| `/enter` | Send Enter/Return to the active session |
| `/tab` | Send Tab to the active session (trigger completion) |
| `/up` `/down` `/left` `/right` | Send arrow keys to the active session |
| `/pick N` | Select menu option N: send down arrow (N-1) times then Enter |
| _(image)_ | Send an image -- the hub downloads it and types the path into Claude |
| _(voice note)_ | Send a voice note -- the hub transcribes it with Whisper and types the text into Claude |

### /relocate

```
/relocate ~/projects/myapp
/r ~/projects/myapp
```

If a Claude session is already open in that directory, the hub focuses it instead of creating a new tab. Tilde expansion is supported.

After relocating, subsequent messages are delivered to the new session.

### /t (terminal)

```
/t
/t ls -la
/t htop
```

Opens a plain terminal tab in iTerm2 -- no Claude, just a shell. If you include a command, it runs immediately. The new tab is registered so it appears in `/s` alongside your Claude sessions, and you can switch to it with `/N`.

Once a terminal tab is active, any text you send from WhatsApp is typed directly into it. This gives you full control of your computer from your phone -- run shell commands, monitor processes, tail logs, or do anything you'd do at a terminal.

Switch back to a Claude session anytime with `/N`.

### /sessions

Reply `/s` to get a numbered list of all open sessions -- both Claude sessions and terminal tabs opened via `/t`. The currently active session is marked. Terminal sessions are labeled `[terminal]`.

Switch to a session with `/1`, `/2`, etc. Switch and rename in one step with `/1 My Project`. Session names persist across adapter restarts.

### /ss (screenshot)

```
/ss
/screenshot
```

Captures the active Claude session's iTerm2 window and sends it back as a WhatsApp image. The hub finds the session, selects its tab, raises its window to the foreground, waits for macOS to redraw, then captures the screen region.

Session resolution for screenshots follows this priority:

1. **Active session** -- set by `/N` switch commands
2. **Auto-discover** -- scans iTerm2 for any session running Claude
3. **Frontmost window** -- last resort if no Claude sessions exist

If you have multiple Claude sessions, use `/s` then `/N` to select the one you want before taking a screenshot.

### /kill

```
/kill 1
/k 2
```

Kill a session by its number from `/s`. Behavior depends on session type:

- **Claude session** -- sends SIGTERM to the Claude process, waits for the shell prompt to return, then types `claude` to restart in the same directory.
- **Terminal session** -- sends Ctrl+C to interrupt any running process, then closes the iTerm2 tab and removes it from the session list.

Use `/s` first to see which number corresponds to which session.

### Keyboard control

Send raw keystrokes to the active iTerm2 session without forwarding text to Claude. Useful for controlling interactive TUIs, navigating menus, and cancelling operations from your phone.

| Command | Keystroke | Use case |
|---------|-----------|----------|
| `/cc` | Ctrl+C | Interrupt a running process |
| `/esc` | Escape | Dismiss a dialog, exit a mode |
| `/enter` | Return | Confirm a prompt |
| `/tab` | Tab | Trigger shell completion |
| `/up` | Up arrow | Previous history item / menu up |
| `/down` | Down arrow | Next history item / menu down |
| `/left` | Left arrow | Move cursor left |
| `/right` | Right arrow | Move cursor right |
| `/pick N` | Down x(N-1) + Enter | Select the Nth option in a menu |

**Example -- navigate a fuzzy finder:**

```
/down
/down
/pick 3
```

`/pick 3` is equivalent to pressing down twice then Enter -- it selects the third item in any numbered or navigable list.

All keyboard commands require an active session. If none is set, the hub replies with a prompt to use `/s` and `/N`.

### Image forwarding

Send an image to your WhatsApp self-chat and the hub will download it to a temp file and type the path into your active Claude session:

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

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WHAZAA_AUTH_DIR` | `~/.whazaa/auth/` | Directory for WhatsApp session credentials |
| `WHAZAA_TTS_VOICE` | `bm_fable` | Default TTS voice (overridden by voice-config.json) |
| `WHAZAA_WHISPER_MODEL` | `large-v3-turbo` | Whisper model for voice note transcription |

Whazaa loads environment from `~/.aibroker/env` when running as a launchd agent. Add any of the above variables there.

---

## Troubleshooting

**"Hub not available" or adapter fails to start**

The AIBroker daemon is not running. Start it first: `aibroker start` or `scripts/daemon-ctl.sh start` in the AIBroker repo. Whazaa cannot function without the hub.

**"Logged out (401)" error**

Your WhatsApp session was invalidated. Run `npx -y whazaa setup` to re-pair.

**Tools return an error or timeout**

The Whazaa adapter may not be registered with the hub. Check adapter status: `npx whazaa status` or look at the hub's active adapters via `aibroker_adapters`. Restart the launchd agent: `scripts/watcher-ctl.sh stop && scripts/watcher-ctl.sh start`.

**Messages not appearing in Claude**

Check that both the AIBroker hub and the Whazaa adapter are running. Verify the hub's active session matches your Claude tab.

**"iTerm2 wants to control..." security prompt**

Click OK. If you clicked "Don't Allow", go to System Settings > Privacy & Security > Automation and enable iTerm2 for the relevant app.

**Connection keeps dropping**

Whazaa reconnects automatically with exponential backoff (1s to 60s). Check your network. If the issue persists, call `whatsapp_login` to re-establish the WhatsApp session.

**TTS fails with "ffmpeg not found"**

Install ffmpeg: `brew install ffmpeg`. The hub searches `/opt/homebrew/bin/ffmpeg` and `/usr/local/bin/ffmpeg` before falling back to the system PATH, so Homebrew installs are found even in restricted launchd environments.

**First TTS call takes a long time**

The Kokoro model (~160 MB) is downloaded on first use and cached locally. Subsequent calls are fast. Check your network if the download stalls.

---

## Security

- Session credentials are stored locally in `~/.whazaa/auth/`. Treat them like passwords -- they grant full access to your WhatsApp Web session.
- Whazaa only reads and sends messages in your self-chat. It cannot access other conversations.
- No data is sent to any third-party service. All communication is directly with WhatsApp's servers via Baileys.
- TTS synthesis is fully local (Kokoro-js runs on-device). Audio never leaves your machine.

---

## Requirements

- Node.js >= 18
- [AIBroker](https://github.com/mnott/AIBroker) daemon (required -- installed separately)
- WhatsApp account (any -- multi-device support is standard)
- macOS with [iTerm2](https://iterm2.com/) for iTerm2 delivery
- [ffmpeg](https://ffmpeg.org/) for TTS voice note sending (`whatsapp_tts`)

---

## Uninstall

```bash
npx -y whazaa uninstall
```

Removes the `com.whazaa.watcher` launchd agent and deletes credentials from `~/.whazaa/`. Restart Claude Code to apply.

---

## License

MIT -- see [LICENSE](LICENSE)

## Author

Matthias Nott -- [github.com/mnott](https://github.com/mnott)
