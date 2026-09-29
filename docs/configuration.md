# Configuration

Back to the [README](../README.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `WHAZAA_AUTH_DIR` | `~/.whazaa/auth/` | Directory for WhatsApp session credentials |
| `WHAZAA_TTS_VOICE` | `bm_fable` | Default TTS voice (overridden by voice-config.json) |
| `WHAZAA_WHISPER_MODEL` | `large-v3-turbo` | Whisper model for voice note transcription |

Whazaa loads environment from `~/.aibroker/env` when running as a launchd agent. Add any of the above variables there.

