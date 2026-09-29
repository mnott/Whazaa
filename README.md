# Whazaa

Your phone is now a Claude Code terminal. Send a WhatsApp message, Claude gets it. Claude responds, you see it on WhatsApp. Text, images, voice notes -- in both directions.

One command to set up. Zero cloud dependencies for voice. Works with any WhatsApp account.

- Dictate a voice note while driving and Claude starts coding; send an image and Claude interprets it
- Get spoken responses back in any of 28 voices -- all synthesized locally, nothing leaves your machine
- Open and manage terminal sessions with `/t`, switch between Claude sessions with `/s`, `/kill` a stuck one
- Navigate interactive TUIs and menus from your phone with `/cc`, `/esc`, `/up`, `/down`, `/pick N`
- Take screenshots of any session with `/ss` and get them back on WhatsApp

Whazaa is a thin adapter plugin for the [AIBroker](https://github.com/mnott/AIBroker) hub. It owns the WhatsApp connection ([Baileys](https://github.com/WhiskeySockets/Baileys)); everything else is done by the hub, which must be running.

---

## Install

Tell Claude Code:

> Clone https://github.com/mnott/Whazaa and set it up for me

Or, without cloning:

```bash
npx -y whazaa setup      # verify AIBroker, register the service, show a QR code
```

Scan the QR code with WhatsApp (Settings > Linked Devices > Link a Device), then restart Claude Code. Whazaa connects automatically from now on.

Requires Node.js >= 18 and a running AIBroker daemon. Linux: see [docs/service.md](docs/service.md#linux); the AIBroker platform guides are `docs/macos.md` and `docs/linux.md` in the [AIBroker repository](https://github.com/mnott/AIBroker).

→ [docs/setup.md](docs/setup.md) (quick start details, prerequisites, requirements, uninstall)

---

## How it works

Whazaa registers with the AIBroker hub over a Unix Domain Socket and heartbeats every 30 seconds. Incoming WhatsApp messages are forwarded to the hub, which handles delivery to the active Claude session, routing, transcription and commands. Whazaa is purely a transport layer.

→ [docs/architecture.md](docs/architecture.md)

## How to Use

Talk to Claude in plain language: send messages and voice notes, switch voices, read chat history, send images and voice notes in, take screenshots, manage sessions. The 28 available voices are listed there too.

→ [docs/usage.md](docs/usage.md)

## MCP tools

The `whatsapp_*` tools are served by the AIBroker unified MCP server, which routes calls to the Whazaa adapter over IPC. Whazaa has no MCP server of its own.

→ [docs/mcp-tools.md](docs/mcp-tools.md)

## CLI commands, launchd agent and Linux

`whazaa service start|stop|status` runs the adapter as a launchd agent (macOS) or a systemd user unit (Linux); `npx whazaa watch` runs it in the foreground.

→ [docs/service.md](docs/service.md)

## WhatsApp commands

Messages such as `/s`, `/t`, `/ss`, `/kill N`, `/relocate <path>` and the keyboard commands are intercepted by the hub and handled as commands instead of being forwarded to Claude.

→ [docs/whatsapp-commands.md](docs/whatsapp-commands.md)

## Configuration

`WHAZAA_AUTH_DIR`, `WHAZAA_TTS_VOICE` and `WHAZAA_WHISPER_MODEL`, loaded from `~/.aibroker/env` when running as a launchd agent.

→ [docs/configuration.md](docs/configuration.md)

## Troubleshooting

Hub not available, logged out (401), tools timing out, messages not arriving, iTerm2 permissions, dropped connections, ffmpeg and first-run TTS download.

→ [docs/troubleshooting.md](docs/troubleshooting.md)

## Security

Credentials stay local in `~/.whazaa/auth/`, only your self-chat is read and written, and TTS is fully on-device.

→ [docs/security.md](docs/security.md)

---

## Credits

- [Baileys](https://github.com/WhiskeySockets/Baileys) -- WhatsApp Web connection
- [AIBroker](https://github.com/mnott/AIBroker) -- the hub Whazaa plugs into
- [Kokoro-js](https://github.com/hexgrad/kokoro) -- local text-to-speech
- [Whisper](https://github.com/openai/whisper) -- local voice note transcription
- [ffmpeg](https://ffmpeg.org/) and [iTerm2](https://iterm2.com/)

## License

MIT -- see [LICENSE](LICENSE)

## Author

Matthias Nott -- [github.com/mnott](https://github.com/mnott)
