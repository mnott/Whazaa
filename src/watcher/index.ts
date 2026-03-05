/**
 * watcher/index.ts — Whazaa watcher entry point.
 *
 * Thin transport adapter: connects to WhatsApp via Baileys, forwards all
 * messages to the AIBroker hub daemon for processing, and delivers hub
 * responses back via WhatsApp.
 *
 * Requires the AIBroker daemon to be running. Does not function standalone.
 */

import { unlinkSync } from "node:fs";
import type { Server } from "node:net";

import { IPC_SOCKET_PATH } from "../ipc-client.js";

import {
  setActiveItermSessionId,
  setCommandHandler,
} from "./state.js";
import { connectWatcher } from "./baileys.js";
import { startIpcServer } from "./ipc-server.js";
import { createMessageHandler } from "./commands.js";
import { setAppDir, loadSessionRegistry } from "./persistence.js";
import { log, setLogPrefix } from "./log.js";
import { WatcherClient, DAEMON_SOCKET_PATH, createBrokerMessage } from "aibroker";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Hub connection ──────────────────────────────────────────────────────────

/**
 * Connect to the AIBroker hub daemon. Retries up to 3 times with 2s timeout.
 * Throws if the hub is not reachable — adapter cannot function without it.
 */
async function connectToHub(): Promise<WatcherClient> {
  const client = new WatcherClient(DAEMON_SOCKET_PATH);
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await Promise.race([
        client.call_raw("status", {}),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 2000),
        ),
      ]);
      if (result !== null) return client;
    } catch {
      if (attempt < MAX_RETRIES) {
        log(`Hub not reachable (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY}ms...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }

  throw new Error(
    `AIBroker daemon not reachable at ${DAEMON_SOCKET_PATH}. ` +
    `Start it with: aibroker start`
  );
}

/**
 * Slash commands handled locally (require direct Baileys access).
 * Everything else goes to the hub.
 */
const LOCAL_SLASH_COMMANDS = new Set(["/restart", "/login"]);

function isLocalSlashCommand(text: string): boolean {
  return LOCAL_SLASH_COMMANDS.has(text.trim());
}

// ── Main loop ───────────────────────────────────────────────────────────────

/**
 * Start the Whazaa watcher — thin WhatsApp transport adapter.
 *
 * All command handling, session management, TTS, and screenshots are owned
 * by the AIBroker hub daemon. This process only:
 * 1. Connects to WhatsApp via Baileys
 * 2. Forwards incoming messages to the hub
 * 3. Delivers hub-originated messages via WhatsApp (through IPC "deliver")
 * 4. Handles /restart and /login locally
 */
export async function watch(rawSessionId?: string): Promise<void> {
  setLogPrefix("whazaa-watch");
  setAppDir(join(homedir(), ".whazaa"));

  let activeSessionId = rawSessionId
    ? rawSessionId.includes(":") ? rawSessionId.split(":").pop()! : rawSessionId
    : "";
  setActiveItermSessionId(activeSessionId);

  // Connect to AIBroker hub (required — no standalone mode)
  let hubClient: WatcherClient;
  try {
    hubClient = await connectToHub();
  } catch (err) {
    console.error(`[whazaa-watch] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[whazaa-watch] The AIBroker daemon must be running. Exiting.");
    process.exit(1);
  }

  console.log(`Whazaa Watch`);
  console.log(`  Session:  ${activeSessionId || "(auto-discover)"}`);
  console.log(`  Socket:   ${IPC_SOCKET_PATH}`);
  console.log(`  Hub:      ${DAEMON_SOCKET_PATH}`);
  console.log();

  let consecutiveFailures = 0;

  // Graceful shutdown
  let cleanupWatcher: (() => void) | null = null;
  let ipcServer: Server | null = null;

  const shutdown = (signal: string) => {
    console.log(`\n[whazaa-watch] ${signal} received. Stopping.`);
    clearInterval(heartbeatTimer);
    if (cleanupWatcher) cleanupWatcher();
    if (ipcServer) {
      ipcServer.close();
      try { unlinkSync(IPC_SOCKET_PATH); } catch { /* ignore */ }
    }
    hubClient.call_raw("unregister_adapter", { name: "whazaa" }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Local handler for /restart and /login only
  const handleMessage = createMessageHandler(
    () => activeSessionId,
    (id: string) => { activeSessionId = id; },
    () => consecutiveFailures,
    (n: number) => { consecutiveFailures = n; },
  );
  setCommandHandler(handleMessage);

  // Connect to WhatsApp
  console.log(`Connecting to WhatsApp...\n`);
  const { cleanup, triggerLogin } = await connectWatcher(
    (body: string, _msgId: string, timestamp: number) => {
      log(`[whazaa-watch] -> ${body.slice(0, 80)}`);

      // Local commands stay in the adapter
      if (isLocalSlashCommand(body)) {
        handleMessage(body, timestamp);
        return;
      }

      // Everything else → hub
      const message = createBrokerMessage(
        "whazaa",
        body.trim().startsWith("/") ? "command" : "text",
        { text: body },
      );
      message.timestamp = timestamp;

      hubClient.call_raw("route_message", {
        message: message as unknown as Record<string, unknown>,
      }).catch((err) => {
        log(`Hub route_message failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  );
  cleanupWatcher = cleanup;

  // Restore persisted sessions
  loadSessionRegistry();

  // Start IPC server for MCP clients
  ipcServer = startIpcServer(triggerLogin, hubClient);

  // Register with hub
  hubClient.call_raw("register_adapter", {
    name: "whazaa",
    socketPath: IPC_SOCKET_PATH,
  }).then(() => {
    log("Registered with AIBroker hub daemon");
  }).catch((err) => {
    log(`Hub registration failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Hub heartbeat — re-register if the daemon restarts
  const HUB_HEARTBEAT_INTERVAL = 30_000; // 30 seconds
  const heartbeatTimer = setInterval(async () => {
    try {
      const result = await Promise.race([
        hubClient.call_raw("status", {}),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);
      if (result === null) throw new Error("null response");
    } catch {
      // Hub unreachable — try to re-register
      log("Hub heartbeat failed — attempting re-registration...");
      try {
        hubClient.call_raw("register_adapter", {
          name: "whazaa",
          socketPath: IPC_SOCKET_PATH,
        }).then(() => {
          log("Re-registered with AIBroker hub daemon");
        }).catch((err) => {
          log(`Hub re-registration failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      } catch {
        log("Hub still unreachable");
      }
    }
  }, HUB_HEARTBEAT_INTERVAL);

  // Keep process alive
  await new Promise(() => {});
}
