/**
 * types.ts — Shared type definitions for the watcher subsystem.
 *
 * This module is the base of the dependency graph for the watcher: it has
 * zero project-level imports and may be imported freely by every other
 * watcher module without risk of circular dependencies.
 *
 * Covers four concerns:
 *  - IPC protocol shapes exchanged between the MCP server and the watcher
 *    process over the Unix-socket/HTTP bridge.
 *  - Per-client message queuing structures used by the long-poll receive path.
 *  - Session routing metadata for multi-client support.
 *  - Voice-synthesis configuration that is persisted to disk.
 *  - The watcher's externally-visible connection-status snapshot.
 */

// ---------------------------------------------------------------------------
// IPC protocol types (internal)
// ---------------------------------------------------------------------------

/**
 * A request sent from an MCP tool call to the watcher over the IPC channel.
 *
 * The watcher dispatches on `method` (e.g. "send", "receive", "status") and
 * uses `id` to correlate the matching {@link IpcResponse}.
 */
export interface IpcRequest {
  /** Unique request identifier used to match this request with its response. */
  id: string;
  /** TERM_SESSION_ID of the MCP client that issued the request. */
  sessionId: string;
  /** Optional iTerm2 session UUID carried for tab-title update side-effects. */
  itermSessionId?: string;
  /** The action to perform (e.g. "send", "receive", "status", "history"). */
  method: string;
  /** Method-specific arguments, validated inside each handler. */
  params: Record<string, unknown>;
}

/**
 * The watcher's reply to an {@link IpcRequest}.
 *
 * On success `ok` is true and `result` contains method-specific data.
 * On failure `ok` is false and `error` is a human-readable description.
 */
export interface IpcResponse {
  /** Must equal the `id` of the originating {@link IpcRequest}. */
  id: string;
  /** Whether the method completed without error. */
  ok: boolean;
  /** Method-specific result payload, present when `ok` is true. */
  result?: Record<string, unknown>;
  /** Human-readable error description, present when `ok` is false. */
  error?: string;
}

/**
 * A single incoming WhatsApp message that has been formatted and placed in a
 * per-client queue ready for a long-poll "receive" call to consume.
 */
export interface QueuedMessage {
  /** The fully-formatted message body, including sender prefix and any media labels. */
  body: string;
  /** Unix epoch milliseconds at which the message was received or generated. */
  timestamp: number;
}

/**
 * A lightweight record of a contact that has sent or received a message.
 * Stored in `contactDirectory` in state.ts and used for name-to-JID lookups.
 */
export interface ContactEntry {
  /** Normalized WhatsApp JID, e.g. "41764502698@s.whatsapp.net". */
  jid: string;
  /** Display name from the WhatsApp roster, or null if unknown. */
  name: string | null;
  /** The numeric portion of the JID, i.e. the international phone number digits. */
  phoneNumber: string;
  /** Unix epoch milliseconds of the most recent message involving this contact. */
  lastSeen: number;
}

// ---------------------------------------------------------------------------
// Session routing state
// ---------------------------------------------------------------------------

/**
 * Metadata for a single MCP client session that has called `whatsapp_receive`
 * and is therefore eligible to receive incoming message deliveries.
 *
 * Sessions are stored in the `sessionRegistry` map in state.ts, keyed by
 * `sessionId` (the value of TERM_SESSION_ID in the client's environment).
 */
export interface RegisteredSession {
  /** TERM_SESSION_ID that uniquely identifies the terminal tab / Claude session. */
  sessionId: string;
  /** Human-readable label shown in `/s` session lists, e.g. "Whazaa Dev". */
  name: string;
  /** iTerm2 session UUID used to update the tab title via AppleScript. Optional. */
  itermSessionId?: string;
  /** Unix epoch milliseconds at which the session was first registered. */
  registeredAt: number;
}

// ---------------------------------------------------------------------------
// Voice config
// ---------------------------------------------------------------------------

/**
 * Persistent voice-synthesis settings stored in `~/.whazaa/voice-config.json`.
 *
 * The config is loaded at startup and updated by `whatsapp_voice_config` calls.
 * Missing fields are filled from {@link DEFAULT_VOICE_CONFIG} in persistence.ts.
 */
export interface VoiceConfig {
  /** Kokoro voice ID used when no per-contact persona is configured. */
  defaultVoice: string;
  /**
   * When true, incoming messages are read aloud via the TTS pipeline instead
   * of (or in addition to) being printed to the terminal.
   */
  voiceMode: boolean;
  /**
   * When true, the local Kokoro HTTP server is used for synthesis instead of
   * the remote API endpoint.
   */
  localMode: boolean;
  /**
   * Optional per-contact persona overrides.
   * Key: a contact display name fragment (case-insensitive match).
   * Value: a Kokoro voice ID to use for that contact.
   */
  personas: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Watcher connection status
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of the watcher's WhatsApp connection state.
 * Returned by the `whatsapp_status` MCP tool and used internally to guard
 * operations that require an active connection.
 */
export interface WatcherConnStatus {
  /** True once the Baileys `connection.update` event reports "open". */
  connected: boolean;
  /** The authenticated account's phone number in international format, or null. */
  phoneNumber: string | null;
  /**
   * The account's primary JID (e.g. "41764502698@s.whatsapp.net").
   * Null until the connection handshake completes.
   */
  selfJid: string | null;
  /**
   * The account's linked-device identifier (LID) assigned by WhatsApp servers.
   * Present on newer multi-device accounts; null on legacy single-device accounts.
   */
  selfLid: string | null;
}
