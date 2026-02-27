/**
 * baileys.ts — WhatsApp/Baileys connection lifecycle management
 *
 * This module owns the single persistent WhatsApp connection for the watcher
 * process.  It is the only place that calls `makeWASocket` — all other watcher
 * modules interact with the socket through the shared `watcherSock` reference
 * held in `state.ts`.
 *
 * Responsibilities
 * ----------------
 * - Opening the Baileys WebSocket connection and supplying auth credentials.
 * - Registering all `sock.ev.on(…)` event handlers:
 *     - `messaging-history.set`  — bulk-loads chats, contacts, and messages on
 *                                  connect and on on-demand history fetches.
 *     - `chats.upsert/update/delete` — keeps `chatStore` current in real time.
 *     - `contacts.upsert/update`     — keeps `contactStore` current.
 *     - `creds.update`               — persists auth credentials after changes.
 *     - `connection.update`          — manages the connected/disconnected state,
 *                                     QR display, and automatic reconnection.
 *     - `messages.upsert`            — routes incoming messages:
 *         - Self-chat text  → `onMessage` callback → iTerm2 delivery
 *         - Self-chat image → download to temp file, then `onMessage`
 *         - Self-chat audio → transcribe via Whisper, then `onMessage`
 *         - Non-self text   → contact directory + per-contact queue
 *         - Non-self audio  → transcribe, then per-contact queue
 * - Implementing exponential-backoff reconnection (1 s → 60 s cap).
 * - Exposing `cleanup()` for graceful shutdown and `triggerLogin()` to
 *   initiate a fresh QR-pairing flow without restarting the process.
 *
 * Dependencies: state, persistence, typing, contacts, media, auth, types
 */

import { randomUUID } from "node:crypto";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  proto,
} from "@whiskeysockets/baileys";
import type { Chat, Contact } from "@whiskeysockets/baileys";
import pino from "pino";

import { resolveAuthDir, printQR } from "../auth.js";

import {
  chatStore,
  contactStore,
  messageStore,
  setWatcherSock,
  watcherStatus,
  setWatcherStatus,
  sentMessageIds,
  enqueueContactMessage,
} from "./state.js";
import { loadStoreCache, saveStoreCache } from "./persistence.js";
import { stopTypingIndicator } from "./typing.js";
import { trackContact } from "./contacts.js";
import { downloadImageToTemp, downloadAudioAndTranscribe } from "./media.js";
import { log } from "./log.js";
import type { WatcherConnStatus } from "./types.js";

/**
 * Establish the WhatsApp connection and register all event handlers.
 *
 * This is the watcher's primary entry point for WhatsApp connectivity.  It
 * must be called exactly once per process lifetime; reconnections are handled
 * internally.
 *
 * The function:
 * 1. Loads persisted auth credentials from `resolveAuthDir()`.
 * 2. Loads the chat/contact/message store cache from disk.
 * 3. Calls `openSocket()` which creates the Baileys socket and registers
 *    all `sock.ev.on(…)` handlers described in the module doc.
 * 4. If the initial connection fails, schedules a reconnect attempt.
 * 5. Returns control immediately — the socket runs asynchronously.
 *
 * @param onMessage - Callback invoked for every actionable message arriving in
 *   the user's self-chat (Saved Messages).  Receives the message body text,
 *   the Baileys message ID (used for self-echo suppression), and the message
 *   timestamp in milliseconds since epoch.  For image messages the `body` is a
 *   filesystem path to the downloaded temp file (plus optional caption); for
 *   audio/voice messages it is the Whisper transcript.
 *
 * @returns A promise that resolves to an object with two methods:
 *   - `cleanup()` — stops reconnect timers and closes the socket cleanly;
 *     called on SIGINT/SIGTERM.
 *   - `triggerLogin()` — tears down the current socket, resets all connection
 *     state, and opens a fresh socket to display a new QR code.  Used by the
 *     `login` IPC method so the user can re-pair without restarting the watcher.
 */
export async function connectWatcher(
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
  let connectionReplacedCount = 0;
  let permanentlyLoggedOut = false;
  let stopped = false;

  const MAX_RECONNECT_DELAY_MS = 60_000;

  /**
   * Schedule a reconnection attempt using exponential backoff.
   *
   * Delays follow the series 1 s, 2 s, 4 s, 8 s, … capped at 60 s.
   * No-op when the process is shutting down, the session is permanently
   * logged out, or a reconnect is already pending.
   */
  function scheduleReconnect(): void {
    if (stopped || permanentlyLoggedOut || reconnectTimer) return;

    reconnectAttempts++;
    const delay = Math.min(
      1_000 * Math.pow(2, reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS
    );

    log(`WhatsApp reconnecting in ${delay / 1_000}s (attempt ${reconnectAttempts})...`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) {
        openSocket().catch((err) => {
          log(`Reconnect error: ${err}`);
        });
      }
    }, delay);
  }

  /**
   * Create a new Baileys WebSocket and attach all event handlers.
   *
   * This function is called once on startup and again after each
   * `scheduleReconnect` delay fires.  Each invocation completely replaces
   * the previous socket; the module-level `watcherSock` reference is updated
   * via `setWatcherSock()` so IPC handlers always see the current socket.
   *
   * Key socket options:
   * - `syncFullHistory: false` — only sync recent history to avoid long delays.
   * - `markOnlineOnConnect: false` — do not show "online" presence on connect.
   * - `shouldSyncHistoryMessage` — accept RECENT, PUSH_NAME, INITIAL_BOOTSTRAP,
   *   and ON_DEMAND sync types so history fetches work correctly.
   */
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
    setWatcherSock(sock);

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
        log(`messaging-history.set: stored ${messages.length} messages across ${messageStore.size} JIDs (syncType=${syncType})`);
      }

      log(`messaging-history.set: ${chats.length} chats, ${contacts.length} contacts — store: ${chatStore.size} chats, ${contactStore.size} contacts`);
      saveStoreCache();
    });

    // --- Populate chatStore from WhatsApp sync events -----------------------
    sock.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        if (chat.id) {
          chatStore.set(chat.id, chat);
        }
      }
      log(`chats.upsert: ${chats.length} chats — store now has ${chatStore.size}`);
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
        connectionReplacedCount = 0;

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

        log(`WhatsApp connected. Phone: +${watcherStatus.phoneNumber ?? "unknown"}`);

        // Send a startup confirmation to WhatsApp so remote users know
        // the watcher is alive (especially useful after /restart).
        import("./send.js").then(({ watcherSendMessage }) => {
          watcherSendMessage("Whazaa watcher started.").catch(() => {});
        }).catch(() => {});
      }

      if (connection === "close") {
        watcherStatus.connected = false;
        connStatus.connected = false;
        stopTypingIndicator();
        setWatcherSock(null);
        sock = null;

        const statusCode =
          (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
            ?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          permanentlyLoggedOut = true;
          log("Logged out (401). Run 'npx whazaa setup' to re-pair.");
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          connectionReplacedCount++;
          if (connectionReplacedCount >= 3) {
            log(
              "Connection replaced (440) 3 times — another instance holds the session. " +
              "Stopping reconnection. Use whatsapp_restart to recover."
            );
            return;
          }
          if (!stopped) {
            log(
              `Connection replaced (440) by another instance (${connectionReplacedCount}/3). ` +
              "Retrying with longer backoff..."
            );
            reconnectAttempts = Math.max(reconnectAttempts, 4); // at least 16s
            scheduleReconnect();
          }
          return;
        }

        if (!stopped) {
          const errMsg = lastDisconnect?.error?.message ?? "unknown";
          log(`Connection closed (code=${statusCode ?? "?"}, reason=${errMsg}). Will reconnect...`);
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
                log(`Image delivery error: ${err}`);
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
                log(`Audio delivery error: ${err}`);
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
            log(`Incoming from ${remoteJidNorm}${senderName ? ` (${senderName})` : ""}: ${body.slice(0, 60)}`);
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
                log(`Transcribed audio from ${remoteJidNorm}${senderName ? ` (${senderName})` : ""}: ${transcript.slice(0, 60)}`);
              }).catch((err) => {
                log(`Non-self audio transcription error: ${err}`);
              });
            } else {
              log(`Incoming audio from ${remoteJidNorm}${senderName ? ` (${senderName})` : ""} (no sock, skipping transcription)`);
            }
          } else {
            log(`Incoming image from ${remoteJidNorm}${senderName ? ` (${senderName})` : ""} (not forwarded to iTerm2)`);
          }
        }
      }
    });
  }

  await openSocket().catch((err) => {
    log(`Initial connect error: ${err}`);
    scheduleReconnect();
  });

  /**
   * Initiate a fresh QR-pairing flow without restarting the watcher process.
   *
   * Tears down the current socket (if any), resets all connection state flags,
   * and calls `openSocket()` so a new QR code is printed to the terminal.
   * Exposed in the returned object so the IPC `login` command can invoke it.
   */
  async function triggerLogin(): Promise<void> {
    permanentlyLoggedOut = false;
    reconnectAttempts = 0;
    connectionReplacedCount = 0;

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
      setWatcherSock(null);
    }

    setWatcherStatus({
      connected: false,
      phoneNumber: null,
      selfJid: null,
      selfLid: null,
      awaitingQR: false,
    });
    Object.assign(connStatus, {
      connected: false,
      phoneNumber: null,
      selfJid: null,
      selfLid: null,
    });

    await openSocket();
  }

  /**
   * Perform a graceful shutdown of the WhatsApp connection.
   *
   * Sets the `stopped` flag so `scheduleReconnect` becomes a no-op, cancels
   * any pending reconnect timer, and closes the Baileys socket.  Called by the
   * watcher's SIGINT/SIGTERM handler to ensure clean teardown.
   */
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
      setWatcherSock(null);
    }
  }

  return { cleanup, triggerLogin };
}
