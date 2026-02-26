/**
 * ipc-server.ts — Unix Domain Socket IPC server and request dispatcher
 *
 * This module implements the watcher side of the watcher ↔ MCP communication
 * channel.  Each MCP server instance running in an individual Claude Code
 * session connects to the watcher via a Unix Domain Socket (UDS) at the path
 * defined by `IPC_SOCKET_PATH` in `ipc-client.ts`.
 *
 * Protocol
 * --------
 * - The MCP client writes a single newline-terminated JSON line (`IpcRequest`)
 *   to the socket.
 * - The watcher reads that line, dispatches to `handleRequest`, and writes a
 *   single newline-terminated JSON line (`IpcResponse`) back before closing
 *   the connection.
 * - Every request carries a `sessionId` (UUID assigned by the MCP server),
 *   a `method` name, and a free-form `params` object.  The response carries
 *   the same `id` for correlation, an `ok` flag, and either a `result` or an
 *   `error` string.
 *
 * Supported methods
 * -----------------
 * | Method        | Description |
 * |---------------|-------------|
 * | `register`    | Register an MCP session, restore or assign a display name, update iTerm2 tab title. |
 * | `rename`      | Rename the caller's session; persists name in iTerm2 user variable. |
 * | `status`      | Return current WhatsApp connection state. |
 * | `send`        | Send a text message via WhatsApp (to self-chat or a recipient). |
 * | `send_file`   | Send a local file (image/video/audio/document) via WhatsApp. |
 * | `receive`     | Drain the self-chat or a contact's incoming message queue. |
 * | `wait`        | Long-poll: block until a message arrives or the timeout elapses. |
 * | `login`       | Trigger a fresh QR pairing flow. |
 * | `contacts`    | List contacts, merging the contact directory with the Baileys store. |
 * | `chats`       | List chats (Desktop DB preferred, Baileys chatStore as fallback). |
 * | `history`     | Fetch historical messages for a JID via Baileys on-demand sync. |
 * | `tts`         | Convert text to a voice note (Kokoro TTS) and send via WhatsApp. |
 * | `speak`       | Synthesise speech and play it locally via the system speaker. |
 * | `voice_config`| Get or set voice synthesis configuration (voice, modes, personas). |
 * | `discover`    | Prune dead iTerm2 sessions and rediscover sessions by `user.paiName`. |
 *
 * Session auto-registration
 * -------------------------
 * Any method other than `register` that carries an unknown `sessionId` will
 * automatically create a minimal registry entry so requests from clients that
 * connect after a watcher restart are never silently dropped.
 *
 * Dependencies: state, contacts, send, persistence, iterm-sessions, iterm-core,
 *               tts, desktop-db, ipc-client, types
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { createServer, Socket, Server } from "node:net";

import { proto } from "@whiskeysockets/baileys";

import { textToVoiceNote, speakLocally } from "../tts.js";
import { IPC_SOCKET_PATH } from "../ipc-client.js";
import { listChats } from "../desktop-db.js";

import {
  sessionRegistry,
  activeClientId,
  setActiveClientId,
  activeItermSessionId,
  setActiveItermSessionId,
  clientQueues,
  clientWaiters,
  contactMessageQueues,
  contactDirectory,
  contactStore,
  chatStore,
  messageStore,
  watcherSock,
  watcherStatus,
  sentMessageIds,
  managedSessions,
} from "./state.js";
import {
  resolveJid,
  resolveRecipient,
  trackContact,
  MIME_MAP,
} from "./contacts.js";
import { watcherSendMessage } from "./send.js";
import { stopTypingIndicator } from "./typing.js";
import {
  loadVoiceConfig,
  saveVoiceConfig,
  saveStoreCache,
  saveSessionRegistry,
} from "./persistence.js";
import {
  findItermSessionForTermId,
  getItermSessionVar,
  setItermSessionVar,
  setItermTabName,
  deduplicateName,
  getSessionList,
  handleEndSession,
} from "./iterm-sessions.js";
import { isItermSessionAlive, runAppleScript, stripItermPrefix, snapshotAllSessions } from "./iterm-core.js";
import { log } from "./log.js";
import type { IpcRequest, IpcResponse, QueuedMessage } from "./types.js";

/**
 * Create and start the Unix Domain Socket IPC server.
 *
 * On startup, any stale socket file left by a previous watcher run is removed
 * so `server.listen()` never fails with `EADDRINUSE`.  Each incoming TCP-style
 * connection is treated as exactly one request/response exchange: the server
 * reads newline-delimited JSON, dispatches to `handleRequest`, and the handler
 * closes the socket after writing the response.
 *
 * @param triggerLoginFn - Async function that initiates a fresh QR pairing
 *   flow; passed through to the `login` IPC handler.  Provided by
 *   `connectWatcher` in `baileys.ts`.
 *
 * @returns The `net.Server` instance so the caller (`watch()` in `index.ts`)
 *   can close it during graceful shutdown.
 */
export function startIpcServer(
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
    log(`IPC server error: ${err}`);
  });

  server.listen(IPC_SOCKET_PATH, () => {
    log(`IPC server listening on ${IPC_SOCKET_PATH}`);
  });

  return server;
}

/**
 * Serialise an `IpcResponse` as a newline-terminated JSON line and write it
 * to the given socket.
 *
 * Write errors are swallowed silently because the client may have disconnected
 * before the response was ready (e.g. on timeout).
 *
 * @param socket   - The client socket returned by `createServer`'s connection
 *   callback.
 * @param response - The structured response to send.
 */
function sendResponse(socket: Socket, response: IpcResponse): void {
  try {
    socket.write(JSON.stringify(response) + "\n");
  } catch {
    // Socket may already be closed
  }
}

// ---------------------------------------------------------------------------
// Individual request handlers
// ---------------------------------------------------------------------------

// Check that WhatsApp is fully connected; sends error response and returns false if not.
function requireConnection(socket: Socket, id: string): boolean {
  if (!watcherSock || !watcherStatus.connected || !watcherStatus.selfJid) {
    sendResponse(socket, { id, ok: false, error: "Not connected to WhatsApp." });
    socket.end();
    return false;
  }
  return true;
}

// Register an MCP session, restore or assign a display name, update iTerm2 tab title.
function handleRegister(
  request: IpcRequest,
  socket: Socket,
  id: string,
  sessionId: string,
  params: Record<string, unknown>,
): void {
  const name = params.name != null ? String(params.name) : "Unknown";
  const itermHint = params.itermSessionId != null ? String(params.itermSessionId) : undefined;
  const itermId = findItermSessionForTermId(sessionId, itermHint);

  // Clean up any existing registry entries for this iTerm session to prevent
  // duplicate names (e.g. from discovered-* entries created before real registration).
  if (itermId) {
    for (const [sid, entry] of sessionRegistry) {
      if (sid !== sessionId && entry.itermSessionId === itermId) {
        log(`IPC: removing stale entry ${sid} ("${entry.name}") — replaced by ${sessionId}`);
        sessionRegistry.delete(sid);
        clientQueues.delete(sid);
      }
    }
  }

  // If this iTerm session has a persisted paiName (set by /N rename),
  // restore it — iTerm variables survive watcher restarts.
  const persistedName = itermId ? getItermSessionVar(itermId) : null;
  const rawName = persistedName ?? name;
  const effectiveName = deduplicateName(rawName, sessionId);

  sessionRegistry.set(sessionId, {
    sessionId,
    name: effectiveName,
    itermSessionId: itermId ?? undefined,
    registeredAt: Date.now(),
  });

  if (itermId) {
    if (!persistedName) {
      // Only write to iTerm var when there is no pre-existing persisted name;
      // if persistedName was already there, the var is already correct.
      setItermSessionVar(itermId, effectiveName);
    }
    // Always set the tab title so new sessions are visibly labelled.
    setItermTabName(itermId, effectiveName);
  }

  // Only claim activeClientId if no session is currently registered, or
  // if the previously-active session has since disconnected.
  if (!activeClientId || !sessionRegistry.has(activeClientId) || activeClientId === sessionId) {
    setActiveClientId(sessionId);
  }

  if (!clientQueues.has(sessionId)) {
    clientQueues.set(sessionId, []);
  }
  log(`IPC: registered client ${sessionId} (name: "${effectiveName}"${persistedName ? " [restored from iTerm]" : ""}, iTerm: ${itermId ?? "unknown"})`);
  saveSessionRegistry();
  sendResponse(socket, { id, ok: true, result: { registered: true } });
  socket.end();
}

// Rename the caller's session; persists name in iTerm2 user variable.
function handleRename(
  socket: Socket,
  id: string,
  sessionId: string,
  params: Record<string, unknown>,
): void {
  const newName = params.name != null ? String(params.name) : "";
  if (!newName) {
    sendResponse(socket, { id, ok: false, error: "name is required" });
    socket.end();
    return;
  }
  const entry = sessionRegistry.get(sessionId);
  if (entry) {
    const dedupedName = deduplicateName(newName, sessionId);
    entry.name = dedupedName;
    if (entry.itermSessionId) {
      setItermSessionVar(entry.itermSessionId, dedupedName);
      setItermTabName(entry.itermSessionId, dedupedName);
    }
    log(`IPC: renamed session ${sessionId} to "${dedupedName}"`);
    saveSessionRegistry();
    sendResponse(socket, { id, ok: true, result: { success: true, name: dedupedName } });
  } else {
    sendResponse(socket, { id, ok: false, error: "Session not registered" });
  }
  socket.end();
}

// Return current WhatsApp connection state.
function handleStatus(socket: Socket, id: string): void {
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
}

// Send a text message via WhatsApp (to self-chat or a recipient).
async function handleSend(
  socket: Socket,
  id: string,
  sessionId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const message = String(params.message ?? "");
  if (!message) {
    sendResponse(socket, { id, ok: false, error: "message is required" });
    socket.end();
    return;
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
}

// Send a local file (image/video/audio/document) via WhatsApp.
async function handleSendFile(
  socket: Socket,
  id: string,
  params: Record<string, unknown>,
): Promise<void> {
  const filePath = params.filePath != null ? String(params.filePath) : "";
  if (!filePath) {
    sendResponse(socket, { id, ok: false, error: "filePath is required" });
    socket.end();
    return;
  }

  if (!existsSync(filePath)) {
    sendResponse(socket, { id, ok: false, error: `File not found: ${filePath}` });
    socket.end();
    return;
  }

  if (!requireConnection(socket, id)) return;

  const fileRecipient = params.recipient != null ? String(params.recipient) : undefined;
  const fileCaption = params.caption != null ? String(params.caption) : undefined;
  const targetJidFile = fileRecipient ? resolveRecipient(fileRecipient) : watcherStatus.selfJid!;

  try {
    const fileBuffer = readFileSync(filePath);
    const fileName = basename(filePath);
    const ext = fileName.includes(".") ? "." + fileName.split(".").pop()!.toLowerCase() : "";
    const mimetype = MIME_MAP[ext] ?? "application/octet-stream";

    let sendContent: Record<string, unknown>;
    if (mimetype.startsWith("image/")) {
      sendContent = { image: fileBuffer, ...(fileCaption !== undefined && { caption: fileCaption }) };
    } else if (mimetype.startsWith("video/")) {
      sendContent = { video: fileBuffer, ...(fileCaption !== undefined && { caption: fileCaption }) };
    } else if (mimetype.startsWith("audio/")) {
      sendContent = { audio: fileBuffer, mimetype, ptt: false };
    } else {
      sendContent = { document: fileBuffer, mimetype, fileName, ...(fileCaption !== undefined && { caption: fileCaption }) };
    }

    stopTypingIndicator();
    const result = await watcherSock!.sendMessage(targetJidFile, sendContent as Parameters<NonNullable<typeof watcherSock>["sendMessage"]>[1]);

    if (result?.key?.id) {
      const msgId = result.key.id;
      sentMessageIds.add(msgId);
      setTimeout(() => sentMessageIds.delete(msgId), 30_000);
    }

    // Track outbound contact (non-self only)
    if (targetJidFile !== watcherStatus.selfJid) {
      trackContact(targetJidFile, null, Date.now());
    }

    sendResponse(socket, {
      id,
      ok: true,
      result: {
        fileName,
        fileSize: fileBuffer.length,
        targetJid: targetJidFile,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendResponse(socket, { id, ok: false, error: msg });
  }
  socket.end();
}

// Drain the self-chat or a contact's incoming message queue.
function handleReceive(
  socket: Socket,
  id: string,
  sessionId: string,
  params: Record<string, unknown>,
): void {
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
}

// Long-poll: block until a message arrives or the timeout elapses.
function handleWait(
  socket: Socket,
  id: string,
  sessionId: string,
  params: Record<string, unknown>,
): void {
  const timeoutMs = Number(params.timeoutMs ?? 120_000);

  // If messages are already queued, return immediately
  const existing = clientQueues.get(sessionId) ?? [];
  if (existing.length > 0) {
    const messages = existing.splice(0);
    sendResponse(socket, { id, ok: true, result: { messages } });
    socket.end();
    return;
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
}

// Trigger a fresh QR pairing flow.
function handleLogin(
  socket: Socket,
  id: string,
  triggerLoginFn: () => Promise<void>,
): void {
  triggerLoginFn().catch((err: unknown) => {
    log(`IPC login error: ${err}`);
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
}

// List contacts, merging the contact directory with the Baileys store.
function handleContacts(
  socket: Socket,
  id: string,
  params: Record<string, unknown>,
): void {
  const searchParam = params.search != null ? String(params.search).toLowerCase() : null;
  const limitParam = params.limit != null ? Number(params.limit) : 50;

  // Merge contactDirectory (session-seen) with contactStore (WhatsApp sync)
  const merged = new Map(contactDirectory);

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
      const existingEntry = merged.get(jid)!;
      if (!existingEntry.name) {
        existingEntry.name = storeContact.name ?? storeContact.notify ?? null;
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
}

// List chats (Desktop DB preferred, Baileys chatStore as fallback).
function handleChats(
  socket: Socket,
  id: string,
  params: Record<string, unknown>,
): void {
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
    return;
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

  const filteredChats = searchParam
    ? chatEntries.filter(
        (c) =>
          c.jid.includes(searchParam) ||
          c.name.toLowerCase().includes(searchParam)
      )
    : chatEntries;

  const chats = filteredChats.slice(0, limitParam);

  sendResponse(socket, { id, ok: true, result: { chats } });
  socket.end();
}

// Fetch historical messages for a JID via Baileys on-demand sync.
async function handleHistory(
  socket: Socket,
  id: string,
  params: Record<string, unknown>,
): Promise<void> {
  const jid = params.jid != null ? String(params.jid) : null;
  if (!jid) {
    sendResponse(socket, { id, ok: false, error: "jid is required" });
    socket.end();
    return;
  }
  const count = params.count != null ? Number(params.count) : 50;

  if (!watcherSock) {
    sendResponse(socket, { id, ok: false, error: "Not connected" });
    socket.end();
    return;
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
    return;
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
    return;
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
}

// Convert text to a voice note (Kokoro TTS) and send via WhatsApp.
async function handleTts(
  socket: Socket,
  id: string,
  params: Record<string, unknown>,
): Promise<void> {
  const ttsText = params.text != null ? String(params.text) : "";
  if (!ttsText.trim()) {
    sendResponse(socket, { id, ok: false, error: "text is required for TTS" });
    socket.end();
    return;
  }

  // Use explicitly-provided voice, or fall back to configured defaultVoice
  const ttsVoice = params.voice != null ? String(params.voice) : loadVoiceConfig().defaultVoice;
  const ttsRecipient = params.jid != null ? String(params.jid) : undefined;

  if (!requireConnection(socket, id)) return;

  const targetJid = ttsRecipient ? resolveRecipient(ttsRecipient) : watcherStatus.selfJid!;

  try {
    const audioBuffer = await textToVoiceNote(ttsText, ttsVoice);

    const result = await watcherSock!.sendMessage(targetJid, {
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
}

// Synthesise speech and play it locally via the system speaker.
async function handleSpeak(
  socket: Socket,
  id: string,
  params: Record<string, unknown>,
): Promise<void> {
  const speakText = params.text != null ? String(params.text) : "";
  if (!speakText.trim()) {
    sendResponse(socket, { id, ok: false, error: "text is required for speak" });
    socket.end();
    return;
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
}

// Get or set voice synthesis configuration (voice, modes, personas).
function handleVoiceConfig(
  socket: Socket,
  id: string,
  params: Record<string, unknown>,
): void {
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
}

// Resolve a session target by 1-based index or name substring.
function resolveSessionTarget(
  target: string
): { id: string; name: string; path: string; type: "claude" | "terminal"; paiName: string | null; atPrompt: boolean } | null {
  const sessions = getSessionList();
  // Try as 1-based index
  const num = parseInt(target, 10);
  if (!isNaN(num) && num >= 1 && num <= sessions.length) {
    return sessions[num - 1];
  }
  // Try as name substring (case-insensitive)
  const lower = target.toLowerCase();
  return sessions.find((s) => {
    const label = s.paiName ?? s.name;
    return label.toLowerCase().includes(lower);
  }) ?? null;
}

// List all managed sessions with index, name, type, and active marker.
function handleSessions(socket: Socket, id: string): void {
  const allSessions = getSessionList();
  const sessions = allSessions.map((s, i) => {
    const regEntry = [...sessionRegistry.values()].find((e) => e.itermSessionId === s.id);
    const label = s.paiName ?? (regEntry ? regEntry.name : null) ?? s.name;
    return {
      index: i + 1,
      name: label,
      type: s.type,
      active: s.id === activeItermSessionId,
    };
  });
  sendResponse(socket, { id, ok: true, result: { sessions } });
  socket.end();
}

// Switch the active iTerm2 session by index or name substring.
function handleSwitch(socket: Socket, id: string, params: Record<string, unknown>): void {
  const target = params.target != null ? String(params.target) : "";
  if (!target) {
    sendResponse(socket, { id, ok: false, error: "target is required (session number or name)" });
    socket.end();
    return;
  }
  const session = resolveSessionTarget(target);
  if (!session) {
    sendResponse(socket, { id, ok: false, error: `No session matching "${target}". Use whatsapp_sessions to list.` });
    socket.end();
    return;
  }

  // Focus the session in iTerm2 using the same AppleScript pattern as the /N command
  const escapedId = session.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const focusScript = `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${escapedId}" then
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
    setActiveItermSessionId(session.id);
    const regEntry = [...sessionRegistry.values()].find((e) => e.itermSessionId === session.id);
    if (regEntry) setActiveClientId(regEntry.sessionId);
    const label = session.paiName ?? (regEntry ? regEntry.name : null) ?? session.name;
    saveSessionRegistry();
    sendResponse(socket, { id, ok: true, result: { switched: true, name: label } });
  } else {
    sendResponse(socket, { id, ok: false, error: "Session not found in iTerm2 — it may have closed." });
  }
  socket.end();
}

// End a session (close tab + cleanup) by index or name substring.
async function handleEndSessionIpc(socket: Socket, id: string, params: Record<string, unknown>): Promise<void> {
  const target = params.target != null ? String(params.target) : "";
  if (!target) {
    sendResponse(socket, { id, ok: false, error: "target is required (session number or name)" });
    socket.end();
    return;
  }
  const session = resolveSessionTarget(target);
  if (!session) {
    sendResponse(socket, { id, ok: false, error: `No session matching "${target}". Use whatsapp_sessions to list.` });
    socket.end();
    return;
  }

  try {
    await handleEndSession(session);
    sendResponse(socket, { id, ok: true, result: { ended: true, name: session.paiName ?? session.name } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendResponse(socket, { id, ok: false, error: msg });
  }
  socket.end();
}

/**
 * Prune dead sessions and scan iTerm2 for sessions with user.paiName.
 * Returns { alive, pruned, discovered } arrays of session names.
 * Called by handleDiscover (IPC) and by the watcher startup sequence.
 */
export function discoverSessions(): { alive: string[]; pruned: string[]; discovered: string[] } {
  const alive: string[] = [];
  const pruned: string[] = [];
  const discovered: string[] = [];

  // Single AppleScript call to get all live session data (replaces
  // N×isItermSessionAlive + separate paiName scan AppleScript).
  const snapshot = snapshotAllSessions();
  const liveIds = new Set(snapshot.map((s) => s.id));

  // Safety: if snapshot returned 0 sessions but we have registered sessions
  // with iTerm IDs, AppleScript may have failed (screen locked, iTerm not
  // responding, brief startup race).  Skip pruning to avoid wiping the registry.
  const hasRegisteredItermSessions = [...sessionRegistry.values()].some((e) => e.itermSessionId);
  if (snapshot.length === 0 && (hasRegisteredItermSessions || managedSessions.size > 0)) {
    log("discover: snapshot returned 0 sessions but registry is non-empty — skipping pruning (AppleScript may have failed)");
    return { alive: [...sessionRegistry.values()].map((e) => e.name), pruned: [], discovered: [] };
  }

  // Phase 1: Prune dead sessions from the registry
  for (const [sid, entry] of sessionRegistry) {
    if (!entry.itermSessionId || liveIds.has(entry.itermSessionId)) {
      alive.push(entry.name);
    } else {
      pruned.push(entry.name);
      sessionRegistry.delete(sid);
      clientQueues.delete(sid);
      clientWaiters.delete(sid);
      if (activeClientId === sid) {
        setActiveClientId(null);
      }
      log(`discover: pruned dead session ${sid} ("${entry.name}")`);
    }
  }

  // Also prune dead entries from managedSessions
  for (const [msid, msEntry] of managedSessions) {
    if (!liveIds.has(msid)) {
      pruned.push(msEntry.name);
      managedSessions.delete(msid);
      log(`discover: pruned dead managed session ${msid} ("${msEntry.name}")`);
    }
  }

  // Phase 2: Discover sessions with user.paiName from the snapshot
  const knownItermIds = new Set(
    [...sessionRegistry.values()]
      .map((e) => e.itermSessionId)
      .filter(Boolean)
  );
  for (const snap of snapshot) {
    if (!snap.paiName || knownItermIds.has(snap.id)) continue;
    const syntheticId = `discovered-${snap.id}`;
    const dedupedName = deduplicateName(snap.paiName, syntheticId);
    sessionRegistry.set(syntheticId, {
      sessionId: syntheticId,
      name: dedupedName,
      itermSessionId: snap.id,
      registeredAt: Date.now(),
    });
    discovered.push(dedupedName);
    log(`discover: found session ${snap.id} ("${dedupedName}")`);
  }

  // Persist the updated registry after any mutations
  if (pruned.length > 0 || discovered.length > 0) {
    saveSessionRegistry();
  }

  return { alive, pruned, discovered };
}

// IPC handler wrapper for discoverSessions.
function handleDiscover(socket: Socket, id: string): void {
  const result = discoverSessions();
  sendResponse(socket, { id, ok: true, result });
  socket.end();
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

// Route an IPC request to the appropriate handler.
async function handleRequest(
  request: IpcRequest,
  socket: Socket,
  triggerLoginFn: () => Promise<void>
): Promise<void> {
  const { id, sessionId, method, params } = request;

  // Auto-register unknown sessions on any IPC call (handles watcher restarts
  // where the in-memory registry is cleared but MCP clients are still running)
  if (method !== "register" && sessionId && !sessionRegistry.has(sessionId)) {
    // Use itermSessionId from the request (new clients), or extract UUID from
    // TERM_SESSION_ID which has format "w0t2p0:UUID" (same as ITERM_SESSION_ID)
    // Extract iTerm UUID from the hint (string manipulation only — no AppleScript)
    // to avoid blocking the event loop and causing Baileys WebSocket timeouts.
    const itermHint = request.itermSessionId ?? sessionId;
    const itermId = stripItermPrefix(itermHint) ?? itermHint;

    // Clean up discovered-* or other stale entries for this iTerm session
    // (same logic as handleRegister) to prevent duplicates.
    let inheritedName: string | null = null;
    if (itermId) {
      for (const [sid, entry] of sessionRegistry) {
        if (sid !== sessionId && entry.itermSessionId === itermId) {
          inheritedName = entry.name !== "Unknown" ? entry.name : null;
          log(`IPC: auto-reg removing stale entry ${sid} ("${entry.name}") — replaced by ${sessionId}`);
          sessionRegistry.delete(sid);
          clientQueues.delete(sid);
        }
      }
    }

    const autoName = inheritedName ?? "Unknown";
    sessionRegistry.set(sessionId, {
      sessionId,
      name: autoName,
      itermSessionId: itermId ?? undefined,
      registeredAt: Date.now(),
    });
    if (!clientQueues.has(sessionId)) {
      clientQueues.set(sessionId, []);
    }
    log(`IPC: auto-registered client ${sessionId} (name: "${autoName}", iTerm: ${itermId ?? "unknown"})`);
    saveSessionRegistry();
  }

  switch (method) {
    case "register":     return handleRegister(request, socket, id, sessionId, params);
    case "rename":       return handleRename(socket, id, sessionId, params);
    case "status":       return handleStatus(socket, id);
    case "send":         return handleSend(socket, id, sessionId, params);
    case "send_file":    return handleSendFile(socket, id, params);
    case "receive":      return handleReceive(socket, id, sessionId, params);
    case "wait":         return handleWait(socket, id, sessionId, params);
    case "login":        return handleLogin(socket, id, triggerLoginFn);
    case "contacts":     return handleContacts(socket, id, params);
    case "chats":        return handleChats(socket, id, params);
    case "history":      return handleHistory(socket, id, params);
    case "tts":          return handleTts(socket, id, params);
    case "speak":        return handleSpeak(socket, id, params);
    case "voice_config": return handleVoiceConfig(socket, id, params);
    case "discover":     return handleDiscover(socket, id);
    case "sessions":     return handleSessions(socket, id);
    case "switch":       return handleSwitch(socket, id, params);
    case "end_session":  return handleEndSessionIpc(socket, id, params);
    default:
      sendResponse(socket, { id, ok: false, error: `Unknown method: ${method}` });
      socket.end();
  }
}
