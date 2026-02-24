/**
 * state.ts — Centralized mutable state for the watcher subsystem.
 *
 * All shared runtime state lives in this single module so that every other
 * watcher module can import exactly the pieces it needs without creating
 * circular dependencies.  No business logic belongs here — only plain data
 * structures and the minimal setter functions required because ES-module
 * bindings are live (reading an exported `let` always reflects the current
 * value, but you cannot re-assign it from outside the module without a
 * dedicated setter).
 *
 * Architecture note: this module intentionally has no imports from other
 * watcher modules.  It only imports from the Baileys library and from
 * types.ts, keeping it at the very bottom of the intra-package dependency
 * graph alongside types.ts.
 */

import type { Chat, Contact } from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";
import type makeWASocket from "@whiskeysockets/baileys";

import type {
  RegisteredSession,
  QueuedMessage,
  ContactEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Session routing state
// ---------------------------------------------------------------------------

/**
 * Registry of all MCP client sessions that have called `whatsapp_receive` and
 * are therefore eligible to receive incoming message deliveries.
 * Keyed by TERM_SESSION_ID.
 */
export const sessionRegistry = new Map<string, RegisteredSession>();

/**
 * Sessions explicitly opened via the `/t` iTerm2 command.
 * Keyed by iTerm2 session UUID (not TERM_SESSION_ID).
 * Used to track which terminal tabs were created by Whazaa so they can be
 * closed or listed independently of the MCP session registry.
 */
export const managedSessions = new Map<string, { name: string; createdAt: number }>();

/**
 * The TERM_SESSION_ID of the MCP client that should receive the next incoming
 * WhatsApp message.  Updated when a client calls `whatsapp_receive` and when
 * the `/N` switch command routes delivery to a different session.
 * Null when no client is actively listening.
 */
export let activeClientId: string | null = null;

/**
 * Update the active MCP client receiving incoming messages.
 *
 * @param id  The TERM_SESSION_ID to make active, or null to clear.
 */
export function setActiveClientId(id: string | null): void {
  activeClientId = id;
}

/**
 * The iTerm2 session UUID of the Claude window that is currently the target
 * for message delivery side-effects (e.g. pasting into the terminal).
 * Set by `/N` switch commands and by the delivery fallback logic.
 * Exposed at module level so handlers like `handleScreenshot()` can read it
 * without needing to pass it as a parameter.
 */
export let activeItermSessionId: string = "";

/**
 * Update the active iTerm2 session UUID.
 *
 * @param id  The iTerm2 session UUID string (may be empty to clear).
 */
export function setActiveItermSessionId(id: string): void {
  activeItermSessionId = id;
}

/**
 * Snapshot of the iTerm2 session list produced by the most recent `/s` call.
 * Used by `/N` to guarantee that the session numbers presented to the user
 * match the numbers they type.  Automatically invalidated 60 seconds after
 * capture to prevent stale routing.
 */
export let cachedSessionList: Array<{ id: string; name: string; path: string; type: "claude" | "terminal" }> | null = null;

/**
 * Unix epoch milliseconds at which `cachedSessionList` was populated.
 * Used together with the 60-second TTL check in the `/N` handler.
 */
export let cachedSessionListTime = 0;

/**
 * Atomically replace the cached session list snapshot.
 *
 * @param list  The new session list, or null to invalidate.
 * @param time  The capture timestamp in Unix epoch milliseconds.
 */
export function setCachedSessionList(
  list: Array<{ id: string; name: string; path: string; type: "claude" | "terminal" }> | null,
  time: number
): void {
  cachedSessionList = list;
  cachedSessionListTime = time;
}

// ---------------------------------------------------------------------------
// Per-client message queues
// ---------------------------------------------------------------------------

/**
 * Per-client pending message queues, keyed by TERM_SESSION_ID.
 *
 * When an incoming WhatsApp message is dispatched and there is no long-poll
 * waiter for the target client, the formatted message is buffered here and
 * returned on the next `whatsapp_receive` call instead.
 */
export const clientQueues = new Map<string, QueuedMessage[]>();

/**
 * Per-client long-poll resolver callbacks, keyed by TERM_SESSION_ID.
 *
 * When a `whatsapp_receive` call arrives and the queue is empty, its Promise
 * resolve function is pushed here.  The next incoming message will call all
 * waiting resolvers immediately rather than buffering the message.
 */
export const clientWaiters = new Map<
  string,
  Array<(msgs: QueuedMessage[]) => void>
>();

/**
 * Per-JID pending message queues for contacts other than the self-chat.
 * Key is the normalized JID (e.g. "41764502698@s.whatsapp.net").
 *
 * These queues feed the `whatsapp_history` and contact-specific receive paths.
 * Self-chat messages bypass this map and go directly to `clientQueues`.
 */
export const contactMessageQueues = new Map<string, QueuedMessage[]>();

/**
 * In-memory directory of recently active contacts, keyed by normalized JID.
 *
 * An entry is created or refreshed whenever a message is received from or
 * sent to any JID other than the authenticated account's own JID.  Used by
 * `resolveNameToJid()` to support human-readable name-based addressing.
 */
export const contactDirectory = new Map<string, ContactEntry>();

// ---------------------------------------------------------------------------
// WhatsApp stores
// ---------------------------------------------------------------------------

/**
 * Lightweight in-memory chat store mirroring the Baileys chat list.
 *
 * Populated by `chats.upsert`, `chats.update`, and `chats.delete` Baileys
 * events.  With `syncFullHistory: false`, WhatsApp typically pushes 100-150
 * recent chats on first connect.  The store is persisted to disk by
 * `saveStoreCache()` in persistence.ts and reloaded at startup so the list
 * survives watcher restarts.  Keyed by JID.
 */
export const chatStore = new Map<string, Chat>();

/**
 * In-memory contact store mirroring the Baileys contact roster.
 *
 * Populated by `contacts.upsert` and `contacts.update` Baileys events.
 * Used for display-name lookups in message formatting.  Persisted alongside
 * the chat store.  Keyed by the Contact's `id` field (a JID).
 */
export const contactStore = new Map<string, Contact>();

/**
 * In-memory message store keyed by normalized JID.
 *
 * Stores raw Baileys `IWebMessageInfo` objects per conversation.  The primary
 * use is providing anchor messages for on-demand history fetches
 * (`fetchMessageHistory`).  Populated from:
 *  - `messaging-history.set` events (initial sync batch)
 *  - `messages.upsert` events (live incoming messages)
 *  - Sent-message results (outbound confirmation)
 *
 * Persisted to disk with only essential fields (`key`, `messageTimestamp`,
 * `message`) to keep the cache file size manageable.
 */
export const messageStore = new Map<string, proto.IWebMessageInfo[]>();

// ---------------------------------------------------------------------------
// Baileys socket reference
// ---------------------------------------------------------------------------

/**
 * The active Baileys WebSocket connection instance.
 *
 * Set to a live socket object once the watcher successfully opens a
 * connection and cleared back to null on disconnect or logout.  All
 * outbound operations (send, typing, history fetch) must guard against
 * this being null before proceeding.
 */
export let watcherSock: ReturnType<typeof makeWASocket> | null = null;

/**
 * Replace the active Baileys socket reference.
 *
 * Pass null to signal that the connection has been closed and no outbound
 * operations should be attempted until a new socket is provided.
 *
 * @param sock  The new Baileys socket, or null to clear.
 */
export function setWatcherSock(sock: ReturnType<typeof makeWASocket> | null): void {
  watcherSock = sock;
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

/**
 * Current watcher connection state snapshot.
 *
 * Updated atomically via `setWatcherStatus()` on every `connection.update`
 * Baileys event.  The `connected` flag is the authoritative signal — all
 * outbound operations should check it before proceeding.  `awaitingQR` is
 * true only during the brief window between socket open and QR code scan.
 */
export let watcherStatus = {
  /** True once the Baileys connection is fully open and ready. */
  connected: false,
  /** International phone number of the authenticated account, or null. */
  phoneNumber: null as string | null,
  /** Primary JID of the authenticated account (e.g. "41764502698@s.whatsapp.net"), or null. */
  selfJid: null as string | null,
  /** Linked-device LID assigned by WhatsApp servers, or null for legacy accounts. */
  selfLid: null as string | null,
  /** True when the socket has opened but the QR code has not yet been scanned. */
  awaitingQR: false,
};

/**
 * Atomically replace the entire watcher connection status object.
 *
 * Callers should pass a complete new status object rather than mutating the
 * existing one so that any snapshot references taken before this call remain
 * consistent.
 *
 * @param status  The new status object to set.
 */
export function setWatcherStatus(status: typeof watcherStatus): void {
  watcherStatus = status;
}

// ---------------------------------------------------------------------------
// Self-echo suppression
// ---------------------------------------------------------------------------

/**
 * Set of Baileys message key IDs for messages sent by this watcher process.
 *
 * When Baileys echoes an outbound message back through the `messages.upsert`
 * event (which happens on the multi-device protocol), the incoming-message
 * handler checks this set and discards the echo.  Each ID is automatically
 * removed 30 seconds after insertion to bound the set's memory footprint.
 */
export const sentMessageIds = new Set<string>();

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

/**
 * Deliver a formatted incoming WhatsApp message to the active MCP client.
 *
 * If a long-poll waiter is registered for the active client, the message is
 * handed to it immediately and the queue remains empty.  Otherwise the message
 * is buffered in the client's queue to be drained by the next
 * `whatsapp_receive` call.
 *
 * Only the `activeClientId` session receives the message through this path;
 * contact-specific queuing is handled separately by `enqueueContactMessage`.
 *
 * @param body       The fully-formatted message text to deliver.
 * @param timestamp  Unix epoch milliseconds at which the message was received.
 */
export function dispatchIncomingMessage(body: string, timestamp: number): void {
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

/**
 * Append a formatted message to the per-JID contact queue.
 *
 * The contact queue feeds the contact-specific receive path (e.g. listening
 * to a single conversation) as opposed to the global active-client queue fed
 * by `dispatchIncomingMessage`.  The queue is created on first use.
 *
 * @param jid        The normalized JID of the contact whose queue to append to.
 * @param body       The fully-formatted message text.
 * @param timestamp  Unix epoch milliseconds at which the message was received.
 */
export function enqueueContactMessage(jid: string, body: string, timestamp: number): void {
  if (!contactMessageQueues.has(jid)) {
    contactMessageQueues.set(jid, []);
  }
  contactMessageQueues.get(jid)!.push({ body, timestamp });
}
