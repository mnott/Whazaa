# Setup, prerequisites and uninstall

Back to the [README](../README.md).

## Quick start

Tell Claude Code:

> Clone https://github.com/mnott/Whazaa and set it up for me

Claude clones the repo, finds the setup skill, and handles everything autonomously -- prerequisites, build, service registration, and WhatsApp pairing. The only thing you do is scan a QR code with your phone when prompted.

## Alternative: npx

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

## Requirements

- Node.js >= 18
- [AIBroker](https://github.com/mnott/AIBroker) daemon (required -- installed separately)
- WhatsApp account (any -- multi-device support is standard)
- macOS with [iTerm2](https://iterm2.com/) for iTerm2 delivery
- [ffmpeg](https://ffmpeg.org/) for TTS voice note sending (`whatsapp_tts`)

## Uninstall

```bash
npx -y whazaa uninstall
```

Removes the `com.whazaa.watcher` launchd agent and deletes credentials from `~/.whazaa/`. Restart Claude Code to apply.

