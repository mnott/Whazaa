/**
 * whatsapp.ts — WhatsApp connection manager
 *
 * Manages the Baileys WebSocket connection with:
 *   - Automatic self-JID detection (no hardcoded phone number)
 *   - QR pairing flow on first run, silent reconnect thereafter
 *   - Exponential backoff reconnection (1s -> 60s max)
 *   - Deduplication of sent messages to prevent self-echo
 *   - Markdown -> WhatsApp format conversion
 *   - All Baileys output silenced to avoid MCP stdio pollution
 */

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { resolveAuthDir, printQR } from "./auth.js";

// --- Types -------------------------------------------------------------------

export interface QueuedMessage {
  body: string;
  timestamp: number;
}

export interface WhatsAppStatus {
  connected: boolean;
  /** E.164 phone number without leading +, e.g. "1234567890" */
  phoneNumber: string | null;
  /** Full WhatsApp JID, e.g. "1234567890@s.whatsapp.net" */
  selfJid: string | null;
  /** Linked Identity JID, e.g. "123456789012@lid" — used for self-chat */
  selfLid: string | null;
  /** Whether a QR scan is currently required */
  awaitingQR: boolean;
}

// --- Module state ------------------------------------------------------------

/** The active Baileys socket (null when disconnected) */
let sock: ReturnType<typeof makeWASocket> | null = null;

/** Incoming messages from the phone waiting to be drained */
const messageQueue: QueuedMessage[] = [];

/** IDs of messages sent by this process — used to suppress self-echo */
const sentMessageIds = new Set<string>();

/** Current connection state exposed to MCP tools */
let status: WhatsAppStatus = {
  connected: false,
  phoneNumber: null,
  selfJid: null,
  selfLid: null,
  awaitingQR: false,
};

/** Reconnect scheduling */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;

/** Set to true on loggedOut — stops all reconnect attempts */
let permanentlyLoggedOut = false;

/** Resolve when the first connection attempt completes (either open or qr shown) */
let initResolve: (() => void) | null = null;

/** Resolve when the connection is fully open (used by setup mode) */
let connectedResolve: ((phoneNumber: string) => void) | null = null;

/** Resolve when permanently logged out / 401 (used by setup mode) */
let logoutResolve: (() => void) | null = null;

/** Resolve when a QR code is emitted (used by setup mode to detect stale creds) */
let qrResolve: (() => void) | null = null;

// --- Internal helpers --------------------------------------------------------

/**
 * Silenced Pino logger — CRITICAL: Baileys must not write to stdout.
 * Stdout is the MCP JSON-RPC transport; any non-JSON output breaks the protocol.
 */
const logger = pino({ level: "silent" });

/**
 * Convert common Markdown syntax to WhatsApp formatting codes.
 *
 *   **bold**   -> *bold*   (WhatsApp bold)
 *   *italic*   -> _italic_ (WhatsApp italic)
 *   `code`     -> ```code``` (WhatsApp monospace)
 */
function markdownToWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "_$1_")
    .replace(/`([^`]+)`/g, "```$1```");
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 * Does nothing if permanently logged out or a timer is already pending.
 */
function scheduleReconnect(): void {
  if (permanentlyLoggedOut) return;
  if (reconnectTimer) return; // already scheduled

  reconnectAttempts++;
  const delay = Math.min(
    1_000 * Math.pow(2, reconnectAttempts - 1),
    MAX_RECONNECT_DELAY_MS
  );

  process.stderr.write(
    `[whazaa] Reconnecting in ${delay / 1_000}s (attempt ${reconnectAttempts})...\n`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => {
      process.stderr.write(`[whazaa] Reconnect error: ${err}\n`);
    });
  }, delay);
}

// --- Core connection ---------------------------------------------------------

/**
 * Open (or re-open) the Baileys WebSocket connection.
 * On first run with no saved credentials, Baileys emits a QR code which we
 * display on stderr. After the user scans it, credentials are saved and all
 * subsequent runs connect automatically without showing a QR.
 */
async function connect(): Promise<void> {
  const authDir = resolveAuthDir();
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    version,
    // Browser string shown in WhatsApp's linked devices list
    browser: ["Whazaa", "cli", "0.1.0"],
    printQRInTerminal: false, // We handle QR display ourselves on stderr
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger,
  });

  // Persist credentials whenever they are updated
  sock.ev.on("creds.update", saveCreds);

  // Handle connection lifecycle
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    // Display QR code when pairing is needed
    if (qr) {
      status.awaitingQR = true;
      printQR(qr);

      // Resolve init promise so MCP server starts up even while awaiting scan
      if (initResolve) {
        initResolve();
        initResolve = null;
      }

      // Notify setup mode that a QR was emitted (signals stale/invalid creds)
      if (qrResolve) {
        qrResolve();
        qrResolve = null;
      }
    }

    if (connection === "open") {
      status.awaitingQR = false;
      status.connected = true;
      reconnectAttempts = 0;

      // Derive phone number and LID from the authenticated user
      const jid = sock?.user?.id ?? null;
      if (jid) {
        // JID format: "1234567890:12@s.whatsapp.net" or "1234567890@s.whatsapp.net"
        const number = jid.split(":")[0].split("@")[0];
        status.phoneNumber = number;
        status.selfJid = `${number}@s.whatsapp.net`;
      }
      // Capture LID (Linked Identity) — self-chat uses this format
      const lid = (sock?.user as unknown as Record<string, unknown>)?.lid as string | undefined;
      if (lid) {
        status.selfLid = lid;
      }

      process.stderr.write(
        `[whazaa] Connected. Phone: +${status.phoneNumber ?? "unknown"}\n`
      );

      // Resolve init promise on successful connection
      if (initResolve) {
        initResolve();
        initResolve = null;
      }

      // Resolve the "fully connected" promise used by setup mode
      if (connectedResolve) {
        connectedResolve(status.phoneNumber ?? "unknown");
        connectedResolve = null;
      }
    }

    if (connection === "close") {
      status.connected = false;

      const statusCode =
        (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
          ?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        // Auth is invalid (401). Stop reconnecting — user must re-pair.
        permanentlyLoggedOut = true;
        process.stderr.write(
          "[whazaa] Logged out (401). Run whatsapp_login to re-pair.\n"
        );

        if (logoutResolve) {
          logoutResolve();
          logoutResolve = null;
        }

        if (initResolve) {
          initResolve();
          initResolve = null;
        }
        return;
      }

      process.stderr.write("[whazaa] Connection closed. Will reconnect...\n");
      scheduleReconnect();
    }
  });

  // Handle incoming messages — only self-chat messages are queued
  sock.ev.on("messages.upsert", ({ type, messages }) => {
    // Accept both "notify" (real-time) and "append" (history sync / self-sent)
    // Only skip "set" which is bulk history sync on first connect

    for (const msg of messages) {
      const remoteJid = msg.key?.remoteJid;
      const body =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        null;

      // Filter to self-chat only: match selfJid, selfLid, or phone number prefix
      // Strip device suffix (e.g. ":6" or ":12") for comparison
      const stripDevice = (jid: string) => jid.replace(/:\d+@/, "@");
      const selfNumber = status.phoneNumber;
      const selfLid = status.selfLid ? stripDevice(status.selfLid) : null;
      const remoteJidNorm = remoteJid ? stripDevice(remoteJid) : null;
      const isSelfChat =
        (status.selfJid && remoteJidNorm === stripDevice(status.selfJid)) ||
        (selfLid && remoteJidNorm === selfLid) ||
        (selfNumber && remoteJid?.startsWith(selfNumber));

      if (!isSelfChat) {
        continue;
      }

      // Deduplicate: skip messages sent by this process
      const msgId = msg.key?.id;
      if (msgId && sentMessageIds.has(msgId)) {
        sentMessageIds.delete(msgId);
        continue;
      }

      if (body) {
        const ts = Number(msg.messageTimestamp) * 1_000;
        messageQueue.push({ body, timestamp: ts });
        notifyMessageWaiters();

        // Write to signal file so background watchers can detect new messages
        const signalFile = "/tmp/whazaa-incoming.log";
        const line = `[${new Date(ts).toISOString()}] ${body}\n`;
        try { appendFileSync(signalFile, line); } catch { /* ignore */ }
      }
    }
  });
}

// --- Public API --------------------------------------------------------------

/**
 * Initialize the WhatsApp connection.
 * Resolves once the connection is open OR a QR code has been emitted
 * (so the MCP server can start handling tool calls immediately).
 */
export async function initialize(): Promise<void> {
  await new Promise<void>((resolve) => {
    initResolve = resolve;
    connect().catch((err) => {
      process.stderr.write(`[whazaa] Init error: ${err}\n`);
      resolve(); // Don't block MCP startup on connection failure
    });
  });
}

/**
 * Wait until the WhatsApp connection is fully open.
 * Used by setup mode to block until the user has scanned the QR code.
 * If already connected, resolves immediately.
 */
export function waitForConnection(): Promise<string> {
  if (status.connected && status.phoneNumber) {
    return Promise.resolve(status.phoneNumber);
  }
  return new Promise<string>((resolve) => {
    connectedResolve = resolve;
  });
}

/**
 * Returns a promise that resolves when a 401 (logged out) is detected.
 * Used by setup mode to detect stale credentials.
 */
export function waitForLogout(): Promise<void> {
  if (permanentlyLoggedOut) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    logoutResolve = resolve;
  });
}

/**
 * Returns a promise that resolves when Baileys emits a QR code.
 * Used by setup mode to detect that existing credentials are stale
 * (a QR appearing during reconnect means the saved session is invalid).
 */
export function waitForQR(): Promise<void> {
  return new Promise<void>((resolve) => {
    qrResolve = resolve;
  });
}

/**
 * Trigger a new QR pairing flow.
 * Closes the current socket (if any) and reconnects with fresh state
 * so Baileys emits a new QR code.
 */
export async function triggerLogin(): Promise<void> {
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
      // Ignore errors on close
    }
    sock = null;
  }

  status = {
    connected: false,
    phoneNumber: null,
    selfJid: null,
    selfLid: null,
    awaitingQR: false,
  };

  // Reconnect — Baileys will emit a QR if no creds are present
  await connect();
}

/**
 * Return the current connection status snapshot.
 */
export function getStatus(): WhatsAppStatus {
  return { ...status };
}

/**
 * Send a message to the authenticated user's own WhatsApp number.
 * Converts Markdown to WhatsApp formatting before sending.
 *
 * @throws If not connected or socket is unavailable.
 */
export async function sendMessage(message: string): Promise<void> {
  if (!sock) {
    throw new Error(
      "WhatsApp socket not initialized. Is the connection open?"
    );
  }
  if (!status.connected) {
    throw new Error(
      "WhatsApp is not connected. Check status with whatsapp_status."
    );
  }
  if (!status.selfJid) {
    throw new Error(
      "Self JID not yet known. Wait for connection to fully open."
    );
  }

  const text = markdownToWhatsApp(message);
  const result = await sock.sendMessage(status.selfJid, { text });

  // Register the sent message ID for deduplication
  if (result?.key?.id) {
    const id = result.key.id;
    sentMessageIds.add(id);
    // Auto-expire after 30 seconds to prevent unbounded growth
    setTimeout(() => {
      sentMessageIds.delete(id);
    }, 30_000);
  }
}

/**
 * Drain and return all queued incoming messages, then clear the queue.
 */
export function drainMessages(): QueuedMessage[] {
  const snapshot = [...messageQueue];
  messageQueue.length = 0;
  return snapshot;
}

/** Resolve callbacks waiting for the next message */
let messageWaiters: Array<(msgs: QueuedMessage[]) => void> = [];

/** Notify any waiters that messages have arrived */
function notifyMessageWaiters(): void {
  if (messageWaiters.length > 0 && messageQueue.length > 0) {
    const snapshot = drainMessages();
    const waiters = messageWaiters.splice(0);
    for (const resolve of waiters) {
      resolve(snapshot);
    }
  }
}

/**
 * Wait for the next incoming message(s), up to timeoutMs.
 * Returns immediately if messages are already queued.
 * Returns empty array on timeout.
 */
export function waitForMessages(timeoutMs: number): Promise<QueuedMessage[]> {
  // Return immediately if messages are already queued
  if (messageQueue.length > 0) {
    return Promise.resolve(drainMessages());
  }

  return new Promise<QueuedMessage[]>((resolve) => {
    const timer = setTimeout(() => {
      // Remove this waiter on timeout
      messageWaiters = messageWaiters.filter((w) => w !== resolve);
      resolve([]);
    }, timeoutMs);

    messageWaiters.push((msgs) => {
      clearTimeout(timer);
      resolve(msgs);
    });
  });
}

// --- Graceful shutdown -------------------------------------------------------

function shutdown(signal: string): void {
  process.stderr.write(`[whazaa] Received ${signal}. Shutting down...\n`);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    try {
      sock.end(undefined);
    } catch {
      // Ignore
    }
    sock = null;
  }

  process.exit(0);
}

/**
 * Register SIGINT/SIGTERM handlers for graceful shutdown.
 * Call this only from the MCP server path — NOT from the watcher process.
 * (The watcher registers its own handlers and importing whatsapp.ts should
 * not add handlers as a module-level side effect.)
 */
export function registerShutdownHandlers(): void {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
