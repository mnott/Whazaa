/**
 * watch.ts — Smart terminal watcher for Claude Code integration
 *
 * Monitors incoming WhatsApp self-chat messages via a direct Baileys connection
 * (primary) and falls back to polling the MCP server's log file (secondary).
 *
 * Architecture:
 *   - Primary: Watcher connects to WhatsApp via Baileys using the same auth
 *     credentials as the MCP server (~/.whazaa/auth/). No extra QR scan needed.
 *   - Fallback: Polls /tmp/whazaa-incoming.log (written by the MCP server) to
 *     catch messages that may have arrived while the watcher's connection was
 *     re-establishing. New lines only — old messages are never replayed.
 *   - Deduplication: message IDs seen via the direct connection are tracked so
 *     the log-file fallback doesn't deliver them a second time.
 *
 * Smart session resolution (in order):
 *   1. Try the specified session ID, but only if Claude is actually running
 *      there (session is NOT at shell prompt)
 *   2. If the session is gone or back at a shell prompt → create a new tab,
 *      start claude, use that
 *   The watcher ALWAYS delivers to iTerm2 — even when the MCP server is
 *   running. The MCP server handles the WhatsApp connection; the watcher
 *   is the sole delivery mechanism to the Claude terminal.
 *
 * Usage:  npx whazaa watch <session-id>
 *
 * Environment variables:
 *   WHAZAA_LOG            Path to incoming message log (default: /tmp/whazaa-incoming.log)
 *   WHAZAA_POLL_INTERVAL  Seconds between log-file checks (default: 2)
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { homedir } from "node:os";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { resolveAuthDir } from "./auth.js";

// --- Configuration -----------------------------------------------------------

interface WatchConfig {
  sessionId: string;
  logFile: string;
  pollInterval: number;
}

function resolveConfig(sessionId: string): WatchConfig {
  return {
    sessionId,
    logFile: process.env.WHAZAA_LOG || "/tmp/whazaa-incoming.log",
    pollInterval:
      (parseInt(process.env.WHAZAA_POLL_INTERVAL || "2", 10) || 2) * 1_000,
  };
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
 * The session name typically reflects the running process or tab title.
 * Returns the session ID if found, null otherwise.
 */
function findClaudeSession(): string | null {
  // Get all sessions as "id\tname" lines
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

    // Match Claude Code in the tab title (covers "claude", "(claude)", "Claude Code")
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
 *
 * Uses iTerm2's `is at shell prompt` AppleScript property. When a foreground
 * process (like `claude`) is running, the session is NOT at the shell prompt,
 * so `is at shell prompt` returns false. When Claude has exited and the tab
 * is back at a bare shell, it returns true — meaning we must NOT type into it.
 *
 * Returns true if Claude appears to be running, false if the session is at a
 * shell prompt (stale) or the session ID cannot be found.
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
 *
 * The `claude` command is executed via the shell, so it resolves whatever the user
 * has configured — alias, function, or PATH binary. No hardcoded paths.
 *
 * Returns the session ID of the new tab, or null on failure.
 */
function createClaudeSession(): string | null {
  const home = homedir();

  // If iTerm2 isn't running, launch it first
  if (!isItermRunning()) {
    process.stderr.write("[whazaa-watch] iTerm2 not running, launching...\n");
    spawnSync("open", ["-a", "iTerm"], { timeout: 10_000 });
    // Wait for iTerm2 to be ready
    for (let i = 0; i < 10; i++) {
      spawnSync("sleep", ["1"]);
      if (isItermRunning()) break;
    }
  }

  // Create new tab (or new window if none exist) and get its session ID
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

  // Wait for Claude Code to start up (it takes a few seconds)
  process.stderr.write("[whazaa-watch] Waiting for Claude Code to start...\n");
  spawnSync("sleep", ["8"]);

  return sessionId;
}

// --- MCP server detection ----------------------------------------------------

const MCP_PID_FILE = "/tmp/whazaa-mcp.pid";

/**
 * Check if the MCP server is currently running by reading its PID file and
 * verifying the process is alive. When the MCP server is active, the watcher
 * must NOT connect to WhatsApp (same auth credentials → connection fight).
 */
function isMcpServerRunning(): boolean {
  if (!existsSync(MCP_PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(MCP_PID_FILE, "utf-8").trim(), 10);
    if (!pid) return false;
    // kill(pid, 0) tests whether the process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- WhatsApp watcher connection ---------------------------------------------

interface WatcherStatus {
  connected: boolean;
  phoneNumber: string | null;
  selfJid: string | null;
  selfLid: string | null;
}

/**
 * Connect to WhatsApp via Baileys and call onMessage whenever a self-chat
 * message arrives. Uses the same auth credentials as the MCP server.
 *
 * Returns a cleanup function that tears down the connection gracefully.
 */
async function connectWatcher(
  onMessage: (body: string, msgId: string) => void
): Promise<() => void> {
  // Silenced logger — watcher is not an MCP server (stdout is safe), but
  // we still don't want Baileys flooding our console output.
  const logger = pino({ level: "silent" });

  const authDir = resolveAuthDir();
  const status: WatcherStatus = {
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
      browser: ["Whazaa-Watch", "cli", "0.1.0"],
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        // The watcher should never need a QR — the MCP server handles initial
        // pairing. If a QR appears it means credentials are stale.
        process.stderr.write(
          "[whazaa-watch] QR code requested — credentials may be stale. " +
          "Run 'npx whazaa setup' to re-pair.\n"
        );
      }

      if (connection === "open") {
        status.connected = true;
        reconnectAttempts = 0;

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
          `[whazaa-watch] WhatsApp connected. Phone: +${status.phoneNumber ?? "unknown"}\n`
        );
      }

      if (connection === "close") {
        status.connected = false;

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
      // Only process messages after we know our own JID
      if (!status.selfJid && !status.selfLid && !status.phoneNumber) return;

      const stripDevice = (jid: string) => jid.replace(/:\d+@/, "@");
      const selfLid = status.selfLid ? stripDevice(status.selfLid) : null;

      for (const msg of messages) {
        const remoteJid = msg.key?.remoteJid;
        const body =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          null;

        if (!body || !remoteJid) continue;

        // Filter to self-chat only: match selfJid, selfLid, or phone number prefix
        const remoteJidNorm = stripDevice(remoteJid);
        const isSelfChat =
          (status.selfJid && remoteJidNorm === stripDevice(status.selfJid)) ||
          (selfLid && remoteJidNorm === selfLid) ||
          (status.phoneNumber && remoteJid.startsWith(status.phoneNumber));

        if (!isSelfChat) continue;

        const msgId = msg.key?.id ?? "";
        onMessage(body, msgId);
      }
    });
  }

  // Start the initial connection
  await openSocket().catch((err) => {
    process.stderr.write(`[whazaa-watch] Initial connect error: ${err}\n`);
    scheduleReconnect();
  });

  // Return cleanup function
  return function cleanup(): void {
    stopped = true;

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
  };
}

// ---------------------------------------------------------------------------
// Recent-body deduplication window
// ---------------------------------------------------------------------------
// When the direct WhatsApp connection delivers a message, trackBody() records
// it here. The log-file fallback poller checks this set before delivering so
// that a message arriving via both paths is only typed into iTerm2 once.
// Entries are evicted after 30 seconds.
// ---------------------------------------------------------------------------

const recentBodies = new Set<string>();

function trackBody(body: string): void {
  recentBodies.add(body);
  setTimeout(() => recentBodies.delete(body), 30_000);
}

// --- Command handlers --------------------------------------------------------

/**
 * Find an iTerm2 session that is running Claude in the given directory.
 *
 * Iterates all sessions, checks if their name contains "claude" (indicating
 * Claude Code is running), and compares the session's working directory (via
 * the `variable named "session.path"` AppleScript property) to the target.
 *
 * Returns the session ID if found, null otherwise.
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
 * Handle a /relocate <path> command received via WhatsApp.
 *
 * First checks if Claude is already running in the target directory.
 * If so, focuses that tab instead of opening a duplicate.
 * Otherwise, opens a new iTerm2 tab, cds to the given path, and starts `claude`.
 */
function handleRelocate(targetPath: string): void {
  process.stderr.write(`[whazaa-watch] /relocate -> ${targetPath}\n`);

  // Expand ~ manually so the AppleScript shell command resolves it correctly
  const expandedPath = targetPath.startsWith("~/")
    ? homedir() + targetPath.slice(1)
    : targetPath;

  // Check if Claude is already running in this directory
  const existingSession = findClaudeInDirectory(expandedPath);
  if (existingSession) {
    // Focus the existing session instead of opening a new tab
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
    } else {
      process.stderr.write(`[whazaa-watch] /relocate: session ${existingSession} vanished, opening new tab\n`);
    }
    if (focusResult === "focused") return;
  }

  // No existing session — open a new tab
  // Escape double-quotes and backslashes for embedding inside AppleScript string literals
  const escapedPath = expandedPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const script = `
tell application "iTerm2"
  if (count of windows) = 0 then
    set newWindow to (create window with default profile)
    tell current session of current tab of newWindow
      write text "cd \\"${escapedPath}\\" && claude"
    end tell
  else
    tell current window
      set newTab to (create tab with default profile)
      tell current session of newTab
        write text "cd \\"${escapedPath}\\" && claude"
      end tell
    end tell
  end if
end tell`;

  const result = runAppleScript(script);
  if (result === null) {
    process.stderr.write("[whazaa-watch] /relocate: failed to open new iTerm2 tab\n");
  } else {
    process.stderr.write(`[whazaa-watch] /relocate: opened new tab in ${targetPath}\n`);
  }
}

// --- Main loop ---------------------------------------------------------------

export async function watch(rawSessionId?: string): Promise<void> {
  // Strip the iTerm2 prefix (e.g. "w1t1p0:GUID" -> "GUID") or start with no cached session
  let activeSessionId = rawSessionId
    ? rawSessionId.includes(":") ? rawSessionId.split(":").pop()! : rawSessionId
    : "";

  const config = resolveConfig(activeSessionId);

  const mcpRunning = isMcpServerRunning();
  const mode = mcpRunning ? "Log-file only (MCP server active)" : "Direct WhatsApp + log-file fallback";

  console.log(`Whazaa Watch`);
  console.log(`  Session:  ${activeSessionId}`);
  console.log(`  Log file: ${config.logFile}`);
  console.log(`  Interval: ${config.pollInterval / 1_000}s`);
  console.log(`  Mode:     ${mode}`);
  console.log();

  let consecutiveFailures = 0;

  // Log-file: read current line count so we don't replay old messages.
  // We don't truncate — the MCP server writes to this file and owns it.
  let seen = 0;
  if (existsSync(config.logFile)) {
    try {
      const content = readFileSync(config.logFile, "utf-8");
      seen = content.split("\n").filter(Boolean).length;
      process.stderr.write(
        `[whazaa-watch] Log file has ${seen} existing lines — skipping them.\n`
      );
    } catch {
      // If we can't read it, start from 0 (may replay a few messages on startup)
    }
  }

  // Graceful shutdown
  let cleanupWatcher: (() => void) | null = null;
  const cleanup = (signal: string) => {
    console.log(`\n[whazaa-watch] ${signal} received. Stopping.`);
    if (cleanupWatcher) cleanupWatcher();
    process.exit(0);
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  /**
   * Top-level message handler.
   *
   * Intercepts special watcher commands (e.g. /relocate) before they reach
   * Claude. Everything else is forwarded to deliverMessage() as usual.
   */
  function handleMessage(text: string): void {
    if (text.startsWith("/relocate ")) {
      const targetPath = text.slice("/relocate ".length).trim();
      if (targetPath) {
        handleRelocate(targetPath);
        return;
      }
      process.stderr.write("[whazaa-watch] /relocate: no path provided\n");
      return;
    }

    deliverMessage(text);
  }

  /**
   * Smart delivery: type message into the active Claude session.
   *
   * The watcher ALWAYS delivers to iTerm2 — it is the sole delivery mechanism.
   * The MCP server handles the WhatsApp connection (sending/receiving), but the
   * watcher is what actually types messages into the Claude terminal.
   *
   *   1. If cached session exists AND Claude is running there → type into it
   *   2. Search all iTerm2 sessions for one running Claude → type into it
   *   3. Otherwise → create a new Claude session and type into that
   */
  function deliverMessage(text: string): boolean {
    // Attempt 1: try the cached session (if we have one), but only if Claude
    // is actually running there.
    if (activeSessionId && isClaudeRunningInSession(activeSessionId)) {
      if (typeIntoSession(activeSessionId, text)) {
        consecutiveFailures = 0;
        return true;
      }
    }

    process.stderr.write(
      `[whazaa-watch] ${activeSessionId ? `Session ${activeSessionId} is not running Claude.` : "No cached session."} Searching for another...\n`
    );

    // Attempt 2: search all iTerm2 sessions for one actually running Claude.
    // findClaudeSession() matches tab titles containing "claude", but we gate
    // each match with isClaudeRunningInSession() to skip stale tabs.
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

    // Attempt 3: create a fresh Claude session
    const created = createClaudeSession();
    if (created) {
      activeSessionId = created;
      if (typeIntoSession(activeSessionId, text)) {
        consecutiveFailures = 0;
        return true;
      }
    }

    // All attempts failed
    consecutiveFailures++;
    process.stderr.write(
      `[whazaa-watch] Failed to deliver message (attempt ${consecutiveFailures})\n`
    );
    return false;
  }

  // --- Mode selection: direct WhatsApp or log-file only ----------------------
  //
  // Only one Baileys instance can use the same auth credentials at a time.
  // When the MCP server is running (it owns the WhatsApp connection for
  // sending), the watcher must NOT connect — it reads the log file instead.
  // When the MCP server is NOT running, the watcher connects directly.
  //
  // The watcher re-checks every 30 seconds and switches mode as needed.

  let directMode = !mcpRunning;

  if (directMode) {
    console.log(`Connecting to WhatsApp...\n`);
    cleanupWatcher = await connectWatcher((body: string, _msgId: string) => {
      trackBody(body);
      console.log(`[whazaa-watch] (direct) -> ${body}`);
      handleMessage(body);
    });
  } else {
    console.log(`Waiting for messages (via MCP server log)...\n`);
  }

  // Periodically re-check whether the MCP server started/stopped
  setInterval(async () => {
    const mcpNow = isMcpServerRunning();

    if (directMode && mcpNow) {
      // MCP server just started — disconnect watcher to avoid conflict
      process.stderr.write(
        "[whazaa-watch] MCP server detected — switching to log-file mode.\n"
      );
      if (cleanupWatcher) {
        cleanupWatcher();
        cleanupWatcher = null;
      }
      directMode = false;
    } else if (!directMode && !mcpNow) {
      // MCP server stopped — watcher takes over WhatsApp directly
      process.stderr.write(
        "[whazaa-watch] MCP server gone — connecting to WhatsApp directly.\n"
      );
      directMode = true;
      cleanupWatcher = await connectWatcher((body: string, _msgId: string) => {
        trackBody(body);
        console.log(`[whazaa-watch] (direct) -> ${body}`);
        handleMessage(body);
      });
    }
  }, 30_000);

  // --- Log-file polling (always active) --------------------------------------
  // In direct mode: fallback for messages written by MCP server.
  // In log-file mode: primary message source.

  setInterval(() => {
    if (!existsSync(config.logFile)) return;

    let content: string;
    try {
      content = readFileSync(config.logFile, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n").filter(Boolean);
    if (lines.length <= seen) return;

    const newLines = lines.slice(seen);
    for (const line of newLines) {
      // Strip timestamp prefix: "[2026-02-21T18:43:04.000Z] message"
      const msg = line.replace(/^\[[^\]]*\]\s*/, "");
      if (!msg) continue;

      // Deduplicate: if the direct WhatsApp connection already delivered this
      // message body (within the last 30 seconds), skip it here.
      if (recentBodies.has(msg)) {
        process.stderr.write(
          `[whazaa-watch] (log) skipping duplicate: ${msg.slice(0, 60)}\n`
        );
        continue;
      }

      const source = directMode ? "fallback" : "log";
      console.log(`[whazaa-watch] (${source}) -> ${msg}`);
      handleMessage(msg);
    }

    seen = lines.length;
  }, config.pollInterval);

  // Keep process alive
  await new Promise(() => {});
}
