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

import { IPC_SOCKET_PATH } from "../ipc-client.js";

import {
  activeItermSessionId,
  setActiveItermSessionId,
} from "./state.js";
import { connectWatcher } from "./baileys.js";
import { startIpcServer, discoverSessions } from "./ipc-server.js";
import { createMessageHandler } from "./commands.js";
import { loadSessionRegistry } from "./persistence.js";
import { log } from "./log.js";

// --- Main loop ---------------------------------------------------------------

/**
 * Start the Whazaa watcher — the long-running process that bridges WhatsApp
 * and iTerm2 Claude Code sessions.
 *
 * Suspends the event loop indefinitely via `await new Promise(() => {})`;
 * exits only on SIGINT or SIGTERM.
 *
 * @param rawSessionId - Optional iTerm2 session identifier (`$TERM_SESSION_ID`
 *   or `$ITERM_SESSION_ID`). Accepted formats: bare UUID or `w0t2p0:UUID`.
 *   When omitted, session auto-discovery runs on the first incoming message.
 */
export async function watch(rawSessionId?: string): Promise<void> {
  let activeSessionId = rawSessionId
    ? rawSessionId.includes(":") ? rawSessionId.split(":").pop()! : rawSessionId
    : "";
  // Keep module-level activeItermSessionId in sync with the local activeSessionId
  setActiveItermSessionId(activeSessionId);

  console.log(`Whazaa Watch`);
  console.log(`  Session:  ${activeSessionId || "(auto-discover)"}`);
  console.log(`  Socket:   ${IPC_SOCKET_PATH}`);
  console.log();

  let consecutiveFailures = 0;

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

  // Create the message handler with closures over local state
  const handleMessage = createMessageHandler(
    () => activeSessionId,
    (id: string) => { activeSessionId = id; },
    () => consecutiveFailures,
    (n: number) => { consecutiveFailures = n; },
  );

  // Connect to WhatsApp directly (watcher is always the sole connection owner)
  console.log(`Connecting to WhatsApp...\n`);
  const { cleanup, triggerLogin } = await connectWatcher(
    (body: string, _msgId: string, timestamp: number) => {
      console.log(`[whazaa-watch] (direct) -> ${body}`);
      handleMessage(body, timestamp);
    }
  );
  cleanupWatcher = cleanup;

  // Restore persisted sessions and auto-discover active iTerm2 sessions
  loadSessionRegistry();
  const disc = discoverSessions();
  if (disc.alive.length > 0 || disc.discovered.length > 0) {
    log(`Startup: ${disc.alive.length} restored, ${disc.discovered.length} discovered, ${disc.pruned.length} pruned`);
  }

  // Start the IPC server
  ipcServer = startIpcServer(triggerLogin);

  // Keep process alive
  await new Promise(() => {});
}
