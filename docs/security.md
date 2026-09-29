# Security

Back to the [README](../README.md).

- Session credentials are stored locally in `~/.whazaa/auth/`. Treat them like passwords -- they grant full access to your WhatsApp Web session.
- Whazaa only reads and sends messages in your self-chat. It cannot access other conversations.
- No data is sent to any third-party service. All communication is directly with WhatsApp's servers via Baileys.
- TTS synthesis is fully local (Kokoro-js runs on-device). Audio never leaves your machine.

