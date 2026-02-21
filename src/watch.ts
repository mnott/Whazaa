/**
 * watch.ts — Terminal watcher for Claude Code integration
 *
 * Monitors the Whazaa incoming message log and types new messages
 * into a specific iTerm2 (or Terminal.app) session via osascript.
 *
 * Usage:  npx whazaa watch <session-id>
 *
 * Environment variables:
 *   WHAZAA_LOG            Path to incoming message log (default: /tmp/whazaa-incoming.log)
 *   WHAZAA_POLL_INTERVAL  Seconds between checks (default: 2)
 *   WHAZAA_PREFIX         Message prefix (default: [WhatsApp])
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// --- Configuration -----------------------------------------------------------

interface WatchConfig {
  sessionId: string;
  logFile: string;
  pollInterval: number;
  prefix: string;
}

function resolveConfig(sessionId: string): WatchConfig {
  return {
    sessionId,
    logFile: process.env.WHAZAA_LOG || "/tmp/whazaa-incoming.log",
    pollInterval:
      (parseInt(process.env.WHAZAA_POLL_INTERVAL || "2", 10) || 2) * 1_000,
    prefix: process.env.WHAZAA_PREFIX || "[WhatsApp]",
  };
}

// --- Terminal adapters -------------------------------------------------------

/**
 * Type text into an iTerm2 session and press Enter.
 * Uses AppleScript via stdin to avoid shell escaping issues.
 */
function typeIntoIterm(sessionId: string, text: string): boolean {
  // Escape for AppleScript string literal (backslash then double-quote)
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
  return "session not found"
end tell`;

  const result = spawnSync("osascript", [], {
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5_000,
  });

  const stdout = result.stdout?.toString().trim() ?? "";
  if (stdout === "session not found") {
    process.stderr.write(
      `[whazaa-watch] Session ${sessionId} not found in iTerm2\n`
    );
    return false;
  }
  if (result.status !== 0) {
    const err = result.stderr?.toString().trim() ?? "unknown error";
    process.stderr.write(`[whazaa-watch] osascript error: ${err}\n`);
    return false;
  }
  return true;
}

// --- Main loop ---------------------------------------------------------------

export async function watch(rawSessionId: string): Promise<void> {
  // Strip the iTerm2 prefix (e.g. "w1t1p0:GUID" → "GUID")
  const sessionId = rawSessionId.includes(":")
    ? rawSessionId.split(":").pop()!
    : rawSessionId;

  const config = resolveConfig(sessionId);

  // Ensure log file exists and is empty
  writeFileSync(config.logFile, "");

  console.log(`Whazaa Watch`);
  console.log(`  Session:  ${config.sessionId}`);
  console.log(`  Log file: ${config.logFile}`);
  console.log(`  Interval: ${config.pollInterval / 1_000}s`);
  console.log(`  Prefix:   ${config.prefix}`);
  console.log(`\nWaiting for messages...\n`);

  let seen = 0;

  // Graceful shutdown
  const cleanup = (signal: string) => {
    console.log(`\n[whazaa-watch] ${signal} received. Stopping.`);
    process.exit(0);
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

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
      const sent = typeIntoIterm(
        config.sessionId,
        `${config.prefix} ${msg}`
      );
      if (!sent) {
        console.log("[whazaa-watch] Failed to type into session");
      }
    }

    seen = lines.length;
  }, config.pollInterval);

  // Keep process alive
  await new Promise(() => {});
}
