/**
 * watch.ts — Whazaa watcher daemon
 *
 * The watcher is the sole owner of the WhatsApp/Baileys connection. It:
 *   1. Connects to WhatsApp directly via Baileys (always — no MCP server check).
 *   2. Delivers incoming messages to iTerm2 (types them into Claude).
 *   3. Serves an IPC server on /tmp/whazaa-watcher.sock so MCP server
 *      instances can send/receive messages without holding their own
 *      Baileys connection.
 *
 * IPC protocol: NDJSON (newline-delimited JSON) over a Unix Domain Socket.
 *
 * Request  (MCP → Watcher):
 *   { "id": "uuid", "sessionId": "TERM_SESSION_ID", "method": "...", "params": {} }
 *
 * Response (Watcher → MCP):
 *   { "id": "uuid", "ok": true, "result": {} }
 *   { "id": "uuid", "ok": false, "error": "message" }
 *
 * Methods:
 *   register  — Register this session as the active client
 *   status    — Return connection state and phone number
 *   send      — Send a WhatsApp message (sets this session as active)
 *   receive   — Drain this session's incoming message queue
 *   wait      — Long-poll: resolve on next message or timeout
 *   login     — Trigger QR re-pairing
 *   tts       — Convert text to speech and send as voice note
 *
 * Smart session resolution for iTerm2 delivery (unchanged from before):
 *   1. Try the cached session, but only if Claude is actually running there
 *   2. Search all iTerm2 sessions for one running Claude
 *   3. Create a new Claude session
 *
 * Usage:  npx whazaa watch [session-id]
 *
 * Environment variables:
 *   WHAZAA_AUTH_DIR  Override the auth credentials directory (default: ~/.whazaa/auth)
 */

import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync, execSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer, Socket, Server } from "node:net";
import { randomUUID } from "node:crypto";
import { textToVoiceNote, speakLocally } from "./tts.js";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  proto,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import type { Chat, Contact } from "@whiskeysockets/baileys";
import pino from "pino";
import { resolveAuthDir, printQR } from "./auth.js";
import { IPC_SOCKET_PATH } from "./ipc-client.js";
import { listChats } from "./desktop-db.js";

// ---------------------------------------------------------------------------
// IPC protocol types (internal)
// ---------------------------------------------------------------------------

interface IpcRequest {
  id: string;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
}

interface IpcResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

interface QueuedMessage {
  body: string;
  timestamp: number;
}

interface ContactEntry {
  jid: string;
  name: string | null;
  phoneNumber: string;
  lastSeen: number;
}

// ---------------------------------------------------------------------------
// Session routing state
// ---------------------------------------------------------------------------

interface RegisteredSession {
  sessionId: string;       // TERM_SESSION_ID
  name: string;            // Human-readable name like "Whazaa Dev"
  itermSessionId?: string; // iTerm2 session UUID (for tab title)
  registeredAt: number;    // timestamp
}

/** Registry of all connected MCP sessions, keyed by TERM_SESSION_ID */
const sessionRegistry = new Map<string, RegisteredSession>();

/** The session ID of the most-recently-active MCP client */
let activeClientId: string | null = null;

/**
 * The iTerm2 session UUID of the currently-active Claude window.
 * Set by /N switch commands and delivery fallback logic.
 * Promoted to module-level so handleScreenshot() can access it.
 */
let activeItermSessionId: string = "";

/** Per-client incoming message queues, keyed by sessionId */
const clientQueues = new Map<string, QueuedMessage[]>();

/** Per-client long-poll waiters: resolve when the next message arrives */
const clientWaiters = new Map<
  string,
  Array<(msgs: QueuedMessage[]) => void>
>();

/**
 * Per-JID incoming message queues for non-self-chat contacts.
 * Key is the normalized JID (e.g. "41764502698@s.whatsapp.net").
 * Self-chat messages are NOT stored here — they go to clientQueues.
 */
const contactMessageQueues = new Map<string, QueuedMessage[]>();

/**
 * Recently seen contacts, keyed by normalized JID.
 * Updated whenever a message is received from or sent to any non-self JID.
 */
const contactDirectory = new Map<string, ContactEntry>();

/**
 * Dispatch an incoming WhatsApp message to the active MCP client's queue
 * AND to iTerm2 (iTerm2 delivery is always additive — never replaced).
 */
function dispatchIncomingMessage(body: string, timestamp: number): void {
  if (activeClientId !== null) {
    // Ensure the queue exists
    if (!clientQueues.has(activeClientId)) {
      clientQueues.set(activeClientId, []);
    }
    clientQueues.get(activeClientId)!.push({ body, timestamp });

    // Wake any long-poll waiters for this client
    const waiters = clientWaiters.get(activeClientId);
    if (waiters && waiters.length > 0) {
      const msgs = clientQueues.get(activeClientId)!.splice(0);
      const resolved = waiters.splice(0);
      for (const resolve of resolved) {
        resolve(msgs);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WhatsApp send function (watcher-owned, called by IPC handlers)
// ---------------------------------------------------------------------------

/** The active Baileys socket — null when disconnected */
let watcherSock: ReturnType<typeof makeWASocket> | null = null;

/**
 * Lightweight chat store: populated by chats.upsert / chats.update / chats.delete events.
 * Keyed by JID. WhatsApp pushes ~100-150 recent chats on connect with syncFullHistory:false.
 */
const chatStore = new Map<string, Chat>();

/**
 * Contact store: populated by contacts.upsert / contacts.update events.
 * Keyed by JID (id field from Contact).
 */
const contactStore = new Map<string, Contact>();

/**
 * Message store: keyed by normalized JID, stores raw Baileys message objects.
 * Used as anchor points for on-demand history fetches.
 * Populated from messaging-history.set events, messages.upsert events, and sent messages.
 */
const messageStore = new Map<string, proto.IWebMessageInfo[]>();

// ---------------------------------------------------------------------------
// Chat/contact store persistence (survives watcher restarts)
// ---------------------------------------------------------------------------

const WHAZAA_DIR = join(homedir(), ".whazaa");
const CHAT_CACHE_PATH = join(WHAZAA_DIR, "chat-cache.json");
const CONTACT_CACHE_PATH = join(WHAZAA_DIR, "contact-cache.json");
const MESSAGE_CACHE_PATH = join(WHAZAA_DIR, "message-cache.json");
const VOICE_CONFIG_PATH = join(WHAZAA_DIR, "voice-config.json");

// ---------------------------------------------------------------------------
// Voice config persistence
// ---------------------------------------------------------------------------

interface VoiceConfig {
  defaultVoice: string;
  voiceMode: boolean;
  localMode: boolean;
  personas: Record<string, string>;
}

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  defaultVoice: "bm_fable",
  voiceMode: false,
  localMode: false,
  personas: {
    "Nicole": "af_nicole",
    "George": "bm_george",
    "Daniel": "bm_daniel",
    "Fable": "bm_fable",
  },
};

function loadVoiceConfig(): VoiceConfig {
  try {
    if (existsSync(VOICE_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(VOICE_CONFIG_PATH, "utf-8")) as VoiceConfig;
      return { ...DEFAULT_VOICE_CONFIG, ...raw, personas: { ...DEFAULT_VOICE_CONFIG.personas, ...raw.personas } };
    }
  } catch {
    // Corrupted config — fall back to defaults
  }
  return { ...DEFAULT_VOICE_CONFIG, personas: { ...DEFAULT_VOICE_CONFIG.personas } };
}

function saveVoiceConfig(config: VoiceConfig): void {
  try {
    mkdirSync(WHAZAA_DIR, { recursive: true });
    writeFileSync(VOICE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    process.stderr.write(`[whazaa-watch] Failed to save voice config: ${err}\n`);
  }
}

/**
 * Load chatStore and contactStore from disk if cache files exist.
 * Called once at startup before opening the socket.
 */
function loadStoreCache(): void {
  try {
    if (existsSync(CHAT_CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(CHAT_CACHE_PATH, "utf-8")) as Chat[];
      for (const chat of raw) {
        if (chat.id) chatStore.set(chat.id, chat);
      }
      process.stderr.write(
        `[whazaa-watch] Loaded ${chatStore.size} chats from cache\n`
      );
    }
  } catch {
    // Corrupted cache — ignore, will be overwritten on next sync
  }

  try {
    if (existsSync(CONTACT_CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(CONTACT_CACHE_PATH, "utf-8")) as Contact[];
      for (const contact of raw) {
        if (contact.id) contactStore.set(contact.id, contact);
      }
      process.stderr.write(
        `[whazaa-watch] Loaded ${contactStore.size} contacts from cache\n`
      );
    }
  } catch {
    // Corrupted cache — ignore
  }

  try {
    if (existsSync(MESSAGE_CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(MESSAGE_CACHE_PATH, "utf-8")) as Record<string, proto.IWebMessageInfo[]>;
      let totalMsgs = 0;
      for (const [jid, msgs] of Object.entries(raw)) {
        if (Array.isArray(msgs) && msgs.length > 0) {
          messageStore.set(jid, msgs);
          totalMsgs += msgs.length;
        }
      }
      process.stderr.write(
        `[whazaa-watch] Loaded ${totalMsgs} messages across ${messageStore.size} JIDs from cache\n`
      );
    }
  } catch {
    // Corrupted cache — ignore, will be overwritten on next sync
  }
}

/**
 * Persist chatStore and contactStore to disk.
 * Called after each history sync event so restarts recover state quickly.
 */
function saveStoreCache(): void {
  try {
    mkdirSync(WHAZAA_DIR, { recursive: true });
    writeFileSync(CHAT_CACHE_PATH, JSON.stringify(Array.from(chatStore.values())), "utf-8");
    writeFileSync(CONTACT_CACHE_PATH, JSON.stringify(Array.from(contactStore.values())), "utf-8");

    // Serialize messageStore: only save essential fields to keep file small
    const msgObj: Record<string, Array<{ key: proto.IMessageKey; messageTimestamp: number | null; message: proto.IMessage | null | undefined }>> = {};
    for (const [jid, msgs] of messageStore) {
      msgObj[jid] = msgs.map((m) => ({
        key: m.key ?? {},
        messageTimestamp: m.messageTimestamp != null
          ? (typeof m.messageTimestamp === "number" ? m.messageTimestamp : Number(m.messageTimestamp))
          : null,
        message: m.message ?? null,
      }));
    }
    writeFileSync(MESSAGE_CACHE_PATH, JSON.stringify(msgObj), "utf-8");
  } catch (err) {
    process.stderr.write(`[whazaa-watch] Failed to save store cache: ${err}\n`);
  }
}

/** Current watcher connection state */
let watcherStatus = {
  connected: false,
  phoneNumber: null as string | null,
  selfJid: null as string | null,
  selfLid: null as string | null,
  awaitingQR: false,
};

/** IDs of messages sent by this watcher — used to suppress self-echo */
const sentMessageIds = new Set<string>();

// ---------------------------------------------------------------------------
// Contact and JID helpers
// ---------------------------------------------------------------------------

/**
 * Convert a human-readable phone number or JID to a normalized WhatsApp JID.
 *
 * Handles:
 *   "+41764502698"         -> "41764502698@s.whatsapp.net"
 *   "41764502698"          -> "41764502698@s.whatsapp.net"
 *   "41764502698@s.whatsapp.net" -> "41764502698@s.whatsapp.net" (pass-through)
 *   "123456789@g.us"       -> "123456789@g.us" (group, pass-through)
 */
function resolveJid(recipient: string): string {
  const trimmed = recipient.trim();

  // Already a full JID
  if (trimmed.includes("@")) {
    return trimmed;
  }

  // Strip leading + and any spaces/dashes from phone numbers
  const digits = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * Try to resolve a contact name to a JID by searching the contactDirectory.
 * Returns the JID if found, or null.
 */
function resolveNameToJid(name: string): string | null {
  const lowerName = name.toLowerCase();
  for (const entry of contactDirectory.values()) {
    if (entry.name && entry.name.toLowerCase().includes(lowerName)) {
      return entry.jid;
    }
  }
  return null;
}

/**
 * Resolve a recipient string to a JID.
 * Tries name lookup first if the string doesn't look like a phone number or JID.
 */
function resolveRecipient(recipient: string): string {
  const trimmed = recipient.trim();

  // Looks like a phone number (starts with +, or is all digits/spaces/dashes)
  // or is already a JID
  if (trimmed.includes("@") || /^[\+\d][\d\s\-().]+$/.test(trimmed)) {
    return resolveJid(trimmed);
  }

  // Try name lookup
  const nameJid = resolveNameToJid(trimmed);
  if (nameJid) {
    return nameJid;
  }

  // Fall back to treating it as a phone number
  return resolveJid(trimmed);
}

/**
 * Record a contact entry in the directory.
 */
function trackContact(jid: string, name: string | null, timestamp: number): void {
  const existing = contactDirectory.get(jid);
  if (!existing || timestamp > existing.lastSeen) {
    const phoneNumber = jid.split("@")[0];
    contactDirectory.set(jid, {
      jid,
      name: name ?? existing?.name ?? null,
      phoneNumber,
      lastSeen: timestamp,
    });
  } else if (name && !existing.name) {
    // Update name if we now have one
    existing.name = name;
  }
}

/**
 * Store a message in the per-JID contact queue.
 */
function enqueueContactMessage(jid: string, body: string, timestamp: number): void {
  if (!contactMessageQueues.has(jid)) {
    contactMessageQueues.set(jid, []);
  }
  contactMessageQueues.get(jid)!.push({ body, timestamp });
}

/**
 * Convert common Markdown syntax to WhatsApp formatting codes.
 *
 *   **bold**   -> *bold*
 *   *italic*   -> _italic_
 *   `code`     -> ```code```
 */
function markdownToWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "_$1_")
    .replace(/`([^`]+)`/g, "```$1```");
}

/**
 * Send a message via the watcher's Baileys socket.
 * Called from the IPC 'send' handler.
 *
 * @param message  The message text (Markdown supported)
 * @param recipient  Optional JID or phone number. Defaults to self-chat.
 */
async function watcherSendMessage(message: string, recipient?: string): Promise<string> {
  if (!watcherSock) {
    throw new Error("WhatsApp socket not initialized. Is the watcher connected?");
  }
  if (!watcherStatus.connected) {
    throw new Error("WhatsApp is not connected. Check status with whatsapp_status.");
  }
  if (!watcherStatus.selfJid) {
    throw new Error("Self JID not yet known. Wait for connection to fully open.");
  }

  const targetJid = recipient ? resolveRecipient(recipient) : watcherStatus.selfJid;
  const text = markdownToWhatsApp(message);
  const result = await watcherSock.sendMessage(targetJid, { text });

  if (result?.key?.id) {
    const id = result.key.id;
    sentMessageIds.add(id);
    setTimeout(() => sentMessageIds.delete(id), 30_000);
  }

  // Track outbound contact (non-self only)
  if (targetJid !== watcherStatus.selfJid) {
    trackContact(targetJid, null, Date.now());
  }

  const preview = message.length > 80 ? `${message.slice(0, 80)}...` : message;
  return preview;
}

// ---------------------------------------------------------------------------
// Session registry helpers
// ---------------------------------------------------------------------------

/**
 * Set a named iTerm2 session variable (user.paiName) on the given session.
 * This persists independently of the tab title, which Claude Code overwrites.
 * Silently ignores errors (iTerm2 not running, session not found, etc.).
 */
function setItermSessionVar(itermSessionId: string, name: string): void {
  try {
    const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${itermSessionId}" then
          tell aSession
            set variable named "user.paiName" to "${escaped}"
          end tell
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`;
    execSync(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      timeout: 5000,
      shell: "/bin/bash",
    });
  } catch {
    // silently ignore
  }
}

/**
 * Read the user.paiName session variable from the given iTerm2 session.
 * Returns the value as a string, or null if not set or on error.
 */
function getItermSessionVar(itermSessionId: string): string | null {
  try {
    const script = `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${itermSessionId}" then
          tell aSession
            try
              return (variable named "user.paiName")
            on error
              return ""
            end try
          end tell
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;
    const result = execSync(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      timeout: 5000,
      encoding: "utf8",
      shell: "/bin/bash",
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Cross-reference all iTerm2 sessions to find the one whose TERM_SESSION_ID
 * env var matches the given termSessionId.
 *
 * Returns the iTerm2 session UUID (the `id of aSession` AppleScript value),
 * or null if not found.
 *
 * If the caller already has ITERM_SESSION_ID available, they can pass it
 * directly as `itermSessionIdHint` to skip the AppleScript scan.
 */
function findItermSessionForTermId(
  termSessionId: string,
  itermSessionIdHint?: string
): string | null {
  // If the client passed its ITERM_SESSION_ID directly, trust it.
  // ITERM_SESSION_ID can be "UUID" or "w0t2p0:UUID" — strip any prefix
  // before the colon because AppleScript's `id of aSession` returns just
  // the bare UUID.
  if (itermSessionIdHint) {
    const colonIdx = itermSessionIdHint.lastIndexOf(":");
    return colonIdx >= 0 ? itermSessionIdHint.slice(colonIdx + 1) : itermSessionIdHint;
  }

  // Otherwise scan all iTerm2 sessions for a matching TERM_SESSION_ID
  const script = `
tell application "iTerm2"
  set output to ""
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set sessionId to id of aSession
        try
          set termId to (variable named "TERM_SESSION_ID" of aSession)
        on error
          set termId to ""
        end try
        if termId is "${termSessionId}" then
          return sessionId
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;

  const result = runAppleScript(script);
  return result && result !== "" ? result : null;
}

// ---------------------------------------------------------------------------
// IPC server
// ---------------------------------------------------------------------------

/**
 * Start the Unix Domain Socket IPC server.
 * Listens at IPC_SOCKET_PATH and handles one request per connection.
 * Stale socket file is removed on startup.
 */
function startIpcServer(
  triggerLoginFn: () => Promise<void>
): Server {
  // Remove stale socket file from a previous run
  if (existsSync(IPC_SOCKET_PATH)) {
    try {
      unlinkSync(IPC_SOCKET_PATH);
    } catch {
      // ignore — if we can't remove it, bind will fail with a clear error
    }
  }

  const server = createServer((socket: Socket) => {
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;

      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);

      let request: IpcRequest;
      try {
        request = JSON.parse(line) as IpcRequest;
      } catch {
        sendResponse(socket, { id: "?", ok: false, error: "Invalid JSON" });
        socket.destroy();
        return;
      }

      handleRequest(request, socket, triggerLoginFn).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse(socket, { id: request.id, ok: false, error: msg });
        socket.destroy();
      });
    });

    socket.on("error", () => {
      // Client disconnected — nothing to do
    });
  });

  server.on("error", (err) => {
    process.stderr.write(`[whazaa-watch] IPC server error: ${err}\n`);
  });

  server.listen(IPC_SOCKET_PATH, () => {
    process.stderr.write(`[whazaa-watch] IPC server listening on ${IPC_SOCKET_PATH}\n`);
  });

  return server;
}

function sendResponse(socket: Socket, response: IpcResponse): void {
  try {
    socket.write(JSON.stringify(response) + "\n");
  } catch {
    // Socket may already be closed
  }
}

/**
 * Handle a single IPC request and write the response back to the socket.
 */
async function handleRequest(
  request: IpcRequest,
  socket: Socket,
  triggerLoginFn: () => Promise<void>
): Promise<void> {
  const { id, sessionId, method, params } = request;

  switch (method) {
    case "register": {
      const name = params.name != null ? String(params.name) : "Unknown";
      const itermHint = params.itermSessionId != null ? String(params.itermSessionId) : undefined;
      const itermId = findItermSessionForTermId(sessionId, itermHint);

      // If this iTerm session has a persisted paiName (set by /N rename),
      // restore it — iTerm variables survive watcher restarts.
      const persistedName = itermId ? getItermSessionVar(itermId) : null;
      const effectiveName = persistedName ?? name;

      sessionRegistry.set(sessionId, {
        sessionId,
        name: effectiveName,
        itermSessionId: itermId ?? undefined,
        registeredAt: Date.now(),
      });

      if (itermId && !persistedName) {
        // Only write to iTerm var when there is no pre-existing persisted name;
        // if persistedName was already there, the var is already correct.
        setItermSessionVar(itermId, effectiveName);
      }

      // Only claim activeClientId if no session is currently registered, or
      // if the previously-active session has since disconnected.
      if (!activeClientId || !sessionRegistry.has(activeClientId) || activeClientId === sessionId) {
        activeClientId = sessionId;
      }

      if (!clientQueues.has(sessionId)) {
        clientQueues.set(sessionId, []);
      }
      process.stderr.write(`[whazaa-watch] IPC: registered client ${sessionId} (name: "${effectiveName}"${persistedName ? " [restored from iTerm]" : ""}, iTerm: ${itermId ?? "unknown"})\n`);
      sendResponse(socket, { id, ok: true, result: { registered: true } });
      socket.end();
      break;
    }

    case "rename": {
      const newName = params.name != null ? String(params.name) : "";
      if (!newName) {
        sendResponse(socket, { id, ok: false, error: "name is required" });
        socket.end();
        break;
      }
      const entry = sessionRegistry.get(sessionId);
      if (entry) {
        entry.name = newName;
        if (entry.itermSessionId) {
          setItermSessionVar(entry.itermSessionId, newName);
        }
        process.stderr.write(`[whazaa-watch] IPC: renamed session ${sessionId} to "${newName}"\n`);
        sendResponse(socket, { id, ok: true, result: { success: true, name: newName } });
      } else {
        sendResponse(socket, { id, ok: false, error: "Session not registered" });
      }
      socket.end();
      break;
    }

    case "status": {
      sendResponse(socket, {
        id,
        ok: true,
        result: {
          connected: watcherStatus.connected,
          phoneNumber: watcherStatus.phoneNumber,
          awaitingQR: watcherStatus.awaitingQR,
        },
      });
      socket.end();
      break;
    }

    case "send": {
      const message = String(params.message ?? "");
      if (!message) {
        sendResponse(socket, { id, ok: false, error: "message is required" });
        socket.end();
        break;
      }

      const recipient = params.recipient != null ? String(params.recipient) : undefined;

      // Ensure the sender has a queue even if not yet registered
      if (!clientQueues.has(sessionId)) {
        clientQueues.set(sessionId, []);
      }

      try {
        const preview = await watcherSendMessage(message, recipient);
        const targetJid = recipient ? resolveRecipient(recipient) : watcherStatus.selfJid;
        sendResponse(socket, { id, ok: true, result: { preview, targetJid } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse(socket, { id, ok: false, error: msg });
      }
      socket.end();
      break;
    }

    case "receive": {
      const fromParam = params.from != null ? String(params.from) : undefined;

      if (!fromParam) {
        // Default: drain this session's self-chat queue (backwards compatible)
        const queue = clientQueues.get(sessionId) ?? [];
        const messages = queue.splice(0);
        sendResponse(socket, { id, ok: true, result: { messages } });
      } else if (fromParam === "all") {
        // Collect from all contact queues AND the self-chat queue
        const combined: QueuedMessage[] = [];
        const selfQueue = clientQueues.get(sessionId) ?? [];
        combined.push(...selfQueue.splice(0));
        for (const [contactJid, q] of contactMessageQueues) {
          const msgs = q.splice(0);
          for (const m of msgs) {
            combined.push({ body: `[${contactJid}] ${m.body}`, timestamp: m.timestamp });
          }
        }
        combined.sort((a, b) => a.timestamp - b.timestamp);
        sendResponse(socket, { id, ok: true, result: { messages: combined } });
      } else {
        // Specific contact: resolve their JID and drain their queue
        const targetJid = resolveRecipient(fromParam);
        const q = contactMessageQueues.get(targetJid) ?? [];
        const messages = q.splice(0);
        sendResponse(socket, { id, ok: true, result: { messages } });
      }
      socket.end();
      break;
    }

    case "wait": {
      const timeoutMs = Number(params.timeoutMs ?? 120_000);

      // If messages are already queued, return immediately
      const existing = clientQueues.get(sessionId) ?? [];
      if (existing.length > 0) {
        const messages = existing.splice(0);
        sendResponse(socket, { id, ok: true, result: { messages } });
        socket.end();
        break;
      }

      // Ensure the client is registered
      if (!clientQueues.has(sessionId)) {
        clientQueues.set(sessionId, []);
      }
      if (!clientWaiters.has(sessionId)) {
        clientWaiters.set(sessionId, []);
      }

      let resolved = false;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        // Remove this waiter
        const waiters = clientWaiters.get(sessionId);
        if (waiters) {
          const idx = waiters.indexOf(onMessage);
          if (idx !== -1) waiters.splice(idx, 1);
        }
        sendResponse(socket, { id, ok: true, result: { messages: [] } });
        socket.end();
      }, timeoutMs);

      const onMessage = (msgs: QueuedMessage[]): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        sendResponse(socket, { id, ok: true, result: { messages: msgs } });
        socket.end();
      };

      clientWaiters.get(sessionId)!.push(onMessage);

      // If client disconnects before the timeout, clean up
      socket.on("close", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        const waiters = clientWaiters.get(sessionId);
        if (waiters) {
          const idx = waiters.indexOf(onMessage);
          if (idx !== -1) waiters.splice(idx, 1);
        }
      });
      break;
    }

    case "login": {
      triggerLoginFn().catch((err: unknown) => {
        process.stderr.write(`[whazaa-watch] IPC login error: ${err}\n`);
      });
      sendResponse(socket, {
        id,
        ok: true,
        result: {
          message:
            "QR pairing initiated. Check the terminal where the watcher is running and scan the QR code with WhatsApp (Linked Devices -> Link a Device).",
        },
      });
      socket.end();
      break;
    }

    case "contacts": {
      const searchParam = params.search != null ? String(params.search).toLowerCase() : null;
      const limitParam = params.limit != null ? Number(params.limit) : 50;

      // Merge contactDirectory (session-seen) with contactStore (WhatsApp sync)
      const merged = new Map<string, ContactEntry>(contactDirectory);

      for (const [jid, storeContact] of contactStore) {
        if (!merged.has(jid)) {
          const phoneNumber = jid.split("@")[0];
          merged.set(jid, {
            jid,
            name: storeContact.name ?? storeContact.notify ?? null,
            phoneNumber,
            lastSeen: 0,
          });
        } else {
          // Enrich existing entry with name from store if we didn't have one
          const existing = merged.get(jid)!;
          if (!existing.name) {
            existing.name = storeContact.name ?? storeContact.notify ?? null;
          }
        }
      }

      // Sort by lastSeen descending (most recent first), store-only contacts go to end
      const allContacts = Array.from(merged.values())
        .sort((a, b) => b.lastSeen - a.lastSeen);

      const filtered = searchParam
        ? allContacts.filter(
            (c) =>
              c.phoneNumber.includes(searchParam) ||
              (c.name && c.name.toLowerCase().includes(searchParam))
          )
        : allContacts;

      const contacts = filtered.slice(0, limitParam).map((c) => ({
        jid: c.jid,
        name: c.name,
        phoneNumber: c.phoneNumber,
        lastSeen: c.lastSeen,
      }));

      sendResponse(socket, { id, ok: true, result: { contacts } });
      socket.end();
      break;
    }

    case "chats": {
      const searchParam = params.search != null ? String(params.search).toLowerCase() : null;
      const limitParam = params.limit != null ? Number(params.limit) : 50;

      // Try the Desktop DB first — it has the complete inbox
      const desktopChats = listChats(searchParam ?? undefined, limitParam);

      if (desktopChats !== null) {
        // Desktop DB available: build entries from it, prefer Desktop DB names over chatStore
        const chats = desktopChats.map((dc) => {
          // Enrich with Baileys chatStore name if Desktop DB has none
          const storeChat = chatStore.get(dc.jid);
          const storeContact = contactStore.get(dc.jid);
          const name = dc.name || (storeChat as { name?: string } | undefined)?.name || storeContact?.name || storeContact?.notify || dc.jid.split("@")[0];
          const lastMessageTimestamp = dc.lastMessageDate
            ? new Date(dc.lastMessageDate).getTime()
            : 0;
          return {
            jid: dc.jid,
            name,
            lastMessageTimestamp,
            unreadCount: dc.unreadCount,
          };
        });

        sendResponse(socket, { id, ok: true, result: { chats } });
        socket.end();
        break;
      }

      // Fall back to Baileys chatStore
      const chatEntries = Array.from(chatStore.values()).map((chat) => {
        const jid = chat.id ?? "";
        // Resolve display name: chat name > contact store name > push name > phone number portion of JID
        const storeContact = contactStore.get(jid);
        const name =
          (chat as { name?: string }).name ??
          storeContact?.name ??
          storeContact?.notify ??
          jid.split("@")[0];

        return {
          jid,
          name,
          lastMessageTimestamp: chat.conversationTimestamp
            ? Number(chat.conversationTimestamp) * 1_000
            : 0,
          unreadCount: (chat.unreadCount ?? 0) as number,
        };
      }).sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);

      const filtered = searchParam
        ? chatEntries.filter(
            (c) =>
              c.jid.includes(searchParam) ||
              c.name.toLowerCase().includes(searchParam)
          )
        : chatEntries;

      const chats = filtered.slice(0, limitParam);

      sendResponse(socket, { id, ok: true, result: { chats } });
      socket.end();
      break;
    }

    case "history": {
      const jid = params.jid != null ? String(params.jid) : null;
      if (!jid) {
        sendResponse(socket, { id, ok: false, error: "jid is required" });
        socket.end();
        break;
      }
      const count = params.count != null ? Number(params.count) : 50;

      if (!watcherSock) {
        sendResponse(socket, { id, ok: false, error: "Not connected" });
        socket.end();
        break;
      }

      // Normalize the JID (phone number like "+41796074745" -> "41796074745@s.whatsapp.net")
      const normalizedJid = resolveJid(jid);

      // Check if we have any stored messages for this JID to use as anchor
      const stored = messageStore.get(normalizedJid) ?? [];

      if (stored.length === 0) {
        sendResponse(socket, {
          id,
          ok: false,
          error: "No anchor message found for this chat. Send or receive a message first to create an anchor.",
        });
        socket.end();
        break;
      }

      // Find the oldest message we have as anchor
      const oldest = stored.reduce((a, b) => {
        const tsA = typeof a.messageTimestamp === "number" ? a.messageTimestamp : Number(a.messageTimestamp);
        const tsB = typeof b.messageTimestamp === "number" ? b.messageTimestamp : Number(b.messageTimestamp);
        return tsA < tsB ? a : b;
      });

      // Set up a one-time listener for the on-demand history response
      const historyPromise = new Promise<proto.IWebMessageInfo[]>((resolve) => {
        const timeout = setTimeout(() => {
          // Timed out — return what we have locally
          resolve(messageStore.get(normalizedJid) ?? stored);
        }, 15_000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = (event: any) => {
          const { HistorySyncType } = proto.HistorySync;
          if (event.syncType === HistorySyncType.ON_DEMAND) {
            clearTimeout(timeout);
            watcherSock!.ev.off("messaging-history.set", handler);

            // Filter messages for our JID and merge into store
            const histMsgs: proto.IWebMessageInfo[] = event.messages ?? [];
            const forChat = histMsgs.filter((m) => m.key?.remoteJid === normalizedJid);
            const arr = messageStore.get(normalizedJid) ?? [];
            for (const msg of forChat) {
              if (!arr.some((m) => m.key?.id === msg.key?.id)) {
                arr.push(msg);
              }
            }
            messageStore.set(normalizedJid, arr);
            saveStoreCache();
            resolve(arr);
          }
        };
        watcherSock!.ev.on("messaging-history.set", handler);
      });

      // Request history from the phone
      try {
        const oldestTsSec = typeof oldest.messageTimestamp === "number"
          ? oldest.messageTimestamp
          : Number(oldest.messageTimestamp);
        // Baileys' oldestMsgTimestampMs field expects milliseconds
        const oldestTsMs = oldestTsSec < 1e12 ? oldestTsSec * 1000 : oldestTsSec;
        await watcherSock.fetchMessageHistory(count, oldest.key!, oldestTsMs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse(socket, { id, ok: false, error: `fetchMessageHistory failed: ${msg}` });
        socket.end();
        break;
      }

      // Wait for on-demand response (or timeout fallback)
      const allMessages = await historyPromise;

      // Format messages for output
      const formatted = allMessages
        .sort((a, b) => {
          const tsA = typeof a.messageTimestamp === "number" ? a.messageTimestamp : Number(a.messageTimestamp);
          const tsB = typeof b.messageTimestamp === "number" ? b.messageTimestamp : Number(b.messageTimestamp);
          return tsA - tsB;
        })
        .map((m) => {
          const ts = typeof m.messageTimestamp === "number" ? m.messageTimestamp : Number(m.messageTimestamp);
          return {
            id: m.key?.id ?? null,
            fromMe: m.key?.fromMe ?? false,
            timestamp: ts,
            date: new Date(ts * 1_000).toISOString(),
            text:
              m.message?.conversation ??
              m.message?.extendedTextMessage?.text ??
              m.message?.imageMessage?.caption ??
              "[non-text message]",
            type: m.message?.conversation
              ? "text"
              : m.message?.extendedTextMessage
              ? "text"
              : m.message?.imageMessage
              ? "image"
              : m.message?.videoMessage
              ? "video"
              : m.message?.audioMessage
              ? "audio"
              : m.message?.documentMessage
              ? "document"
              : "other",
          };
        });

      sendResponse(socket, {
        id,
        ok: true,
        result: { messages: formatted as unknown as Record<string, unknown>[], count: formatted.length },
      });
      socket.end();
      break;
    }

    case "tts": {
      const ttsText = params.text != null ? String(params.text) : "";
      if (!ttsText.trim()) {
        sendResponse(socket, { id, ok: false, error: "text is required for TTS" });
        socket.end();
        break;
      }

      // Use explicitly-provided voice, or fall back to configured defaultVoice
      const ttsVoice = params.voice != null ? String(params.voice) : loadVoiceConfig().defaultVoice;
      const ttsRecipient = params.jid != null ? String(params.jid) : undefined;

      if (!watcherSock) {
        sendResponse(socket, { id, ok: false, error: "WhatsApp socket not initialized. Is the watcher connected?" });
        socket.end();
        break;
      }
      if (!watcherStatus.connected) {
        sendResponse(socket, { id, ok: false, error: "WhatsApp is not connected. Check status with whatsapp_status." });
        socket.end();
        break;
      }
      if (!watcherStatus.selfJid) {
        sendResponse(socket, { id, ok: false, error: "Self JID not yet known. Wait for connection to fully open." });
        socket.end();
        break;
      }

      const targetJid = ttsRecipient ? resolveRecipient(ttsRecipient) : watcherStatus.selfJid;

      try {
        const audioBuffer = await textToVoiceNote(ttsText, ttsVoice);

        const result = await watcherSock.sendMessage(targetJid, {
          audio: audioBuffer,
          mimetype: "audio/ogg; codecs=opus",
          ptt: true,
        });

        if (result?.key?.id) {
          const msgId = result.key.id;
          sentMessageIds.add(msgId);
          setTimeout(() => sentMessageIds.delete(msgId), 30_000);
        }

        // Track outbound contact (non-self only)
        if (targetJid !== watcherStatus.selfJid) {
          trackContact(targetJid, null, Date.now());
        }

        sendResponse(socket, {
          id,
          ok: true,
          result: {
            targetJid,
            voice: ttsVoice ?? process.env.WHAZAA_TTS_VOICE ?? "bm_fable",
            bytesSent: audioBuffer.length,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse(socket, { id, ok: false, error: msg });
      }
      socket.end();
      break;
    }

    case "speak": {
      const speakText = params.text != null ? String(params.text) : "";
      if (!speakText.trim()) {
        sendResponse(socket, { id, ok: false, error: "text is required for speak" });
        socket.end();
        break;
      }

      const speakVoice = params.voice != null ? String(params.voice) : undefined;

      try {
        await speakLocally(speakText, speakVoice);
        sendResponse(socket, {
          id,
          ok: true,
          result: {
            success: true,
            voice: speakVoice ?? process.env.WHAZAA_TTS_VOICE ?? "bm_fable",
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse(socket, { id, ok: false, error: msg });
      }
      socket.end();
      break;
    }

    case "voice_config": {
      const { action, ...updates } = params as { action?: string } & Record<string, unknown>;
      if (action === "get") {
        const config = loadVoiceConfig();
        sendResponse(socket, { id, ok: true, result: { success: true, config: config as unknown as Record<string, unknown> } });
      } else if (action === "set") {
        const config = loadVoiceConfig();
        if (updates.defaultVoice !== undefined) config.defaultVoice = String(updates.defaultVoice);
        if (updates.voiceMode !== undefined) config.voiceMode = Boolean(updates.voiceMode);
        if (updates.localMode !== undefined) config.localMode = Boolean(updates.localMode);
        if (updates.personas !== undefined && typeof updates.personas === "object" && updates.personas !== null) {
          config.personas = { ...config.personas, ...(updates.personas as Record<string, string>) };
        }
        saveVoiceConfig(config);
        sendResponse(socket, { id, ok: true, result: { success: true, config: config as unknown as Record<string, unknown> } });
      } else {
        sendResponse(socket, { id, ok: true, result: { success: false, error: "Unknown action. Use 'get' or 'set'." } });
      }
      socket.end();
      break;
    }

    default: {
      sendResponse(socket, { id, ok: false, error: `Unknown method: ${method}` });
      socket.end();
    }
  }
}

// --- Terminal adapters -------------------------------------------------------

/**
 * Run an AppleScript and return its stdout, or null on failure.
 */
function runAppleScript(script: string): string | null {
  const result = spawnSync("osascript", [], {
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  return result.stdout?.toString().trim() ?? null;
}

/**
 * Type text into a specific iTerm2 session and press Enter.
 * Returns true if the session was found and text was typed.
 */
function typeIntoSession(sessionId: string, text: string): boolean {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const script = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          tell aSession to write text "${escaped}" newline no
          tell aSession to write text (ASCII character 13) newline no
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`;

  const result = runAppleScript(script);
  return result === "ok";
}

/**
 * Search all iTerm2 sessions for one whose name contains "claude" (case-insensitive).
 */
function findClaudeSession(): string | null {
  const script = `
tell application "iTerm2"
  set output to ""
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set sessionId to id of aSession
        set sessionName to name of aSession
        set output to output & sessionId & (ASCII character 9) & sessionName & linefeed
      end repeat
    end repeat
  end repeat
  return output
end tell`;

  const result = runAppleScript(script);
  if (!result) return null;

  const lines = result.split("\n").filter(Boolean);
  for (const line of lines) {
    const tabIdx = line.indexOf("\t");
    if (tabIdx < 0) continue;

    const id = line.substring(0, tabIdx);
    const name = line.substring(tabIdx + 1).toLowerCase();

    if (name.includes("claude")) {
      process.stderr.write(
        `[whazaa-watch] Found claude session: ${id} ("${line.substring(tabIdx + 1)}")\n`
      );
      return id;
    }
  }

  return null;
}

/**
 * Check whether Claude is actually running in the given iTerm2 session.
 */
function isClaudeRunningInSession(sessionId: string): boolean {
  const script = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          if (is at shell prompt of aSession) then
            return "shell"
          else
            return "running"
          end if
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`;

  const result = runAppleScript(script);
  if (result === "running") {
    return true;
  }
  if (result === "shell") {
    process.stderr.write(
      `[whazaa-watch] Session ${sessionId} is at shell prompt — Claude has exited.\n`
    );
  } else {
    process.stderr.write(
      `[whazaa-watch] Session ${sessionId} not found in iTerm2.\n`
    );
  }
  return false;
}

/**
 * Check if iTerm2 is running.
 */
function isItermRunning(): boolean {
  const result = spawnSync("pgrep", ["-x", "iTerm2"], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 3_000,
  });
  return result.status === 0;
}

/**
 * Create a new iTerm2 tab, cd to home, run `claude`, and return the new session ID.
 */
function createClaudeSession(): string | null {
  const home = homedir();

  if (!isItermRunning()) {
    process.stderr.write("[whazaa-watch] iTerm2 not running, launching...\n");
    spawnSync("open", ["-a", "iTerm"], { timeout: 10_000 });
    for (let i = 0; i < 10; i++) {
      spawnSync("sleep", ["1"]);
      if (isItermRunning()) break;
    }
  }

  const createScript = `
tell application "iTerm2"
  if (count of windows) = 0 then
    set newWindow to (create window with default profile)
    tell current session of current tab of newWindow
      write text "cd ${home}"
      delay 0.5
      write text "claude"
      return id
    end tell
  else
    tell current window
      set newTab to (create tab with default profile)
      tell current session of newTab
        write text "cd ${home}"
        delay 0.5
        write text "claude"
        return id
      end tell
    end tell
  end if
end tell`;

  const sessionId = runAppleScript(createScript);
  if (!sessionId) {
    process.stderr.write("[whazaa-watch] Failed to create new iTerm2 tab\n");
    return null;
  }

  process.stderr.write(
    `[whazaa-watch] Created new claude session: ${sessionId}\n`
  );

  process.stderr.write("[whazaa-watch] Waiting for Claude Code to start...\n");
  spawnSync("sleep", ["8"]);

  return sessionId;
}

// --- Command handlers --------------------------------------------------------

/**
 * Find an iTerm2 session that is running Claude in the given directory.
 */
function findClaudeInDirectory(targetDir: string): string | null {
  const script = `
tell application "iTerm2"
  set output to ""
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set sessionId to id of aSession
        set sessionName to name of aSession
        set sessionPath to (variable named "session.path" of aSession)
        set output to output & sessionId & (ASCII character 9) & sessionName & (ASCII character 9) & sessionPath & linefeed
      end repeat
    end repeat
  end repeat
  return output
end tell`;

  const result = runAppleScript(script);
  if (!result) return null;

  const lines = result.split("\n").filter(Boolean);
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const id = parts[0];
    const name = parts[1].toLowerCase();
    const sessionPath = parts[2];

    if (name.includes("claude") && sessionPath === targetDir) {
      process.stderr.write(
        `[whazaa-watch] Found existing Claude session in ${targetDir}: ${id}\n`
      );
      return id;
    }
  }

  return null;
}

/**
 * Expand a shell-style tilde path to an absolute path.
 * Handles both "~" (bare home) and "~/..." (home-relative).
 */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Handle a /relocate <path> command received via WhatsApp.
 */
function handleRelocate(targetPath: string): string | null {
  process.stderr.write(`[whazaa-watch] /relocate -> ${targetPath}\n`);

  const expandedPath = expandTilde(targetPath);

  const existingSession = findClaudeInDirectory(expandedPath);
  if (existingSession) {
    const focusScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${existingSession}" then
          set current tab of aWindow to aTab
          set frontmost of aWindow to true
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`;

    const focusResult = runAppleScript(focusScript);
    if (focusResult === "focused") {
      process.stderr.write(`[whazaa-watch] /relocate: focused existing session ${existingSession} in ${targetPath}\n`);
      return existingSession;
    }
    process.stderr.write(`[whazaa-watch] /relocate: session ${existingSession} vanished, opening new tab\n`);
  }

  const escapedPath = expandedPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const script = `
tell application "iTerm2"
  if (count of windows) = 0 then
    set newWindow to (create window with default profile)
    set newSession to current session of current tab of newWindow
    tell newSession
      write text "cd \\"${escapedPath}\\" && claude"
    end tell
    return id of newSession
  else
    tell current window
      set newTab to (create tab with default profile)
      set newSession to current session of newTab
      tell newSession
        write text "cd \\"${escapedPath}\\" && claude"
      end tell
      return id of newSession
    end tell
  end if
end tell`;

  const result = runAppleScript(script);
  if (result === null) {
    process.stderr.write("[whazaa-watch] /relocate: failed to open new iTerm2 tab\n");
    return null;
  }
  process.stderr.write(`[whazaa-watch] /relocate: opened new tab in ${targetPath} (session ${result})\n`);
  return result;
}

/**
 * List all iTerm2 sessions whose name contains "claude" (case-insensitive).
 * Returns an array of { id, name, path } objects.
 */
function cwdFromTty(tty: string): string {
  // Find the claude process on this TTY and get its cwd via lsof
  const ttyShort = tty.replace("/dev/", "");
  const psResult = spawnSync("ps", ["-eo", "pid,tty,comm"], { timeout: 5000 });
  if (psResult.status !== 0) return "";
  const lines = psResult.stdout.toString().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(ttyShort) && trimmed.includes("claude")) {
      const pid = trimmed.split(/\s+/)[0];
      const lsofResult = spawnSync("lsof", ["-a", "-d", "cwd", "-p", pid, "-Fn"], { timeout: 5000 });
      if (lsofResult.status !== 0) continue;
      const lsofLines = lsofResult.stdout.toString().split("\n");
      for (const l of lsofLines) {
        if (l.startsWith("n/")) return l.slice(1);
      }
    }
  }
  return "";
}

function listClaudeSessions(): Array<{ id: string; name: string; path: string }> {
  const script = `
tell application "iTerm2"
  set output to ""
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set sessionName to name of aSession
        if sessionName contains "Claude" or sessionName contains "claude" then
          set sessionId to id of aSession
          set sessionTty to tty of aSession
          set output to output & sessionId & (ASCII character 9) & sessionName & (ASCII character 9) & sessionTty & linefeed
        end if
      end repeat
    end repeat
  end repeat
  return output
end tell`;

  const result = runAppleScript(script);
  if (!result) return [];

  const sessions: Array<{ id: string; name: string; path: string }> = [];
  const lines = result.split("\n").filter(Boolean);
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const id = parts[0];
    const name = parts[1];
    const tty = parts[2] ?? "";
    const path = tty ? cwdFromTty(tty) : "";
    sessions.push({ id, name, path });
  }
  return sessions;
}

/**
 * Handle a /ss or /screenshot command received via WhatsApp.
 * Captures the frontmost iTerm2 window and sends it back as an image.
 */
async function handleScreenshot(): Promise<void> {
  // Ack immediately so the user knows we're working on it
  await watcherSendMessage("Capturing screenshot...").catch(() => {});

  const filePath = join(tmpdir(), `whazaa-screenshot-${Date.now()}.png`);

  try {
    // Resolve the window ID to capture.
    // Priority:
    //   1. Registry entry for activeClientId (most precise — set when MCP client registered)
    //   2. activeItermSessionId (set by /N switch commands — always up-to-date)
    //   3. Auto-discover from live Claude sessions (handles cold start / post-restart)
    //   4. Fall back to window 1 (last resort)
    let windowId: string;
    try {
      const activeEntry = activeClientId ? sessionRegistry.get(activeClientId) : undefined;
      // Prefer registry itermSessionId; fall back to the module-level activeItermSessionId.
      // Strip any "w0t2p0:"-style prefix from ITERM_SESSION_ID so the bare UUID is used
      // in AppleScript comparisons (iTerm2's `id of aSession` returns just the UUID).
      const stripItermPrefix = (id: string | undefined): string | undefined => {
        if (!id) return id;
        const colonIdx = id.lastIndexOf(":");
        return colonIdx >= 0 ? id.slice(colonIdx + 1) : id;
      };
      let itermSessionId = stripItermPrefix(activeEntry?.itermSessionId ?? (activeItermSessionId || undefined));

      // Auto-discover: if no session is tracked, scan for live Claude sessions
      if (!itermSessionId) {
        const liveSessions = listClaudeSessions();
        if (liveSessions.length > 0) {
          itermSessionId = liveSessions[0].id;
          activeItermSessionId = liveSessions[0].id;
          process.stderr.write(`[whazaa-watch] /ss: auto-discovered session ${liveSessions[0].id} (${liveSessions[0].name})\n`);
        }
      }

      if (itermSessionId) {
        // Two-phase AppleScript approach for reliable multi-tab screenshots:
        //
        // Phase 1: Find the session, switch to its tab using the correct
        //   iTerm2 API (set current tab of w to t), raise the window, and
        //   activate iTerm2. Return only the window ID so we don't capture
        //   bounds before the tab has actually switched and re-rendered.
        //
        // Phase 2: After a render-wait delay, re-read the window bounds by
        //   its ID. This ensures the bounds reflect the correct tab's layout
        //   (which may differ in height if tabs have different terminal sizes).
        const findAndRaiseScript = `tell application "iTerm2"
  repeat with w in windows
    set tabCount to count of tabs of w
    repeat with tabIdx from 1 to tabCount
      set t to tab tabIdx of w
      repeat with s in sessions of t
        if id of s is "${itermSessionId}" then
          -- Switch to the correct tab using the proper iTerm2 API.
          -- "select t" does NOT reliably switch the visible tab in a multi-tab
          -- window; "set current tab of w to t" is the correct command.
          set current tab of w to t
          -- Raise THIS window to the top of all iTerm2 windows
          set index of w to 1
          -- Bring iTerm2 to the foreground of all applications
          activate
          -- Return only the window ID; bounds are read after the render delay
          -- so they reflect the actual tab layout, not a pre-switch state.
          return (id of w as text)
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;
        const findResult = runAppleScript(findAndRaiseScript);
        if (findResult && findResult !== "") {
          windowId = findResult.trim();
          process.stderr.write(`[whazaa-watch] /ss: found session ${itermSessionId} in window ${windowId}, tab switched and activated\n`);
        } else {
          // Session not found — fall back to frontmost window
          runAppleScript('tell application "iTerm2" to activate');
          const fallbackScript = `tell application "iTerm2"
  set w to window 1
  activate
  return (id of w as text)
end tell`;
          const fallbackResult = runAppleScript(fallbackScript) ?? "";
          windowId = fallbackResult.trim();
          process.stderr.write(`[whazaa-watch] /ss: session ${itermSessionId} not found, falling back to window 1 (id=${windowId})\n`);
        }
      } else {
        // Truly no Claude sessions — activate iTerm2 and use frontmost window
        runAppleScript('tell application "iTerm2" to activate');
        const fallbackScript = `tell application "iTerm2"
  set w to window 1
  activate
  return (id of w as text)
end tell`;
        const fallbackResult = runAppleScript(fallbackScript) ?? "";
        windowId = fallbackResult.trim();
        process.stderr.write(`[whazaa-watch] /ss: no Claude sessions found, falling back to window 1 (id=${windowId})\n`);
      }
    } catch {
      await watcherSendMessage("Error: iTerm2 is not running or has no open windows.").catch(() => {});
      return;
    }

    if (!windowId) {
      await watcherSendMessage("Error: Could not get iTerm2 window ID.").catch(() => {});
      return;
    }

    // Wait for iTerm2 to fully redraw after being raised and the tab switched.
    // When iTerm2 was in the background, macOS throttles rendering and the
    // window server holds a stale buffer. We also need time for the tab switch
    // to complete — if the new tab has a different terminal size, the window
    // will resize during this delay.
    await new Promise((r) => setTimeout(r, 1500));

    // Re-read the window bounds AFTER the delay so they reflect the current
    // tab's layout (the tab may have caused the window to resize).
    // We look up the window by ID to avoid targeting the wrong window if
    // another window became frontmost during the wait.
    const boundsScript = `tell application "iTerm2"
  repeat with w in windows
    if (id of w as text) is "${windowId}" then
      set wBounds to bounds of w
      set wx to item 1 of wBounds
      set wy to item 2 of wBounds
      set wx2 to item 3 of wBounds
      set wy2 to item 4 of wBounds
      return (wx as text) & "," & (wy as text) & "," & ((wx2 - wx) as text) & "," & ((wy2 - wy) as text)
    end if
  end repeat
  return ""
end tell`;
    const boundsResult = runAppleScript(boundsScript) ?? "";
    const bounds = boundsResult.trim();
    if (!bounds || !bounds.includes(",")) {
      throw new Error("Could not get window bounds from iTerm2");
    }
    process.stderr.write(`[whazaa-watch] /ss: capturing screen region ${bounds} (iTerm2 window ${windowId})\n`);
    execSync(`screencapture -x -R ${bounds} "${filePath}"`, { timeout: 15_000 });

    const buffer = readFileSync(filePath);

    if (!watcherSock) {
      throw new Error("WhatsApp socket not initialized.");
    }
    if (!watcherStatus.selfJid) {
      throw new Error("Self JID not yet known.");
    }

    const result = await watcherSock.sendMessage(watcherStatus.selfJid, {
      image: buffer,
      caption: "Screenshot",
    });

    if (result?.key?.id) {
      const id = result.key.id;
      sentMessageIds.add(id);
      setTimeout(() => sentMessageIds.delete(id), 30_000);
    }

    process.stderr.write("[whazaa-watch] /ss: screenshot sent successfully\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[whazaa-watch] /ss: error — ${msg}\n`);
    await watcherSendMessage(`Error taking screenshot: ${msg}`).catch(() => {});
  } finally {
    try {
      unlinkSync(filePath);
    } catch {
      // File may not exist if capture failed before writing — ignore
    }
  }
}

/**
 * Handle /kill N — kill a stuck Claude process and restart it in the same directory.
 * Finds the Claude PID via the session's TTY, sends SIGTERM, waits for shell prompt,
 * then types `claude` to restart.
 */
async function handleKillSession(
  target: { id: string; name: string; path: string }
): Promise<void> {
  await watcherSendMessage(`Killing Claude in session "${target.name}"...`).catch(() => {});
  process.stderr.write(`[whazaa-watch] /kill: targeting session ${target.id} ("${target.name}")\n`);

  // Get the TTY of the target session
  const ttyScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${target.id}" then
          return tty of aSession
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;

  const tty = runAppleScript(ttyScript);
  if (!tty) {
    await watcherSendMessage("Error: Could not find session TTY.").catch(() => {});
    return;
  }

  // Find the Claude PID on this TTY
  const ttyShort = tty.replace("/dev/", "");
  const psResult = spawnSync("ps", ["-eo", "pid,tty,comm"], { timeout: 5000 });
  if (psResult.status !== 0) {
    await watcherSendMessage("Error: Could not list processes.").catch(() => {});
    return;
  }

  let claudePid: string | null = null;
  const psLines = psResult.stdout.toString().split("\n");
  for (const line of psLines) {
    const trimmed = line.trim();
    if (trimmed.includes(ttyShort) && trimmed.includes("claude")) {
      claudePid = trimmed.split(/\s+/)[0];
      break;
    }
  }

  if (!claudePid) {
    // No Claude process found — might already be at shell prompt
    await watcherSendMessage("No Claude process found in that session. Restarting...").catch(() => {});
    typeIntoSession(target.id, "claude");
    await watcherSendMessage("Restarted Claude.").catch(() => {});
    return;
  }

  process.stderr.write(`[whazaa-watch] /kill: found Claude PID ${claudePid} on ${tty}\n`);

  // Kill the Claude process
  const killResult = spawnSync("kill", ["-TERM", claudePid], { timeout: 5000 });
  if (killResult.status !== 0) {
    process.stderr.write(`[whazaa-watch] /kill: SIGTERM failed, trying SIGKILL\n`);
    spawnSync("kill", ["-KILL", claudePid], { timeout: 5000 });
  }

  // Wait for the shell prompt to come back (poll up to 10 seconds)
  let atPrompt = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isClaudeRunningInSession(target.id)) {
      atPrompt = true;
      break;
    }
  }

  if (!atPrompt) {
    process.stderr.write(`[whazaa-watch] /kill: session not at prompt after 10s, sending SIGKILL\n`);
    spawnSync("kill", ["-KILL", claudePid], { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Restart Claude in the same session
  typeIntoSession(target.id, "claude");

  // Wait for Claude to start up
  await new Promise((r) => setTimeout(r, 3000));

  const paiName = getItermSessionVar(target.id);
  const label = paiName ?? (target.path ? basename(target.path) : target.name);
  await watcherSendMessage(`Killed and restarted Claude in *${label}*`).catch(() => {});
  process.stderr.write(`[whazaa-watch] /kill: restarted Claude in session ${target.id}\n`);
}

// ---------------------------------------------------------------------------
// Image download helper
// ---------------------------------------------------------------------------

/**
 * Map a WhatsApp image mimetype to a sensible file extension.
 */
function mimetypeToExt(mimetype: string | null | undefined): string {
  if (!mimetype) return "jpg";
  if (mimetype.includes("png")) return "png";
  if (mimetype.includes("webp")) return "webp";
  if (mimetype.includes("gif")) return "gif";
  return "jpg";
}

/**
 * Download a Baileys image (or video/document/sticker) message to a temp file.
 * Returns the absolute path to the saved file, or null on failure.
 *
 * The caller is responsible for deleting the file when done, but since these
 * files are meant to be read by Claude Code from the terminal, we leave them
 * in /tmp and let the OS clean them up eventually.
 */
async function downloadImageToTemp(
  msg: proto.IWebMessageInfo,
  sock: ReturnType<typeof makeWASocket>
): Promise<string | null> {
  try {
    const imageMsg = msg.message?.imageMessage ?? msg.message?.stickerMessage ?? null;
    if (!imageMsg) return null;

    const ext = mimetypeToExt(imageMsg.mimetype);
    const filePath = join(tmpdir(), `whazaa-img-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);

    const buffer = await downloadMediaMessage(
      msg as Parameters<typeof downloadMediaMessage>[0],
      "buffer",
      {},
      {
        logger: pino({ level: "silent" }),
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    writeFileSync(filePath, buffer as Buffer);
    process.stderr.write(`[whazaa-watch] Image saved to ${filePath}\n`);
    return filePath;
  } catch (err) {
    process.stderr.write(`[whazaa-watch] Image download failed: ${err}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audio download and transcription helper
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** Resolved path to the whisper binary (supports Homebrew on Apple Silicon and Intel). */
const WHISPER_BIN =
  ["/opt/homebrew/bin/whisper", "/usr/local/bin/whisper", "whisper"].find(
    (p) => p === "whisper" || existsSync(p)
  ) ?? "whisper";

/** Whisper model to use for transcription. Override with WHAZAA_WHISPER_MODEL env var. */
const WHISPER_MODEL = process.env.WHAZAA_WHISPER_MODEL || "large-v3-turbo";

/**
 * Download a Baileys audio message to a temp file and transcribe it with Whisper.
 * Returns a formatted string "[Voice note]: <transcript>" or "[Audio]: <transcript>".
 * Returns null on failure.
 *
 * @param msg       The Baileys message object
 * @param sock      The active Baileys socket (for reupload requests)
 * @param duration  Duration of the audio in seconds (from audioMessage.seconds)
 * @param isPtt     True if the message is a voice note (ptt), false for regular audio
 */
async function downloadAudioAndTranscribe(
  msg: proto.IWebMessageInfo,
  sock: ReturnType<typeof makeWASocket>,
  duration: number,
  isPtt: boolean
): Promise<string | null> {
  const audioBase = `whazaa-audio-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const audioFile = join(tmpdir(), `${audioBase}.ogg`);
  const label = isPtt ? "[Voice note]" : "[Audio]";

  // Collect all Whisper output artifacts for cleanup in finally block
  const filesToClean: string[] = [
    audioFile,
    join(tmpdir(), `${audioBase}.txt`),
    join(tmpdir(), `${audioBase}.json`),
    join(tmpdir(), `${audioBase}.vtt`),
    join(tmpdir(), `${audioBase}.srt`),
    join(tmpdir(), `${audioBase}.tsv`),
  ];

  try {
    process.stderr.write(`[whazaa-watch] Downloading audio (${duration}s, ptt=${isPtt})...\n`);

    const buffer = await downloadMediaMessage(
      msg as Parameters<typeof downloadMediaMessage>[0],
      "buffer",
      {},
      {
        logger: pino({ level: "silent" }),
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    writeFileSync(audioFile, buffer as Buffer);
    process.stderr.write(`[whazaa-watch] Audio saved to ${audioFile}, running Whisper (${WHISPER_BIN}, model=${WHISPER_MODEL})...\n`);

    // Run Whisper with a 120-second timeout.
    // Pass an expanded PATH so Whisper can find ffmpeg even when launched from
    // launchd (which only has /usr/bin:/bin:/usr/sbin:/sbin in its environment).
    await execFileAsync(
      WHISPER_BIN,
      [audioFile, "--model", WHISPER_MODEL, "--output_format", "txt", "--output_dir", tmpdir(), "--verbose", "False"],
      {
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        },
      }
    );

    // Whisper writes <basename>.txt in the output_dir
    const txtPath = join(tmpdir(), `${audioBase}.txt`);
    if (!existsSync(txtPath)) {
      process.stderr.write(`[whazaa-watch] Whisper did not produce output at ${txtPath}\n`);
      return null;
    }

    const transcript = readFileSync(txtPath, "utf-8").trim();
    process.stderr.write(`[whazaa-watch] Transcription: ${transcript.slice(0, 80)}\n`);

    return `${label}: ${transcript}`;
  } catch (err) {
    process.stderr.write(`[whazaa-watch] Audio transcription failed: ${err}\n`);
    return null;
  } finally {
    // Always clean up all Whisper output artifacts
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore — file may not exist */ }
    }
  }
}

// --- WhatsApp watcher connection ---------------------------------------------

interface WatcherConnStatus {
  connected: boolean;
  phoneNumber: string | null;
  selfJid: string | null;
  selfLid: string | null;
}

/**
 * Connect to WhatsApp via Baileys.
 * Calls onMessage whenever a self-chat message arrives.
 * Also updates the module-level watcherSock and watcherStatus.
 *
 * Returns a { cleanup, triggerLogin } object.
 */
async function connectWatcher(
  onMessage: (body: string, msgId: string, timestamp: number) => void
): Promise<{
  cleanup: () => void;
  triggerLogin: () => Promise<void>;
}> {
  const logger = pino({ level: "silent" });
  const authDir = resolveAuthDir();

  // Load persisted chat/contact store so data survives watcher restarts
  loadStoreCache();

  const connStatus: WatcherConnStatus = {
    connected: false,
    phoneNumber: null,
    selfJid: null,
    selfLid: null,
  };

  let sock: ReturnType<typeof makeWASocket> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let permanentlyLoggedOut = false;
  let stopped = false;

  const MAX_RECONNECT_DELAY_MS = 60_000;

  function scheduleReconnect(): void {
    if (stopped || permanentlyLoggedOut || reconnectTimer) return;

    reconnectAttempts++;
    const delay = Math.min(
      1_000 * Math.pow(2, reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS
    );

    process.stderr.write(
      `[whazaa-watch] WhatsApp reconnecting in ${delay / 1_000}s (attempt ${reconnectAttempts})...\n`
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) {
        openSocket().catch((err) => {
          process.stderr.write(`[whazaa-watch] Reconnect error: ${err}\n`);
        });
      }
    }, delay);
  }

  async function openSocket(): Promise<void> {
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      version,
      browser: ["Whazaa", "cli", "0.1.0"],
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger,
      // Accept RECENT, PUSH_NAME, INITIAL_BOOTSTRAP, and ON_DEMAND history so
      // chatStore and contactStore populate on connect, and on-demand history
      // fetches (fetchMessageHistory) receive their responses.
      shouldSyncHistoryMessage: (msg) => {
        const t = msg.syncType;
        const { HistorySyncType } = proto.HistorySync;
        return (
          t === HistorySyncType.RECENT ||
          t === HistorySyncType.PUSH_NAME ||
          t === HistorySyncType.INITIAL_BOOTSTRAP ||
          t === HistorySyncType.ON_DEMAND
        );
      },
    });

    // Expose socket and status to module scope for IPC handlers
    watcherSock = sock;

    // --- Populate chatStore and contactStore from initial history sync -------
    sock.ev.on("messaging-history.set", ({ chats, contacts, messages, syncType }) => {
      for (const chat of chats) {
        if (chat.id) {
          chatStore.set(chat.id, chat);
        }
      }
      for (const contact of contacts) {
        if (contact.id) {
          contactStore.set(contact.id, contact);
        }
      }

      // Store messages in messageStore keyed by JID (used as history anchors)
      if (messages && messages.length > 0) {
        for (const msg of messages) {
          const jid = msg.key?.remoteJid;
          if (!jid) continue;
          if (!messageStore.has(jid)) messageStore.set(jid, []);
          const arr = messageStore.get(jid)!;
          if (!arr.some((m) => m.key?.id === msg.key?.id)) {
            arr.push(msg);
          }
        }
        process.stderr.write(
          `[whazaa-watch] messaging-history.set: stored ${messages.length} messages across ${messageStore.size} JIDs (syncType=${syncType})\n`
        );
      }

      process.stderr.write(
        `[whazaa-watch] messaging-history.set: ${chats.length} chats, ${contacts.length} contacts — store: ${chatStore.size} chats, ${contactStore.size} contacts\n`
      );
      saveStoreCache();
    });

    // --- Populate chatStore from WhatsApp sync events -----------------------
    sock.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        if (chat.id) {
          chatStore.set(chat.id, chat);
        }
      }
      process.stderr.write(
        `[whazaa-watch] chats.upsert: ${chats.length} chats — store now has ${chatStore.size}\n`
      );
      saveStoreCache();
    });

    sock.ev.on("chats.update", (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const existing = chatStore.get(update.id);
        if (existing) {
          Object.assign(existing, update);
        } else {
          // Received update for a chat we haven't seen yet — store it as-is
          chatStore.set(update.id, update as Chat);
        }
      }
    });

    sock.ev.on("chats.delete", (jids) => {
      for (const jid of jids) {
        chatStore.delete(jid);
      }
    });

    // --- Populate contactStore from WhatsApp sync events --------------------
    sock.ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) {
        if (contact.id) {
          contactStore.set(contact.id, contact);
        }
      }
      saveStoreCache();
    });

    sock.ev.on("contacts.update", (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const existing = contactStore.get(update.id);
        if (existing) {
          Object.assign(existing, update);
        } else {
          contactStore.set(update.id, update as Contact);
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        watcherStatus.awaitingQR = true;
        // Print QR to stderr — the watcher owns the terminal
        printQR(qr);
      }

      if (connection === "open") {
        watcherStatus.awaitingQR = false;
        watcherStatus.connected = true;
        connStatus.connected = true;
        reconnectAttempts = 0;

        const jid = sock?.user?.id ?? null;
        if (jid) {
          const number = jid.split(":")[0].split("@")[0];
          connStatus.phoneNumber = number;
          connStatus.selfJid = `${number}@s.whatsapp.net`;
          watcherStatus.phoneNumber = number;
          watcherStatus.selfJid = `${number}@s.whatsapp.net`;
        }
        const lid = (sock?.user as unknown as Record<string, unknown>)?.lid as string | undefined;
        if (lid) {
          connStatus.selfLid = lid;
          watcherStatus.selfLid = lid;
        }

        process.stderr.write(
          `[whazaa-watch] WhatsApp connected. Phone: +${watcherStatus.phoneNumber ?? "unknown"}\n`
        );
      }

      if (connection === "close") {
        watcherStatus.connected = false;
        connStatus.connected = false;
        watcherSock = null;
        sock = null;

        const statusCode =
          (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
            ?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          permanentlyLoggedOut = true;
          process.stderr.write(
            "[whazaa-watch] Logged out (401). Run 'npx whazaa setup' to re-pair.\n"
          );
          return;
        }

        if (!stopped) {
          process.stderr.write("[whazaa-watch] Connection closed. Will reconnect...\n");
          scheduleReconnect();
        }
      }
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      if (!connStatus.selfJid && !connStatus.selfLid && !connStatus.phoneNumber) return;

      const stripDevice = (jid: string) => jid.replace(/:\d+@/, "@");
      const selfLid = connStatus.selfLid ? stripDevice(connStatus.selfLid) : null;

      for (const msg of messages) {
        const remoteJid = msg.key?.remoteJid;

        // Store all messages in messageStore regardless of body content
        // (needed as history anchors for fetchMessageHistory)
        if (remoteJid) {
          const jidNorm = stripDevice(remoteJid);
          if (!messageStore.has(jidNorm)) messageStore.set(jidNorm, []);
          const arr = messageStore.get(jidNorm)!;
          if (!arr.some((m) => m.key?.id === msg.key?.id)) {
            arr.push(msg);
            saveStoreCache();
          }
        }

        const body =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          null;

        // Detect image (or sticker) messages — these have no text body
        const isImage =
          !body &&
          (msg.message?.imageMessage != null || msg.message?.stickerMessage != null);

        // Detect audio/voice note messages — these have no text body
        const isAudio = !body && msg.message?.audioMessage != null;

        if (!body && !isImage && !isAudio) continue;
        if (!remoteJid) continue;

        const remoteJidNorm = stripDevice(remoteJid);
        const isSelfChat =
          (connStatus.selfJid && remoteJidNorm === stripDevice(connStatus.selfJid)) ||
          (selfLid && remoteJidNorm === selfLid) ||
          (connStatus.phoneNumber && remoteJid.startsWith(connStatus.phoneNumber));

        const msgId = msg.key?.id ?? randomUUID();
        const timestamp = Number(msg.messageTimestamp) * 1_000;

        // Skip self-echo (messages sent by this watcher process)
        if (msgId && sentMessageIds.has(msgId)) {
          sentMessageIds.delete(msgId);
          continue;
        }

        if (isSelfChat) {
          if (isImage) {
            // Download image to temp file, then deliver path (+ optional caption) to iTerm2
            const caption =
              msg.message?.imageMessage?.caption ??
              null;
            // Capture sock reference at this point for the async download
            const sockRef = sock;
            if (sockRef) {
              downloadImageToTemp(msg, sockRef).then((filePath) => {
                if (!filePath) return;
                // Deliver image path first, then caption as a separate message
                if (caption) {
                  onMessage(`${filePath} ${caption}`, msgId, timestamp);
                } else {
                  onMessage(filePath, msgId, timestamp);
                }
              }).catch((err) => {
                process.stderr.write(`[whazaa-watch] Image delivery error: ${err}\n`);
              });
            }
          } else if (isAudio) {
            // Download audio, transcribe with Whisper, deliver transcript to iTerm2
            const audioMsg = msg.message!.audioMessage!;
            const duration = audioMsg.seconds ?? 0;
            const isPtt = audioMsg.ptt === true;
            const sockRef = sock;
            if (sockRef) {
              downloadAudioAndTranscribe(msg, sockRef, duration, isPtt).then((result) => {
                if (!result) return;
                onMessage(result, msgId, timestamp);
              }).catch((err) => {
                process.stderr.write(`[whazaa-watch] Audio delivery error: ${err}\n`);
              });
            }
          } else {
            // Existing behaviour: deliver to iTerm2 and MCP client queue
            onMessage(body!, msgId, timestamp);
          }
        } else {
          // Non-self-chat message: store in per-contact queue and update directory
          const senderName =
            (msg.pushName ?? null) ||
            (msg.key?.participant
              ? null
              : null);
          trackContact(remoteJidNorm, senderName, timestamp);
          if (body) {
            enqueueContactMessage(remoteJidNorm, body, timestamp);
            process.stderr.write(
              `[whazaa-watch] Incoming from ${remoteJidNorm}${senderName ? ` (${senderName})` : ""}: ${body.slice(0, 60)}\n`
            );
          } else if (isAudio) {
            // Transcribe non-self-chat voice notes and enqueue for whatsapp_receive
            const audioMsg = msg.message!.audioMessage!;
            const duration = audioMsg.seconds ?? 0;
            const isPtt = audioMsg.ptt === true;
            const sockRef = sock;
            if (sockRef) {
              downloadAudioAndTranscribe(msg, sockRef, duration, isPtt).then((transcript) => {
                if (!transcript) return;
                enqueueContactMessage(remoteJidNorm, transcript, timestamp);
                process.stderr.write(
                  `[whazaa-watch] Transcribed audio from ${remoteJidNorm}${senderName ? ` (${senderName})` : ""}: ${transcript.slice(0, 60)}\n`
                );
              }).catch((err) => {
                process.stderr.write(`[whazaa-watch] Non-self audio transcription error: ${err}\n`);
              });
            } else {
              process.stderr.write(
                `[whazaa-watch] Incoming audio from ${remoteJidNorm}${senderName ? ` (${senderName})` : ""} (no sock, skipping transcription)\n`
              );
            }
          } else {
            process.stderr.write(
              `[whazaa-watch] Incoming image from ${remoteJidNorm}${senderName ? ` (${senderName})` : ""} (not forwarded to iTerm2)\n`
            );
          }
        }
      }
    });
  }

  await openSocket().catch((err) => {
    process.stderr.write(`[whazaa-watch] Initial connect error: ${err}\n`);
    scheduleReconnect();
  });

  async function triggerLogin(): Promise<void> {
    permanentlyLoggedOut = false;
    reconnectAttempts = 0;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // ignore
      }
      sock = null;
      watcherSock = null;
    }

    watcherStatus = {
      connected: false,
      phoneNumber: null,
      selfJid: null,
      selfLid: null,
      awaitingQR: false,
    };
    Object.assign(connStatus, {
      connected: false,
      phoneNumber: null,
      selfJid: null,
      selfLid: null,
    });

    await openSocket();
  }

  function cleanup(): void {
    stopped = true;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // ignore
      }
      sock = null;
      watcherSock = null;
    }
  }

  return { cleanup, triggerLogin };
}

// --- Main loop ---------------------------------------------------------------

export async function watch(rawSessionId?: string): Promise<void> {
  let activeSessionId = rawSessionId
    ? rawSessionId.includes(":") ? rawSessionId.split(":").pop()! : rawSessionId
    : "";
  // Keep module-level activeItermSessionId in sync with the local activeSessionId
  activeItermSessionId = activeSessionId;

  console.log(`Whazaa Watch`);
  console.log(`  Session:  ${activeSessionId || "(auto-discover)"}`);
  console.log(`  Socket:   ${IPC_SOCKET_PATH}`);
  console.log();

  let consecutiveFailures = 0;

  /**
   * When the user sends /sessions, we store the listed sessions here so
   * the next message (a number) can be interpreted as a selection.
   */
  // Graceful shutdown
  let cleanupWatcher: (() => void) | null = null;
  let ipcServer: Server | null = null;

  const shutdown = (signal: string) => {
    console.log(`\n[whazaa-watch] ${signal} received. Stopping.`);
    if (cleanupWatcher) cleanupWatcher();
    if (ipcServer) {
      ipcServer.close();
      try { unlinkSync(IPC_SOCKET_PATH); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  /**
   * Top-level message handler.
   * Intercepts /relocate commands; everything else is delivered to iTerm2
   * AND dispatched to the active IPC client queue.
   */
  function handleMessage(text: string, timestamp: number): void {
    // --- /relocate <path> (alias: /r) ---------------------------------------
    const trimmedText = text.trim();
    const relocateMatch = trimmedText.match(/^\/relocate\s+(.+)$/) || trimmedText.match(/^\/r\s+(.+)$/);
    if (relocateMatch) {
      const targetPath = relocateMatch[1].trim();
      if (targetPath) {
        const newSessionId = handleRelocate(targetPath);
        if (newSessionId) {
          activeSessionId = newSessionId;
          activeItermSessionId = newSessionId;
          process.stderr.write(`[whazaa-watch] Active session switched to ${newSessionId}\n`);
        }
        return;
      }
      process.stderr.write("[whazaa-watch] /relocate: no path provided\n");
      return;
    }

    // --- /sessions (aliases: /s) — list sessions ------------------------------
    if (trimmedText === "/sessions" || trimmedText === "/s") {
      // Clean up stale registry entries by cross-referencing live iTerm2 sessions
      const liveSessions = listClaudeSessions();
      const liveItermIds = new Set(liveSessions.map((s) => s.id));
      for (const [sid, entry] of sessionRegistry) {
        if (entry.itermSessionId && !liveItermIds.has(entry.itermSessionId)) {
          sessionRegistry.delete(sid);
          clientQueues.delete(sid);
          if (activeClientId === sid) {
            const remaining = [...sessionRegistry.values()].sort((a, b) => b.registeredAt - a.registeredAt);
            activeClientId = remaining.length > 0 ? remaining[0].sessionId : null;
          }
        }
      }

      if (liveSessions.length === 0 && sessionRegistry.size === 0) {
        watcherSendMessage("No Claude sessions found.").catch(() => {});
        return;
      }

      // If no active session tracked yet, auto-discover from live sessions
      if (!activeItermSessionId && liveSessions.length > 0) {
        const firstClaude = liveSessions.find((s) => isClaudeRunningInSession(s.id));
        if (firstClaude) {
          activeSessionId = firstClaude.id;
          activeItermSessionId = firstClaude.id;
        }
      }

      // Build display list: prefer user.paiName session variable, then registry,
      // then cwd basename, then iTerm2 session name.
      const lines = liveSessions.map((s, i) => {
        // Find registry entry by matching iTerm2 session ID
        const regEntry = [...sessionRegistry.values()].find(
          (e) => e.itermSessionId === s.id
        );
        // Read the persistent session variable set by setItermSessionVar
        const paiName = getItermSessionVar(s.id);
        const label = paiName
          ?? (regEntry ? regEntry.name : null)
          ?? (s.path ? basename(s.path) : null)
          ?? s.name;
        const isActive = regEntry
          ? activeClientId === regEntry.sessionId
          : s.id === activeItermSessionId;
        return `${i + 1}. ${label}${isActive ? " \u2190 active" : ""}`;
      });
      const reply = lines.join("\n");
      watcherSendMessage(reply).catch(() => {});
      return;
    }

    // --- /N [name] — switch to session N, optionally rename it (/1, /2 Whazaa TTS) ---
    const sessionSwitchMatch = trimmedText.match(/^\/(\d+)\s*(.*)?$/);
    if (sessionSwitchMatch) {
      const num = parseInt(sessionSwitchMatch[1], 10);
      const newName = sessionSwitchMatch[2]?.trim() || null;
      const sessions = listClaudeSessions();
      if (sessions.length === 0) {
        watcherSendMessage("No Claude sessions found.").catch(() => {});
        return;
      }
      if (num < 1 || num > sessions.length) {
        watcherSendMessage(`Invalid session number. Use /s to list (1-${sessions.length}).`).catch(() => {});
        return;
      }
      const chosen = sessions[num - 1];
      const focusScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${chosen.id}" then
          select aSession
          return "focused"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`;
      const focusResult = runAppleScript(focusScript);
      if (focusResult === "focused") {
        activeSessionId = chosen.id;
        activeItermSessionId = chosen.id;

        // Also update activeClientId to the registered session for this iTerm2 session
        const regEntry = [...sessionRegistry.values()].find(
          (e) => e.itermSessionId === chosen.id
        );
        if (regEntry) {
          activeClientId = regEntry.sessionId;
          process.stderr.write(`[whazaa-watch] /sessions: activeClientId -> ${regEntry.sessionId} ("${regEntry.name}")\n`);
        }

        // If a new name was provided, persist it as a session variable and update registry
        if (newName) {
          setItermSessionVar(chosen.id, newName);
          if (regEntry) {
            regEntry.name = newName;
          }
          process.stderr.write(`[whazaa-watch] /sessions: renamed session ${chosen.id} to "${newName}"\n`);
        }

        const displayName = newName
          ?? getItermSessionVar(chosen.id)
          ?? (regEntry ? regEntry.name : null)
          ?? (chosen.path ? basename(chosen.path) : chosen.name);
        process.stderr.write(`[whazaa-watch] /sessions: switched to iTerm2 session ${chosen.id} (${displayName})\n`);
        watcherSendMessage(`Switched to *${displayName}*`).catch(() => {});
      } else {
        watcherSendMessage("Session not found — it may have closed.").catch(() => {});
      }
      return;
    }

    // --- /ss, /screenshot — capture and send iTerm2 window screenshot ---------
    if (trimmedText === "/ss" || trimmedText === "/screenshot") {
      handleScreenshot().catch((err) => {
        process.stderr.write(`[whazaa-watch] /ss: unhandled error — ${err}\n`);
      });
      return;
    }

    // --- /kill N (alias: /k N) — kill a stuck Claude session and restart it --
    const killMatch = trimmedText.match(/^\/(?:kill|k)\s+(\d+)$/);
    if (killMatch) {
      const num = parseInt(killMatch[1], 10);
      const sessions = listClaudeSessions();
      if (sessions.length === 0) {
        watcherSendMessage("No Claude sessions found.").catch(() => {});
        return;
      }
      if (num < 1 || num > sessions.length) {
        watcherSendMessage(`Invalid session number. Use /s to list (1-${sessions.length}).`).catch(() => {});
        return;
      }
      const target = sessions[num - 1];
      handleKillSession(target).catch((err) => {
        process.stderr.write(`[whazaa-watch] /kill: unhandled error — ${err}\n`);
      });
      return;
    }

    // Dispatch to IPC clients (additive — does not replace iTerm2 delivery)
    dispatchIncomingMessage(text, timestamp);

    // Deliver to iTerm2 (always)
    deliverMessage(text);
  }

  /**
   * Smart delivery: type message into the active Claude session.
   */
  function deliverMessage(text: string): boolean {
    if (activeSessionId && isClaudeRunningInSession(activeSessionId)) {
      if (typeIntoSession(activeSessionId, text)) {
        consecutiveFailures = 0;
        return true;
      }
    }

    process.stderr.write(
      `[whazaa-watch] ${activeSessionId ? `Session ${activeSessionId} is not running Claude.` : "No cached session."} Searching for another...\n`
    );

    const found = findClaudeSession();
    process.stderr.write(
      `[whazaa-watch] findClaudeSession() returned: ${found ?? "null"}\n`
    );
    if (found && isClaudeRunningInSession(found)) {
      activeSessionId = found;
      activeItermSessionId = found;
      if (typeIntoSession(activeSessionId, text)) {
        consecutiveFailures = 0;
        return true;
      }
    }

    process.stderr.write(
      `[whazaa-watch] No running Claude session found. Starting new one...\n`
    );

    const created = createClaudeSession();
    if (created) {
      activeSessionId = created;
      activeItermSessionId = created;
      if (typeIntoSession(activeSessionId, text)) {
        consecutiveFailures = 0;
        return true;
      }
    }

    consecutiveFailures++;
    process.stderr.write(
      `[whazaa-watch] Failed to deliver message (attempt ${consecutiveFailures})\n`
    );
    return false;
  }

  // Connect to WhatsApp directly (watcher is always the sole connection owner)
  console.log(`Connecting to WhatsApp...\n`);
  const { cleanup, triggerLogin } = await connectWatcher(
    (body: string, _msgId: string, timestamp: number) => {
      console.log(`[whazaa-watch] (direct) -> ${body}`);
      handleMessage(body, timestamp);
    }
  );
  cleanupWatcher = cleanup;

  // Start the IPC server
  ipcServer = startIpcServer(triggerLogin);

  // Keep process alive
  await new Promise(() => {});
}
