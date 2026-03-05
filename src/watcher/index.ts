/**
 * watcher/index.ts — Watcher entry point; wires all modules together
 *
 * This is the top-level composition root for the `whazaa watch` command.  It
 * is the only module that `src/index.ts` imports from the watcher sub-package,
 * keeping the public API surface to a single function: `watch()`.
 *
 * Wiring overview
 * ---------------
 *
 * ```
 *  watch()
 *   │
 *   ├─ createMessageHandler()   [commands.ts]
 *   │   └─ Returns handleMessage(text, timestamp)
 *   │       ├─ Slash commands  → iTerm2 AppleScript actions
 *   │       └─ Plain text      → deliverMessage() → iTerm2 typing
 *   │
 *   ├─ connectWatcher(onMessage) [baileys.ts]
 *   │   ├─ Opens Baileys WebSocket to WhatsApp
 *   │   ├─ onMessage callback → handleMessage()
 *   │   └─ Returns { cleanup, triggerLogin }
 *   │
 *   └─ startIpcServer(triggerLogin) [ipc-server.ts]
 *       ├─ Listens on Unix Domain Socket
 *       └─ Dispatches IPC requests from MCP server instances
 * ```
 *
 * Lifecycle
 * ---------
 * 1. Parse the optional `rawSessionId` (format `w0t2p0:UUID` or bare UUID)
 *    and initialise `activeItermSessionId` in the shared state module.
 * 2. Print the startup banner.
 * 3. Register SIGINT/SIGTERM handlers for graceful shutdown (closes the
 *    Baileys socket, closes the IPC server, removes the socket file).
 * 4. Call `createMessageHandler` to build the message routing closure.
 * 5. Call `connectWatcher` to establish the WhatsApp connection; forward
 *    each arriving self-chat message to `handleMessage`.
 * 6. Call `startIpcServer` to accept requests from MCP client instances.
 * 7. Suspend the event loop indefinitely with `await new Promise(() => {})`.
 *
 * Dependencies: state, baileys, ipc-server, commands, ipc-client
 */

import { unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { IPC_SOCKET_PATH } from "../ipc-client.js";

import {
  activeItermSessionId,
  setActiveItermSessionId,
  setCommandHandler,
  sessionRegistry,
} from "./state.js";
import { connectWatcher } from "./baileys.js";
import { startIpcServer, discoverSessions } from "./ipc-server.js";
import { createMessageHandler } from "./commands.js";
import { setAppDir, loadSessionRegistry } from "./persistence.js";
import { log, setLogPrefix } from "./log.js";
import { handleScreenshot } from "./screenshot.js";
import { router, APIBackend, SessionBackend, HybridSessionManager, setHybridManager, snapshotAllSessions, startWsGateway, stopWsGateway, setScreenshotHandler, WatcherClient, DAEMON_SOCKET_PATH, createBrokerMessage } from "aibroker";

// ── Hub mode detection ───────────────────────────────────────────────────────

/**
 * Probe the AIBroker hub daemon to determine whether it is running.
 *
 * Connects to `/tmp/aibroker.sock` and calls `status`. If the call succeeds
 * within 2 seconds, the hub is considered alive and Whazaa enters hub mode.
 * On any failure (socket missing, refused, timeout), returns false and
 * Whazaa falls back to embedded mode (current behavior unchanged).
 */
async function detectHubMode(): Promise<boolean> {
  const client = new WatcherClient(DAEMON_SOCKET_PATH);
  try {
    const result = await Promise.race([
      client.call_raw("status", {}),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ]);
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Slash commands that must be handled locally even in hub mode.
 *
 * These commands require direct iTerm2/Baileys access that only the Whazaa
 * process has. They should never be forwarded to the hub.
 */
const LOCAL_SLASH_COMMANDS = new Set([
  "/h", "/help",
  "/cc", "/esc", "/enter", "/tab",
  "/up", "/down", "/left", "/right",
  "/restart", "/login",
]);

/** Check if a message matches a local-only slash command. */
function isLocalSlashCommand(text: string): boolean {
  const trimmed = text.trim();
  // Exact matches
  if (LOCAL_SLASH_COMMANDS.has(trimmed)) return true;
  // /pick N pattern
  if (/^\/pick\s+\d+/.test(trimmed)) return true;
  return false;
}

// --- Main loop ---------------------------------------------------------------

/**
 * Start the Whazaa watcher — the long-running process that bridges WhatsApp
 * and iTerm2 Claude Code sessions.
 *
 * Supports two modes:
 * - **Hub mode**: AIBroker daemon is running. Whazaa acts as a thin transport
 *   adapter — incoming WA messages are forwarded to the hub for routing.
 *   PAILot gateway is NOT started (hub owns it). Outgoing messages arrive
 *   via the `deliver` IPC handler (Phase 2).
 * - **Embedded mode**: No daemon. Whazaa runs everything locally (current
 *   behavior, fully backward compatible).
 *
 * Suspends the event loop indefinitely via `await new Promise(() => {})`;
 * exits only on SIGINT or SIGTERM.
 *
 * @param rawSessionId - Optional iTerm2 session identifier (`$TERM_SESSION_ID`
 *   or `$ITERM_SESSION_ID`). Accepted formats: bare UUID or `w0t2p0:UUID`.
 *   When omitted, session auto-discovery runs on the first incoming message.
 */
export async function watch(rawSessionId?: string): Promise<void> {
  setLogPrefix("whazaa-watch");
  setAppDir(join(homedir(), ".whazaa"));

  let activeSessionId = rawSessionId
    ? rawSessionId.includes(":") ? rawSessionId.split(":").pop()! : rawSessionId
    : "";
  // Keep module-level activeItermSessionId in sync with the local activeSessionId
  setActiveItermSessionId(activeSessionId);

  // Always-hybrid startup: APIBackend for headless + SessionBackend for visual sessions
  const apiBackend = new APIBackend({
    type: "api",
    provider: "anthropic",
    model: process.env.AIBROKER_MODEL ?? "sonnet",
    cwd: process.env.AIBROKER_CWD,
    maxTurns: Number(process.env.AIBROKER_MAX_TURNS) || 30,
    maxBudgetUsd: Number(process.env.AIBROKER_MAX_BUDGET) || 1.0,
    permissionMode: process.env.AIBROKER_PERMISSION_MODE ?? "acceptEdits",
    skipDefaultSession: true,
  });
  const manager = new HybridSessionManager(apiBackend);
  setHybridManager(manager);
  manager.createApiSession("Default", process.env.AIBROKER_CWD ?? homedir());
  // Set APIBackend as default for backward-compat (deliverViaApi reads it)
  router.setDefaultBackend(apiBackend);

  // ── Detect hub mode ──
  let hubMode = await detectHubMode();
  const hubClient = hubMode ? new WatcherClient(DAEMON_SOCKET_PATH) : null;
  let hubFailures = 0;
  const HUB_FAILURE_THRESHOLD = 3; // Fall back to embedded after N consecutive failures

  console.log(`Whazaa Watch`);
  console.log(`  Session:  ${activeSessionId || "(auto-discover)"}`);
  console.log(`  Backend:  hybrid (api=${apiBackend.model})`);
  console.log(`  Socket:   ${IPC_SOCKET_PATH}`);
  console.log(`  Mode:     ${hubMode ? "hub (daemon detected)" : "embedded (standalone)"}`);
  console.log();

  let consecutiveFailures = 0;

  // Graceful shutdown
  let cleanupWatcher: (() => void) | null = null;
  let ipcServer: Server | null = null;

  const shutdown = (signal: string) => {
    console.log(`\n[whazaa-watch] ${signal} received. Stopping.`);
    if (cleanupWatcher) cleanupWatcher();
    if (!hubMode) stopWsGateway();
    if (ipcServer) {
      ipcServer.close();
      try { unlinkSync(IPC_SOCKET_PATH); } catch { /* ignore */ }
    }
    // Unregister from hub on shutdown
    if (hubClient) {
      hubClient.call_raw("unregister_adapter", { name: "whazaa" }).catch(() => {});
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Create the message handler with closures over local state
  const handleMessage = createMessageHandler(
    () => activeSessionId,
    (id: string) => { activeSessionId = id; },
    () => consecutiveFailures,
    (n: number) => { consecutiveFailures = n; },
  );

  // Store the handler so the IPC server can execute commands directly
  // (e.g. whatsapp_command MCP tool calling /c without round-tripping through WhatsApp)
  setCommandHandler(handleMessage);

  // Connect to WhatsApp directly (watcher is always the sole connection owner)
  console.log(`Connecting to WhatsApp...\n`);
  const { cleanup, triggerLogin } = await connectWatcher(
    (body: string, _msgId: string, timestamp: number) => {
      console.log(`[whazaa-watch] (direct) -> ${body}`);

      if (hubMode && hubClient) {
        // Hub mode: forward non-local messages to the hub for routing.
        // Local slash commands (keyboard, /restart, /help) stay in Whazaa.
        if (isLocalSlashCommand(body)) {
          handleMessage(body, timestamp);
          return;
        }

        // Create a BrokerMessage and route through the hub
        const message = createBrokerMessage(
          "whazaa",
          body.trim().startsWith("/") ? "command" : "text",
          { text: body },
        );
        message.timestamp = timestamp;

        hubClient.call_raw("route_message", {
          message: message as unknown as Record<string, unknown>,
        }).then(() => {
          hubFailures = 0; // Reset on success
        }).catch((err) => {
          hubFailures++;
          log(`Hub route_message failed (${hubFailures}/${HUB_FAILURE_THRESHOLD}), falling back to local: ${err instanceof Error ? err.message : String(err)}`);
          handleMessage(body, timestamp);
          // Permanently degrade to embedded mode after threshold
          if (hubFailures >= HUB_FAILURE_THRESHOLD) {
            log("Hub unreachable — switching to embedded mode permanently for this session");
            hubMode = false;
          }
        });
      } else {
        // Embedded mode: handle everything locally (unchanged)
        handleMessage(body, timestamp);
      }
    }
  );
  cleanupWatcher = cleanup;

  // Restore persisted sessions and auto-discover active iTerm2 sessions
  loadSessionRegistry();
  const disc = discoverSessions();
  if (disc.alive.length > 0 || disc.discovered.length > 0) {
    log(`Startup: ${disc.alive.length} restored, ${disc.discovered.length} discovered, ${disc.pruned.length} pruned`);
  }

  // Register discovered iTerm2 sessions as visual sessions in the hybrid manager.
  // Use live iTerm2 tab titles (what the user actually sees) instead of paiName.
  const liveSnapshots = snapshotAllSessions();
  const snapById = new Map(liveSnapshots.map(s => [s.id, s]));
  for (const [, entry] of sessionRegistry) {
    if (entry.itermSessionId) {
      const snap = snapById.get(entry.itermSessionId);
      // Prefer tab.title (user-visible tab label), fall back to profile name, paiName, then registry name
      const displayName = snap?.tabTitle ?? snap?.profileName ?? snap?.paiName ?? entry.name;
      manager.registerVisualSession(displayName, "", entry.itermSessionId);
    }
  }

  // Start the IPC server
  ipcServer = startIpcServer(triggerLogin);

  if (hubMode && hubClient) {
    // Hub mode: do NOT start PAILot WsGateway — the hub owns it.
    // Register with the hub so it can route messages to us.
    log("Hub mode: skipping WsGateway (hub owns PAILot gateway)");
    hubClient.call_raw("register_adapter", {
      name: "whazaa",
      socketPath: IPC_SOCKET_PATH,
    }).then(() => {
      log("Registered with AIBroker hub daemon");
    }).catch((err) => {
      log(`Hub registration failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else {
    // Embedded mode: start WsGateway locally (current behavior)
    setScreenshotHandler(handleScreenshot);
    startWsGateway(handleMessage);
    log("Embedded mode: started local WsGateway");
  }

  // Keep process alive
  await new Promise(() => {});
}
