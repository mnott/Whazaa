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

import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Socket, Server } from "node:net";
import { randomUUID } from "node:crypto";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { resolveAuthDir, printQR } from "./auth.js";
import { IPC_SOCKET_PATH } from "./ipc-client.js";

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

// ---------------------------------------------------------------------------
// Session routing state
// ---------------------------------------------------------------------------

/** The session ID of the most-recently-active MCP client */
let activeClientId: string | null = null;

/** Per-client incoming message queues, keyed by sessionId */
const clientQueues = new Map<string, QueuedMessage[]>();

/** Per-client long-poll waiters: resolve when the next message arrives */
const clientWaiters = new Map<
  string,
  Array<(msgs: QueuedMessage[]) => void>
>();

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
 */
async function watcherSendMessage(message: string): Promise<string> {
  if (!watcherSock) {
    throw new Error("WhatsApp socket not initialized. Is the watcher connected?");
  }
  if (!watcherStatus.connected) {
    throw new Error("WhatsApp is not connected. Check status with whatsapp_status.");
  }
  if (!watcherStatus.selfJid) {
    throw new Error("Self JID not yet known. Wait for connection to fully open.");
  }

  const text = markdownToWhatsApp(message);
  const result = await watcherSock.sendMessage(watcherStatus.selfJid, { text });

  if (result?.key?.id) {
    const id = result.key.id;
    sentMessageIds.add(id);
    setTimeout(() => sentMessageIds.delete(id), 30_000);
  }

  const preview = message.length > 80 ? `${message.slice(0, 80)}...` : message;
  return preview;
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
      activeClientId = sessionId;
      if (!clientQueues.has(sessionId)) {
        clientQueues.set(sessionId, []);
      }
      process.stderr.write(`[whazaa-watch] IPC: registered client ${sessionId}\n`);
      sendResponse(socket, { id, ok: true, result: { registered: true } });
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

      // Mark this session as the active client
      activeClientId = sessionId;
      if (!clientQueues.has(sessionId)) {
        clientQueues.set(sessionId, []);
      }

      try {
        const preview = await watcherSendMessage(message);
        sendResponse(socket, { id, ok: true, result: { preview } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse(socket, { id, ok: false, error: msg });
      }
      socket.end();
      break;
    }

    case "receive": {
      const queue = clientQueues.get(sessionId) ?? [];
      const messages = queue.splice(0);
      sendResponse(socket, { id, ok: true, result: { messages } });
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
    // Get the window ID of the frontmost iTerm2 window
    let windowId: string;
    try {
      windowId = execSync(
        'osascript -e \'tell application "iTerm2" to id of window 1\'',
        { timeout: 10_000 }
      ).toString().trim();
    } catch {
      await watcherSendMessage("Error: iTerm2 is not running or has no open windows.").catch(() => {});
      return;
    }

    if (!windowId) {
      await watcherSendMessage("Error: Could not get iTerm2 window ID.").catch(() => {});
      return;
    }

    // Capture the window: -x (no shutter sound), -o (no shadow), -l (window by ID)
    execSync(`screencapture -x -o -l ${windowId} "${filePath}"`, { timeout: 15_000 });

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
    });

    // Expose socket and status to module scope for IPC handlers
    watcherSock = sock;

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
        const body =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          null;

        if (!body || !remoteJid) continue;

        const remoteJidNorm = stripDevice(remoteJid);
        const isSelfChat =
          (connStatus.selfJid && remoteJidNorm === stripDevice(connStatus.selfJid)) ||
          (selfLid && remoteJidNorm === selfLid) ||
          (connStatus.phoneNumber && remoteJid.startsWith(connStatus.phoneNumber));

        if (!isSelfChat) continue;

        const msgId = msg.key?.id ?? randomUUID();

        // Skip self-echo (messages sent by this watcher process)
        if (msgId && sentMessageIds.has(msgId)) {
          sentMessageIds.delete(msgId);
          continue;
        }

        const timestamp = Number(msg.messageTimestamp) * 1_000;
        onMessage(body, msgId, timestamp);
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
          process.stderr.write(`[whazaa-watch] Active session switched to ${newSessionId}\n`);
        }
        return;
      }
      process.stderr.write("[whazaa-watch] /relocate: no path provided\n");
      return;
    }

    // --- /sessions (aliases: /s) — list sessions ------------------------------
    if (trimmedText === "/sessions" || trimmedText === "/s") {
      const sessions = listClaudeSessions();
      if (sessions.length === 0) {
        watcherSendMessage("No Claude sessions found.").catch(() => {});
        return;
      }
      const lines = sessions.map((s, i) => {
        const label = s.path ? s.path.replace(homedir(), "~") : s.name;
        return `*${i + 1}.* ${label}`;
      });
      const reply = `*Open Claude sessions:*\n${lines.join("\n")}\n\nSwitch with */1*, */2*, etc.`;
      watcherSendMessage(reply).catch(() => {});
      return;
    }

    // --- /N — switch to session N (e.g. /1, /2, /3) -------------------------
    const sessionSwitchMatch = trimmedText.match(/^\/(\d+)$/);
    if (sessionSwitchMatch) {
      const num = parseInt(sessionSwitchMatch[1], 10);
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
        const label = chosen.path ? chosen.path.replace(homedir(), "~") : chosen.name;
        process.stderr.write(`[whazaa-watch] /sessions: switched to session ${chosen.id} (${label})\n`);
        watcherSendMessage(`Switched to *${label}*`).catch(() => {});
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
