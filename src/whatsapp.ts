/**
 * whatsapp.ts — WhatsApp connection manager (setup mode only)
 *
 * This module is used exclusively by the setup wizard (`npx whazaa setup`)
 * to verify existing credentials and perform first-time QR pairing.
 *
 * In normal operation, the watcher daemon (watch.ts) is the sole owner of
 * the Baileys connection. The MCP server (index.ts) communicates with the
 * watcher via IPC (ipc-client.ts) and does NOT call this module.
 *
 * Manages the Baileys WebSocket connection with:
 *   - Automatic self-JID detection (no hardcoded phone number)
 *   - QR pairing flow on first run, silent reconnect thereafter
 *   - Exponential backoff reconnection (1s -> 60s max)
 *   - Deduplication of sent messages to prevent self-echo
 *   - Markdown -> WhatsApp format conversion
 *   - All Baileys output silenced to avoid MCP stdio pollution
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { resolveAuthDir, printQR } from "./auth.js";

// --- Types -------------------------------------------------------------------

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

/** Current connection state */
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
let connectionReplacedCount = 0;
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
 * Schedule a reconnection attempt with exponential backoff.
 * Does nothing if permanently logged out or a timer is already pending.
 */
function scheduleReconnect(): void {
  if (permanentlyLoggedOut) return;
  if (reconnectTimer) return;

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
    browser: ["Whazaa", "cli", "0.1.0"],
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      status.awaitingQR = true;
      printQR(qr);

      if (initResolve) {
        initResolve();
        initResolve = null;
      }

      if (qrResolve) {
        qrResolve();
        qrResolve = null;
      }
    }

    if (connection === "open") {
      status.awaitingQR = false;
      status.connected = true;
      reconnectAttempts = 0;
      connectionReplacedCount = 0;

      const jid = sock?.user?.id ?? null;
      if (jid) {
        const number = jid.split(":")[0].split("@")[0];
        status.phoneNumber = number;
        status.selfJid = `${number}@s.whatsapp.net`;
      }
      const lid = (sock?.user as unknown as Record<string, unknown>)?.lid as string | undefined;
      if (lid) {
        status.selfLid = lid;
      }

      process.stderr.write(
        `[whazaa] Connected. Phone: +${status.phoneNumber ?? "unknown"}\n`
      );

      if (initResolve) {
        initResolve();
        initResolve = null;
      }

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

      if (statusCode === DisconnectReason.connectionReplaced) {
        connectionReplacedCount++;
        if (connectionReplacedCount >= 3) {
          process.stderr.write(
            "[whazaa] Connection replaced (440) 3 times — another instance holds the session. Stopping.\n"
          );
          return;
        }
        process.stderr.write(
          `[whazaa] Connection replaced (440) by another instance (${connectionReplacedCount}/3). Retrying with longer backoff...\n`
        );
        reconnectAttempts = Math.max(reconnectAttempts, 4);
        scheduleReconnect();
        return;
      }

      process.stderr.write("[whazaa] Connection closed. Will reconnect...\n");
      scheduleReconnect();
    }
  });

  // Note: no messages.upsert handler here — message routing is handled by
  // the watcher daemon (watch.ts) which is the sole WhatsApp connection owner
  // in normal operation. This module is used only by the setup wizard.
}

// --- Public API --------------------------------------------------------------

/**
 * Initialize the WhatsApp connection.
 * Resolves once the connection is open OR a QR code has been emitted.
 * Used by the setup wizard only.
 */
export async function initialize(): Promise<void> {
  await new Promise<void>((resolve) => {
    initResolve = resolve;
    connect().catch((err) => {
      process.stderr.write(`[whazaa] Init error: ${err}\n`);
      resolve();
    });
  });
}

/**
 * Wait until the WhatsApp connection is fully open.
 * Used by setup mode to block until the user has scanned the QR code.
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
 * Used by setup mode to detect that existing credentials are stale.
 */
export function waitForQR(): Promise<void> {
  return new Promise<void>((resolve) => {
    qrResolve = resolve;
  });
}

/**
 * Trigger a new QR pairing flow.
 * Closes the current socket (if any) and reconnects with fresh state.
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

  await connect();
}

/**
 * Return the current connection status snapshot.
 */
export function getStatus(): WhatsAppStatus {
  return { ...status };
}
