# How it works

Back to the [README](../README.md).

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

