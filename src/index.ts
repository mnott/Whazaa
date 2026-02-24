#!/usr/bin/env node
/**
 * @module index
 *
 * Whazaa MCP server — entry point and tool registrations.
 *
 * This file is the executable that Claude Code (or any MCP host) launches to
 * use Whazaa. It serves three distinct roles depending on the command-line
 * argument supplied:
 *
 *   - **MCP server mode** (default, no argument): Registers all WhatsApp tools
 *     over the stdio JSON-RPC transport and begins forwarding calls to the
 *     watcher daemon via IPC.
 *   - **Setup mode** (`setup`): Runs the interactive setup wizard from
 *     `setup.ts` (writes MCP config, installs the /name skill, pairs WhatsApp).
 *   - **Uninstall mode** (`uninstall`): Removes Whazaa config and credentials.
 *   - **Watcher mode** (`watch [sessionId]`): Starts the long-running watcher
 *     daemon that owns the Baileys WebSocket connection.
 *
 * ### Architecture: thin IPC proxy
 * The MCP server itself holds no WhatsApp state. Every tool call is forwarded
 * via a Unix Domain Socket (`/tmp/whazaa-watcher.sock`) to the watcher
 * daemon (`watch.ts`). The watcher is the sole owner of the Baileys connection
 * and fan-out message queues. This design means multiple Claude Code tabs can
 * share a single WhatsApp session without conflict.
 *
 * ### Tools registered
 * | Tool name              | Purpose                                                  |
 * |------------------------|----------------------------------------------------------|
 * | `whatsapp_status`      | Report connection state and logged-in phone number       |
 * | `whatsapp_send`        | Send a text or TTS voice note to self or any contact     |
 * | `whatsapp_tts`         | Convert text to a Kokoro voice note and send it          |
 * | `whatsapp_send_file`   | Send a file (PDF, image, video, etc.) via WhatsApp       |
 * | `whatsapp_receive`     | Drain the queued incoming messages for this session      |
 * | `whatsapp_contacts`    | List recently seen contacts, with optional search        |
 * | `whatsapp_chats`       | List chat conversations (Desktop DB or Baileys fallback) |
 * | `whatsapp_wait`        | Long-poll for the next incoming message                  |
 * | `whatsapp_login`       | Trigger a new QR pairing flow                            |
 * | `whatsapp_history`     | Fetch message history for a chat                         |
 * | `whatsapp_voice_config`| Get or set TTS voice mode configuration                  |
 * | `whatsapp_speak`       | Speak text aloud through the Mac's local speakers        |
 * | `whatsapp_rename`      | Rename this Claude session (tab title + registry)        |
 * | `whatsapp_restart`     | Restart the launchd-managed watcher service              |
 * | `whatsapp_discover`    | Re-scan iTerm2 sessions and refresh the session registry |
 *
 * ### stdout constraint
 * In MCP server mode, **stdout is the JSON-RPC transport**. Never write
 * anything other than well-formed MCP JSON to stdout. All debug output,
 * QR codes, and log lines must go to stderr.
 */

import { execSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { watch } from "./watcher/index.js";
import { setup, uninstall } from "./setup.js";
import { WatcherClient, ChatsResult, DiscoverResult, HistoryResult, TtsResult, VoiceConfigResult, SpeakResult } from "./ipc-client.js";
import { listVoices } from "./tts.js";
import { listChats, getMessages, isDesktopDbAvailable } from "./desktop-db.js";

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "whazaa",
  version: "0.1.0",
});

// Shared IPC client — one per MCP server process, bound to the session
// identified by TERM_SESSION_ID (set by iTerm2).
const watcher = new WatcherClient();

// ---------------------------------------------------------------------------
// Tool: whatsapp_status
// ---------------------------------------------------------------------------

// Reports whether the watcher is connected, awaiting a QR scan, or
// disconnected. Returns the authenticated phone number when connected.
server.registerTool("whatsapp_status", {
  description: "Check the Whazaa connection state and the WhatsApp phone number it is logged in as.",
  inputSchema: {},
}, async () => {
    try {
      const s = await watcher.status();

      let text: string;
      if (s.awaitingQR) {
        text =
          "Awaiting QR scan. Check the terminal where the watcher is running and scan the QR code with WhatsApp.";
      } else if (s.connected && s.phoneNumber) {
        text = `Connected. Phone: +${s.phoneNumber}`;
      } else {
        text =
          "Disconnected. The watcher is attempting to reconnect in the background.";
      }

      return { content: [{ type: "text", text }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_send
// ---------------------------------------------------------------------------

// Sends a WhatsApp text message (or TTS voice note when `voice` is set).
// Recipient defaults to self-chat when omitted. Supports basic Markdown and
// accepts phone numbers, JIDs, or contact names as the recipient identifier.
server.registerTool("whatsapp_send", {
  description: [
    "Send a WhatsApp message.",
    "Without a recipient, sends to your own self-chat (same as before).",
    "With a recipient, sends to any contact or group.",
    "Recipient can be a phone number with country code (e.g. '+41764502698'),",
    "a WhatsApp JID (e.g. '41764502698@s.whatsapp.net'), or a contact name.",
    "Supports basic Markdown: **bold**, *italic*, `code`.",
    "Optionally set voice to send the message as a TTS voice note instead of text.",
    "Use voice='true' or voice='default' for the default voice,",
    "or a specific voice name like 'af_heart', 'bm_george', 'af_bella', etc.",
  ].join(" "),
  inputSchema: {
    message: z
      .string()
      .min(1)
      .describe("The message text to send"),
    recipient: z
      .string()
      .optional()
      .describe(
        "Optional recipient: phone number (e.g. '+41764502698'), WhatsApp JID, or contact name. Omit to send to self-chat."
      ),
    voice: z
      .string()
      .optional()
      .describe(
        "Optional: if set, send message as a TTS voice note using Kokoro. Use 'true' or 'default' for the configured default voice, or a specific voice name like 'bm_george', 'af_bella', 'af_nova'."
      ),
  },
}, async ({ message, recipient, voice }) => {
    try {
      // If voice is requested, delegate to TTS IPC method
      if (voice !== undefined && voice !== "") {
        // "true" and "default" mean "use configured voice" — don't pass a specific voice
        const explicitVoice = (voice === "true" || voice === "default") ? undefined : voice;
        const result: TtsResult = await watcher.tts({
          text: message,
          voice: explicitVoice,
          jid: recipient,
        });
        const dest = result.targetJid ?? "self-chat";
        return {
          content: [
            {
              type: "text",
              text: `Voice note sent to ${dest} (voice: ${result.voice}, ${result.bytesSent} bytes)`,
            },
          ],
        };
      }

      const result = await watcher.send(message, recipient);
      const dest = result.targetJid ?? "self-chat";
      return {
        content: [{ type: "text", text: `Sent to ${dest}: ${result.preview}` }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_tts
// ---------------------------------------------------------------------------

// Dedicated TTS tool: converts text to a Kokoro voice note and sends it via
// WhatsApp. Runs entirely locally (no cloud API). The ~160 MB Kokoro model is
// downloaded on first use and cached. Voice defaults to the configured default
// when omitted.
server.registerTool("whatsapp_tts", {
  description: [
    "Convert text to speech and send as a WhatsApp voice note.",
    "Uses Kokoro TTS — 100% local, no internet required after first run.",
    "The model (~160 MB) is downloaded on first use and cached locally.",
    `Available voices: ${listVoices().join(", ")}.`,
    "Without a recipient, sends to your own self-chat.",
    "With a recipient, sends to any contact or group.",
  ].join(" "),
  inputSchema: {
    message: z
      .string()
      .min(1)
      .describe("The text to convert to speech and send as a voice note"),
    voice: z
      .string()
      .optional()
      .describe(
        "Kokoro voice to use. Omit to use the configured default voice. Examples: 'af_bella', 'af_nova', 'bm_george', 'bm_daniel', 'bf_emma'."
      ),
    recipient: z
      .string()
      .optional()
      .describe(
        "Optional recipient: phone number (e.g. '+41764502698'), WhatsApp JID, or contact name. Omit to send to self-chat."
      ),
  },
}, async ({ message, voice, recipient }) => {
    try {
      const result: TtsResult = await watcher.tts({
        text: message,
        voice: voice,
        jid: recipient,
      });
      const dest = result.targetJid ?? "self-chat";
      return {
        content: [
          {
            type: "text",
            text: `Voice note sent to ${dest} (voice: ${result.voice}, ${result.bytesSent} bytes)`,
          },
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_send_file
// ---------------------------------------------------------------------------

// Sends an arbitrary file (PDF, image, video, audio, document, etc.) as a
// WhatsApp attachment. The file is read from an absolute path on disk and
// forwarded to the watcher, which handles MIME detection and Baileys upload.
server.registerTool("whatsapp_send_file", {
  description: "Send a file (document, image, video, audio) via WhatsApp. Supports any file type — PDFs, Word docs, images, videos, etc.",
  inputSchema: {
    filePath: z.string().min(1).describe("Absolute path to the file to send"),
    recipient: z.string().optional().describe("Optional recipient: phone number, JID, or contact name. Omit to send to self-chat."),
    caption: z.string().optional().describe("Optional caption/message to accompany the file"),
  },
}, async ({ filePath, recipient, caption }) => {
    try {
      const result = await watcher.sendFile(filePath, recipient, caption);
      return {
        content: [{ type: "text" as const, text: `Sent: ${result.fileName} (${result.fileSize} bytes) to ${result.targetJid}` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to send file: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_receive
// ---------------------------------------------------------------------------

// Drains the in-memory message queue for this MCP session and returns the
// accumulated messages since the last call, then clears the queue. Scope
// can be restricted to self-chat (default), a specific contact/JID, or all
// chats simultaneously via the `from` parameter.
server.registerTool("whatsapp_receive", {
  description: [
    "Return queued incoming WhatsApp messages since the last call, then clear the queue.",
    "Without 'from': returns self-chat messages (default, backwards compatible).",
    "With 'from' set to a phone number, JID, or contact name: returns messages from that contact.",
    "With 'from' set to 'all': returns messages from all chats (self-chat + all contacts), prefixed with sender JID.",
    "Returns 'No new messages.' if the queue is empty.",
  ].join(" "),
  inputSchema: {
    from: z
      .string()
      .optional()
      .describe(
        "Optional sender filter: phone number, JID, contact name, or 'all'. Omit for self-chat only."
      ),
  },
}, async ({ from }) => {
    try {
      const result = await watcher.receive(from);
      const { messages } = result;

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No new messages." }] };
      }

      const formatted = messages
        .map((m) => {
          const ts = new Date(m.timestamp).toISOString();
          return `[${ts}] ${m.body}`;
        })
        .join("\n");

      return { content: [{ type: "text", text: formatted }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_contacts
// ---------------------------------------------------------------------------

// Returns the list of contacts that have exchanged messages in this Baileys
// session, ordered by most-recently-seen. Supports optional substring search
// across name and phone number. Returns JIDs suitable for use with
// whatsapp_send and whatsapp_receive.
server.registerTool("whatsapp_contacts", {
  description: [
    "List recently seen WhatsApp contacts.",
    "Returns contacts that have sent or received messages in this session, most recent first.",
    "Optionally filter by name or phone number using the 'search' parameter.",
    "Use the returned phone number or JID as the 'recipient' parameter for whatsapp_send.",
  ].join(" "),
  inputSchema: {
    search: z
      .string()
      .optional()
      .describe("Optional search string to filter contacts by name or phone number"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe("Maximum number of contacts to return (default 50)"),
  },
}, async ({ search, limit }) => {
    try {
      const result = await watcher.contacts(search, limit);
      const { contacts } = result;

      if (contacts.length === 0) {
        const msg = search
          ? `No contacts found matching '${search}'.`
          : "No contacts seen yet. Send a message first, or wait for incoming messages.";
        return { content: [{ type: "text", text: msg }] };
      }

      const lines = contacts.map((c) => {
        const name = c.name ? `${c.name} ` : "";
        const ts = new Date(c.lastSeen).toISOString();
        return `${name}+${c.phoneNumber} (${c.jid}) — last seen ${ts}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `${contacts.length} contact(s):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_chats
// ---------------------------------------------------------------------------

// Lists WhatsApp chat conversations (inbox). Prefers the WhatsApp Desktop
// macOS SQLite database for a complete, always-up-to-date view that works
// even when the phone is offline. Falls back to the Baileys in-memory store
// (typically ~100-150 chats synced at connect time) when the Desktop DB is
// not available.
server.registerTool("whatsapp_chats", {
  description: [
    "List WhatsApp chat conversations (inbox).",
    "Reads directly from the WhatsApp Desktop macOS SQLite database when available (complete inbox, no Baileys sync required).",
    "Falls back to the Baileys in-memory store when the Desktop DB is not present (~100-150 chats synced on connect).",
    "Use the returned JID as the 'recipient' parameter for whatsapp_send,",
    "or with whatsapp_receive to read messages from a specific contact.",
    "Optionally filter by name or phone number using the 'search' parameter.",
  ].join(" "),
  inputSchema: {
    search: z
      .string()
      .optional()
      .describe("Optional search string to filter chats by name or phone number"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe("Maximum number of chats to return (default 50)"),
  },
}, async ({ search, limit }) => {
    try {
      // Try the Desktop DB first — it has the full inbox without needing Baileys sync
      const desktopChats = listChats(search, limit);

      if (desktopChats !== null) {
        // Desktop DB is available
        if (desktopChats.length === 0) {
          const msg = search
            ? `No chats found matching '${search}'.`
            : "No chats found in the WhatsApp Desktop database.";
          return { content: [{ type: "text", text: msg }] };
        }

        const lines = desktopChats.map((c) => {
          const ts = c.lastMessageDate || "unknown";
          const unread = c.unreadCount > 0 ? ` [${c.unreadCount} unread]` : "";
          const archived = c.archived ? " [archived]" : "";
          return `${c.name} (${c.jid})${unread}${archived} — last message ${ts}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `${desktopChats.length} chat(s) [source: Desktop DB]:\n${lines.join("\n")}`,
            },
          ],
        };
      }

      // Fall back to Baileys IPC store
      const result: ChatsResult = await watcher.chats({ search, limit });
      const { chats } = result;

      if (chats.length === 0) {
        const msg = search
          ? `No chats found matching '${search}'.`
          : "No chats available yet. The store may still be syncing — try again in a few seconds.";
        return { content: [{ type: "text", text: msg }] };
      }

      const lines = chats.map((c) => {
        const ts = c.lastMessageTimestamp
          ? new Date(c.lastMessageTimestamp).toISOString()
          : "unknown";
        const unread = c.unreadCount > 0 ? ` [${c.unreadCount} unread]` : "";
        return `${c.name} (${c.jid})${unread} — last message ${ts}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `${chats.length} chat(s) [source: Baileys store]:\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_wait
// ---------------------------------------------------------------------------

// Long-polls the watcher for the next incoming message. Blocks (server-side)
// until a message arrives or the configurable timeout elapses. Preferred over
// a polling loop with whatsapp_receive — one blocking call instead of many
// round-trips.
server.registerTool("whatsapp_wait", {
  description: [
    "Wait for the next incoming WhatsApp message.",
    "Blocks until a message arrives or the timeout is reached (default 120 seconds).",
    "Use this instead of polling whatsapp_receive in a loop.",
    "Run this in the background so you can continue working while waiting.",
  ].join(" "),
  inputSchema: {
    timeout: z
      .number()
      .min(1)
      .max(300)
      .default(120)
      .describe("Max seconds to wait for a message (default 120)"),
  },
}, async ({ timeout }) => {
    try {
      const result = await watcher.wait(timeout * 1_000);
      const { messages } = result;

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No messages received (timed out)." }] };
      }

      const formatted = messages
        .map((m) => {
          const ts = new Date(m.timestamp).toISOString();
          return `[${ts}] ${m.body}`;
        })
        .join("\n");

      return { content: [{ type: "text", text: formatted }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_login
// ---------------------------------------------------------------------------

// Instructs the watcher to start a fresh QR-code pairing flow. Useful when
// the WhatsApp session has expired, been revoked, or when the user wants to
// link a different phone number. The QR code is printed to the watcher's
// stderr — the user must check the terminal where the watcher runs.
server.registerTool("whatsapp_login", {
  description: [
    "Trigger a new WhatsApp QR pairing flow.",
    "Use this when the connection is lost and automatic reconnection fails,",
    "or when you need to link a different phone number.",
    "A QR code will be printed to the watcher's stderr — check the terminal where it is running.",
  ].join(" "),
  inputSchema: {},
}, async () => {
    try {
      const result = await watcher.login();
      return {
        content: [{ type: "text", text: result.message }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_history
// ---------------------------------------------------------------------------

// Fetches historical messages for a specific chat. Tries the WhatsApp Desktop
// macOS SQLite database first (offline-capable, no anchor message needed).
// Falls back to an on-demand Baileys fetch from the phone when the Desktop DB
// is unavailable. Accepts both full JIDs and bare phone numbers.
server.registerTool("whatsapp_history", {
  description: [
    "Fetch message history for a WhatsApp chat.",
    "Reads directly from the WhatsApp Desktop macOS SQLite database when available — no phone connection required.",
    "Falls back to Baileys on-demand fetch (requires phone online) when the Desktop DB is not present.",
    "Accepts a full JID (e.g. '41796074745@s.whatsapp.net') or a phone number (e.g. '+41796074745').",
  ].join(" "),
  inputSchema: {
    jid: z
      .string()
      .min(1)
      .describe(
        "The chat JID (e.g. '41796074745@s.whatsapp.net') or phone number (e.g. '+41796074745')"
      ),
    count: z
      .number()
      .min(1)
      .max(500)
      .default(50)
      .describe("Number of messages to fetch (default 50, max 500)"),
  },
}, async ({ jid, count }) => {
    try {
      // Try the Desktop DB first — works offline, no anchor message needed
      const desktopMessages = getMessages(jid, count);

      if (desktopMessages !== null) {
        // Desktop DB is available
        if (desktopMessages.length === 0) {
          return {
            content: [{ type: "text", text: `No messages found for ${jid} in the WhatsApp Desktop database.` }],
          };
        }

        const lines = desktopMessages.map((m) => {
          const direction = m.fromMe ? "Me" : (m.pushName ?? "Them");
          return `[${m.date}] ${direction}: ${m.text}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `${desktopMessages.length} message(s) for ${jid} [source: Desktop DB]:\n${lines.join("\n")}`,
            },
          ],
        };
      }

      // Fall back to Baileys IPC (on-demand fetch from phone)
      const result: HistoryResult = await watcher.history({ jid, count });
      const { messages } = result;

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No messages found for this chat." }] };
      }

      const lines = messages.map((m) => {
        const direction = m.fromMe ? "Me" : "Them";
        return `[${m.date}] ${direction}: ${m.text}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `${messages.length} message(s) for ${jid} [source: Baileys]:\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_voice_config
// ---------------------------------------------------------------------------

// Gets or sets the persistent TTS voice configuration stored in the watcher.
// Covers: voice mode (text vs. voice notes), local speaker mode, the default
// Kokoro voice, and persona-to-voice mappings. Use action='get' to read the
// current config and action='set' to update one or more fields atomically.
server.registerTool("whatsapp_voice_config", {
  description: [
    "Get or set voice mode configuration.",
    "Actions: 'get' (read current config), 'set' (update config).",
    "Voice mode controls whether PAI responds via voice notes or text.",
    "Default voice is 'bm_fable'.",
    "Personas map names to voices (e.g. 'Nicole' -> 'af_nicole').",
  ].join(" "),
  inputSchema: {
    action: z
      .enum(["get", "set"])
      .describe("Action: 'get' to read config, 'set' to update it"),
    defaultVoice: z
      .string()
      .optional()
      .describe("Set the default PAI voice (e.g. 'bm_fable', 'af_nicole')"),
    voiceMode: z
      .boolean()
      .optional()
      .describe("Enable/disable voice mode. When true, PAI should respond with voice notes."),
    localMode: z
      .boolean()
      .optional()
      .describe("Enable/disable local speaker mode. When true AND voiceMode is true, PAI should use whatsapp_speak (local speakers) instead of whatsapp_tts (WhatsApp voice notes)."),
    personas: z
      .record(z.string())
      .optional()
      .describe("Map of persona names to voice IDs (e.g. {\"Nicole\": \"af_nicole\"})"),
  },
}, async ({ action, defaultVoice, voiceMode, localMode, personas }) => {
    try {
      const updates: Record<string, unknown> = {};
      if (defaultVoice !== undefined) updates.defaultVoice = defaultVoice;
      if (voiceMode !== undefined) updates.voiceMode = voiceMode;
      if (localMode !== undefined) updates.localMode = localMode;
      if (personas !== undefined) updates.personas = personas;

      const result: VoiceConfigResult = await watcher.voiceConfig(action, Object.keys(updates).length > 0 ? updates : undefined);

      if (!result.success) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }

      const c = result.config!;
      const personaList = Object.entries(c.personas)
        .map(([name, voice]) => `  ${name} -> ${voice}`)
        .join("\n");

      const modeDesc = !c.voiceMode
        ? "OFF (text)"
        : c.localMode
        ? "ON (local speakers)"
        : "ON (WhatsApp voice notes)";

      return {
        content: [
          {
            type: "text",
            text: `Voice config:\n  Mode: ${modeDesc}\n  Local mode: ${c.localMode ? "ON" : "OFF"}\n  Default voice: ${c.defaultVoice}\n  Personas:\n${personaList}`,
          },
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_speak
// ---------------------------------------------------------------------------

// Synthesises speech with Kokoro TTS and plays it through the Mac's local
// speakers (via Core Audio / afplay). Audio plays in the background and does
// not block subsequent tool calls. Use this for local voice feedback instead
// of sending a WhatsApp voice note.
server.registerTool("whatsapp_speak", {
  description: [
    "Speak text aloud through the Mac's speakers using Kokoro TTS.",
    "100% local, no internet required. Same voices as whatsapp_tts.",
    "Audio plays in the background without blocking other operations.",
    "Use this when the user wants to hear responses locally instead of via WhatsApp voice notes.",
    `Available voices: ${listVoices().join(", ")}.`,
  ].join(" "),
  inputSchema: {
    message: z
      .string()
      .min(1)
      .describe("The text to speak aloud"),
    voice: z
      .string()
      .optional()
      .default("bm_fable")
      .describe("Kokoro voice to use (default: 'bm_fable'). Examples: 'af_bella', 'af_nova', 'bm_george', 'bm_daniel', 'bf_emma'."),
  },
}, async ({ message, voice }) => {
    try {
      const result: SpeakResult = await watcher.speak(message, voice);
      if (!result.success) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Speaking aloud (voice: ${result.voice})` }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_rename
// ---------------------------------------------------------------------------

// Renames the current Claude session. Writes the new name into the watcher's
// session registry, updates the iTerm2 tab title via AppleScript, and persists
// the name in the iTerm2 `user.paiName` session variable so it survives
// watcher restarts and appears in `/s` session listings.
server.registerTool("whatsapp_rename", {
  description: "Rename this Claude session. Updates the session name in the watcher registry, the iTerm2 tab title, and the persistent session variable. The new name appears in /s listings and the status bar.",
  inputSchema: {
    name: z
      .string()
      .min(1)
      .describe("The new session name (e.g. 'Whazaa Dev', 'API Refactor')"),
  },
}, async ({ name }) => {
    try {
      const result = await watcher.rename(name);
      if (!result.success) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Session renamed to "${result.name}"` }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_restart
// ---------------------------------------------------------------------------

// Restarts the launchd-managed Whazaa watcher service
// (`com.whazaa.watcher`). Before issuing the launchctl kickstart, the tool
// scans running processes for rogue manual watcher instances (not managed by
// launchd) and SIGTERMs them to prevent session-conflict errors (code 440
// connectionReplaced). Returns the new watcher PID on success.
server.registerTool("whatsapp_restart", {
  description: [
    "Safely restart the Whazaa watcher service managed by launchd (com.whazaa.watcher).",
    "Use this when the watcher is misbehaving, stuck, or when multiple watcher instances",
    "are fighting over the WhatsApp session (error code 440 connectionReplaced).",
    "This tool first kills any rogue manual watcher processes (node processes running",
    "dist/index.js watch that are not managed by launchd), then uses",
    "'launchctl kickstart -k' to atomically stop and restart the managed service.",
    "Returns the new PID if the restart succeeded, or an error message if it failed.",
  ].join(" "),
  inputSchema: {},
}, async () => {
    try {
      const lines: string[] = [];

      // Step 1: Get the UID for the launchctl target domain
      const uid = process.getuid ? process.getuid() : parseInt(
        execSync("id -u", { encoding: "utf-8" }).trim(),
        10
      );

      // Step 2: Kill rogue manual watcher processes — node processes running
      // "dist/index.js watch" or "whazaa watch" that are NOT the launchd-managed one.
      // We identify the launchd PID first so we can exclude it.
      let launchdPid: number | null = null;
      try {
        const listOut = execSync(`launchctl list com.whazaa.watcher 2>/dev/null`, {
          encoding: "utf-8",
        });
        const pidMatch = listOut.match(/"PID"\s*=\s*(\d+)/);
        if (pidMatch) {
          launchdPid = parseInt(pidMatch[1], 10);
        }
      } catch {
        // Service may not be running yet — that's fine
      }

      // Find all node processes whose command line contains "watch" and looks like whazaa
      let psOut = "";
      try {
        psOut = execSync(
          `ps -eo pid,args | grep -E "(whazaa|dist/index\\.js).*watch" | grep -v grep`,
          { encoding: "utf-8" }
        );
      } catch {
        // grep returns exit code 1 when no matches — not an error
      }

      const roguePids: number[] = [];
      for (const line of psOut.trim().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const pid = parseInt(trimmed.split(/\s+/)[0], 10);
        if (isNaN(pid)) continue;
        if (launchdPid !== null && pid === launchdPid) continue; // skip the launchd-managed one
        roguePids.push(pid);
      }

      if (roguePids.length > 0) {
        lines.push(`Killing ${roguePids.length} rogue watcher process(es): ${roguePids.join(", ")}`);
        for (const pid of roguePids) {
          try {
            execSync(`kill -TERM ${pid} 2>/dev/null || true`);
          } catch {
            // Ignore — process may have already exited
          }
        }
        // Brief pause to let them die before kickstart
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {
        lines.push("No rogue watcher processes found.");
      }

      // Step 3: Atomically kill + restart the launchd service
      try {
        execSync(`launchctl kickstart -k gui/${uid}/com.whazaa.watcher`, {
          encoding: "utf-8",
        });
        lines.push("launchctl kickstart -k succeeded.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lines.push(`launchctl kickstart failed: ${msg}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          isError: true,
        };
      }

      // Step 4: Wait briefly and verify the new PID
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      let newPid: number | null = null;
      try {
        const listAfter = execSync(`launchctl list com.whazaa.watcher 2>/dev/null`, {
          encoding: "utf-8",
        });
        const pidMatch = listAfter.match(/"PID"\s*=\s*(\d+)/);
        if (pidMatch) {
          newPid = parseInt(pidMatch[1], 10);
        }
      } catch {
        // Ignore
      }

      if (newPid !== null) {
        lines.push(`Watcher restarted successfully. New PID: ${newPid}`);
      } else {
        lines.push("Watcher restart issued but new PID not yet available — it may still be starting up.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_discover
// ---------------------------------------------------------------------------

// Re-scans all iTerm2 tabs for the `user.paiName` session variable and
// refreshes the watcher's session registry. Prunes entries for closed tabs
// (dead sessions) and registers newly discovered ones. Useful after a watcher
// restart or when `/s` shows stale or missing sessions.
server.registerTool("whatsapp_discover", {
  description: [
    "Re-scan iTerm2 sessions and update the session registry.",
    "Prunes dead sessions (closed tabs), and discovers new sessions by scanning",
    "all iTerm2 tabs for the user.paiName session variable (set by /name or /N).",
    "Discovered sessions are added to the registry so they appear in /s listings.",
    "Use when sessions are stuck, showing ghost entries, or after a watcher restart.",
  ].join(" "),
  inputSchema: {},
}, async () => {
    try {
      const result: DiscoverResult = await watcher.discover();
      const lines: string[] = [];
      if (result.alive.length > 0) {
        lines.push(`Alive (${result.alive.length}): ${result.alive.join(", ")}`);
      }
      if (result.discovered.length > 0) {
        lines.push(`Discovered (${result.discovered.length}): ${result.discovered.join(", ")}`);
      }
      if (result.pruned.length > 0) {
        lines.push(`Pruned (${result.pruned.length}): ${result.pruned.join(", ")}`);
      }
      if (result.alive.length === 0 && result.discovered.length === 0 && result.pruned.length === 0) {
        lines.push("No sessions found.");
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point for the Whazaa process.
 *
 * Dispatches to one of four modes based on `process.argv`:
 *
 * - `setup`   — Runs the interactive setup wizard and exits.
 * - `uninstall` — Removes all Whazaa config/credentials and exits.
 * - `watch [sessionId]` — Starts the long-running watcher daemon that owns
 *   the Baileys WebSocket connection. `sessionId` is an optional iTerm2
 *   session identifier used to route incoming messages to the correct queue.
 * - *(default)* — Starts the MCP server over stdio. Registers this session
 *   with the watcher (non-fatal if the watcher is not yet running) and then
 *   attaches the `StdioServerTransport` so Claude Code can call the tools.
 *
 * @returns A promise that resolves when the MCP transport is connected, or
 *   rejects with a fatal error (written to stderr and `process.exit(1)`).
 */
async function main(): Promise<void> {
  if (process.argv.includes("setup")) {
    await setup();
    return;
  }

  if (process.argv.includes("uninstall")) {
    await uninstall();
    return;
  }

  if (process.argv.includes("watch")) {
    const watchIdx = process.argv.indexOf("watch");
    const sessionId = process.argv[watchIdx + 1];
    await watch(sessionId);
    return;
  }

  // MCP server mode: register this session with the watcher so incoming
  // messages are routed to our queue. Registration failure is non-fatal —
  // the watcher may not be running yet, and the user will see a clear error
  // when they try to use the tools.
  watcher.register().catch((err) => {
    process.stderr.write(`[whazaa] Could not register with watcher: ${err}\n`);
    process.stderr.write(`[whazaa] Start the watcher with: npx whazaa watch\n`);
  });

  // Start the MCP server over stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[whazaa] Fatal error: ${err}\n`);
  process.exit(1);
});
