# MCP tools

Back to the [README](../README.md).

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

## whatsapp_send

Sends a message to your self-chat. Supports Markdown formatting converted to WhatsApp format:

- `**bold**` becomes `*bold*`
- `*italic*` becomes `_italic_`
- `` `code` `` becomes ` ```code``` `

Optionally send as a TTS voice note by setting the `voice` parameter:

```
voice='true'         Use the configured default voice
voice='bm_george'    Use a specific voice
```

Supports an optional `recipient` parameter: a phone number (e.g. `+15551234567`), WhatsApp JID, or contact name.

## whatsapp_wait

Efficient alternative to polling. Blocks the tool call until a message arrives or the timeout expires (default 120 seconds, max 300). Use this in the background while working:

```
"Message me on WhatsApp when you're done. I'll wait."
```

## whatsapp_chats

Lists WhatsApp conversations. Reads from the WhatsApp Desktop macOS SQLite database for a complete inbox view, falling back to Baileys in-memory store (~100-150 recent chats) if the Desktop app is not installed.

Parameters:
- `search` (optional) -- filter results by contact name or phone number
- `limit` (optional, default 50, max 200) -- maximum number of conversations to return

Returns conversation JIDs, display names, and last-message timestamps. JIDs can be passed directly to `whatsapp_history`.

## whatsapp_history

Fetches message history for a conversation. Reads from the WhatsApp Desktop macOS SQLite database (no phone connection required). Falls back to requesting history from Baileys on demand, which requires the phone to be online.

Parameters:
- `jid` (required) -- the conversation JID (e.g. `15551234567@s.whatsapp.net`), as returned by `whatsapp_chats`
- `count` (optional, default 50, max 500) -- number of messages to return (most recent first)

## whatsapp_tts

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

## whatsapp_speak

Same TTS engine as `whatsapp_tts`, but plays audio through the Mac's speakers instead of sending a WhatsApp voice note. No WhatsApp connection required. Audio plays in the background without blocking other operations.

Parameters:
- `message` (required) -- text to speak aloud
- `voice` (optional) -- voice name (same list as `whatsapp_tts`); omit to use the configured default

## whatsapp_voice_config

Gets or sets the voice mode configuration. Configuration is persisted and survives adapter restarts.

Parameters:
- `action` (required) -- `'get'` to read current config, `'set'` to update it
- `voiceMode` (optional) -- `true` to enable voice responses, `false` to use text
- `localMode` (optional) -- when `true` and `voiceMode` is `true`, use `whatsapp_speak` (Mac speakers) instead of `whatsapp_tts` (WhatsApp voice notes)
- `defaultVoice` (optional) -- default voice name (e.g. `'bm_fable'`)
- `personas` (optional) -- map of names to voice IDs (e.g. `{"Nicole": "af_nicole", "George": "bm_george"}`)

Default personas: Nicole -> `af_nicole`, George -> `bm_george`, Daniel -> `bm_daniel`, Fable -> `bm_fable`

