/**
 * watch.ts — Smart terminal watcher for Claude Code integration
 *
 * Monitors the Whazaa incoming message log and types new messages
 * into an iTerm2 session running Claude Code.
 *
 * Smart session resolution (in order):
 *   1. Try the specified session ID (from /whatsapp on)
 *   2. If gone, find any iTerm2 session running claude
 *   3. If none, open a new iTerm2 tab, start claude, use that
 *
 * Usage:  npx whazaa watch <session-id>
 *
 * Environment variables:
 *   WHAZAA_LOG            Path to incoming message log (default: /tmp/whazaa-incoming.log)
 *   WHAZAA_POLL_INTERVAL  Seconds between checks (default: 2)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

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
        set output to output & sessionId & tab & sessionName & linefeed
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

  // Create new tab and get its session ID
  const createScript = `
tell application "iTerm2"
  tell current window
    set newTab to (create tab with default profile)
    tell current session of newTab
      write text "cd ${home}"
      delay 0.5
      write text "claude"
      return id
    end tell
  end tell
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

// --- Main loop ---------------------------------------------------------------

export async function watch(rawSessionId: string): Promise<void> {
  // Strip the iTerm2 prefix (e.g. "w1t1p0:GUID" → "GUID")
  let activeSessionId = rawSessionId.includes(":")
    ? rawSessionId.split(":").pop()!
    : rawSessionId;

  const config = resolveConfig(activeSessionId);

  // Ensure log file exists and is empty
  writeFileSync(config.logFile, "");

  console.log(`Whazaa Watch`);
  console.log(`  Session:  ${activeSessionId}`);
  console.log(`  Log file: ${config.logFile}`);
  console.log(`  Interval: ${config.pollInterval / 1_000}s`);
  console.log(`  Mode:     Smart (auto-find/create claude sessions)`);
  console.log(`\nWaiting for messages...\n`);

  let seen = 0;
  let consecutiveFailures = 0;

  // Graceful shutdown
  const cleanup = (signal: string) => {
    console.log(`\n[whazaa-watch] ${signal} received. Stopping.`);
    process.exit(0);
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  /**
   * Smart delivery: try to type into a session, with fallback chain.
   *   1. Try active session
   *   2. Find any claude session
   *   3. Create new claude session
   */
  function deliverMessage(text: string): boolean {
    // Attempt 1: try current active session
    if (typeIntoSession(activeSessionId, text)) {
      consecutiveFailures = 0;
      return true;
    }

    process.stderr.write(
      `[whazaa-watch] Session ${activeSessionId} not found. Searching for claude...\n`
    );

    // Attempt 2: find any existing claude session
    const found = findClaudeSession();
    if (found) {
      activeSessionId = found;
      process.stderr.write(
        `[whazaa-watch] Retargeted to session: ${activeSessionId}\n`
      );
      if (typeIntoSession(activeSessionId, text)) {
        consecutiveFailures = 0;
        return true;
      }
    }

    // Attempt 2b: retry after a short delay (AppleScript may need time after launchd start)
    process.stderr.write(
      "[whazaa-watch] Retrying session search after delay...\n"
    );
    spawnSync("sleep", ["2"]);
    const retryFound = findClaudeSession();
    if (retryFound) {
      activeSessionId = retryFound;
      process.stderr.write(
        `[whazaa-watch] Retargeted to session: ${activeSessionId}\n`
      );
      if (typeIntoSession(activeSessionId, text)) {
        consecutiveFailures = 0;
        return true;
      }
    }

    // Attempt 3: create a new claude session
    process.stderr.write(
      "[whazaa-watch] No claude session found. Starting new one...\n"
    );
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

  // Poll loop
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

      console.log(`[whazaa-watch] → ${msg}`);
      deliverMessage(msg);
    }

    seen = lines.length;
  }, config.pollInterval);

  // Keep process alive
  await new Promise(() => {});
}
