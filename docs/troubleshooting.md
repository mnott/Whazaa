# Troubleshooting

Back to the [README](../README.md).

**"Hub not available" or adapter fails to start**

The AIBroker daemon is not running. Start it first: `aibroker start` or `scripts/daemon-ctl.sh start` in the AIBroker repo. Whazaa cannot function without the hub.

**"Logged out (401)" error**

Your WhatsApp session was invalidated. Run `npx -y whazaa setup` to re-pair.

**Tools return an error or timeout**

The Whazaa adapter may not be registered with the hub. Check adapter status: `npx whazaa status` or look at the hub's active adapters via `aibroker_adapters`. Restart the launchd agent: `whazaa service stop && whazaa service start`.

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

