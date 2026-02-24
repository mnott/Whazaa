/**
 * @file iterm-core.ts
 * @module watcher/iterm-core
 *
 * Low-level iTerm2 AppleScript primitives.
 *
 * This module is the foundation of all iTerm2 communication in the watcher.
 * It exposes a thin set of synchronous helpers that wrap `osascript` and
 * `spawnSync` to interact with the iTerm2 application. Every higher-level
 * session-management function in `iterm-sessions.ts` ultimately calls into
 * this module.
 *
 * Design constraints:
 * - Zero imports from the rest of the Whazaa project — pure utilities only.
 * - All AppleScript execution is synchronous (`spawnSync`) so callers can use
 *   simple boolean/string return values without async plumbing.
 * - Functions return `null` or `false` on failure rather than throwing, so
 *   callers can handle "iTerm2 not available" gracefully.
 */

import { spawnSync } from "node:child_process";

/**
 * Execute an AppleScript program via `osascript` and return its stdout.
 *
 * The script is passed over stdin so that multi-line scripts with special
 * characters do not need shell escaping. A 10-second timeout is applied to
 * prevent the watcher from hanging when iTerm2 is unresponsive.
 *
 * @param script - The complete AppleScript source to execute.
 * @returns The trimmed stdout of the script on success, or `null` if
 *   `osascript` exits with a non-zero status (e.g. iTerm2 not running,
 *   AppleScript runtime error, or timeout).
 */
export function runAppleScript(script: string): string | null {
  const result = spawnSync("osascript", [], {
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  return result.stdout?.toString().trim() ?? null;
}

/**
 * Send a single ASCII keystroke to a specific iTerm2 session without a
 * trailing newline.
 *
 * Uses `write text … newline no` in AppleScript so only the bare character is
 * injected (e.g. Ctrl+C is ASCII 3, Ctrl+D is ASCII 4, Enter is ASCII 13).
 *
 * @param sessionId - The iTerm2 session UUID (bare UUID without any
 *   "w0t2p0:"-style prefix).
 * @param asciiCode - The ASCII code of the character to inject (0–127).
 * @returns `true` if the session was found and the keystroke was delivered;
 *   `false` if the session was not found in any window/tab or the AppleScript
 *   call failed.
 */
export function sendKeystrokeToSession(sessionId: string, asciiCode: number): boolean {
  const script = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          tell aSession to write text (ASCII character ${asciiCode}) newline no
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
 * Send an ANSI cursor-movement escape sequence to a specific iTerm2 session.
 *
 * The sequence injected is `ESC [ <dirChar>` (i.e. the CSI prefix followed by
 * the direction letter), which is what terminals expect for arrow-key input.
 *
 * @param sessionId - The iTerm2 session UUID (bare UUID without any
 *   "w0t2p0:"-style prefix).
 * @param dirChar - The ANSI direction character appended after the CSI prefix:
 *   - `"A"` — cursor up
 *   - `"B"` — cursor down
 *   - `"C"` — cursor right / arrow-right
 *   - `"D"` — cursor left / arrow-left
 * @returns `true` if the session was found and the sequence was delivered;
 *   `false` otherwise.
 */
export function sendEscapeSequenceToSession(sessionId: string, dirChar: string): boolean {
  const script = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          tell aSession to write text (ASCII character 27) & "[${dirChar}" newline no
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
 * Type a text string into an iTerm2 session and then press Enter.
 *
 * The text is injected via `write text … newline no`, and Enter (ASCII 13) is
 * sent as a separate AppleScript call afterwards. Splitting text delivery and
 * Enter into two calls prevents a race condition where very long pastes could
 * time out before the newline fires.
 *
 * Backslashes and double-quotes in `text` are automatically escaped so they
 * are safe to embed inside the AppleScript string literal.
 *
 * @param sessionId - The iTerm2 session UUID (bare UUID without any
 *   "w0t2p0:"-style prefix).
 * @param text - The text to type. Will be followed by an Enter keypress.
 * @returns `true` if the text was delivered to the session (Enter is also
 *   sent as a best-effort follow-up); `false` if the session was not found
 *   or the text delivery AppleScript call failed.
 */
export function typeIntoSession(sessionId: string, text: string): boolean {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const textScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          tell aSession to write text "${escaped}" newline no
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`;

  const result = runAppleScript(textScript);
  if (result !== "ok") return false;

  // Send Enter as a separate call so long text paste can't timeout before Enter fires
  sendKeystrokeToSession(sessionId, 13);
  return true;
}

/**
 * Search all open iTerm2 windows and tabs for a session whose visible name
 * contains the string "claude" (case-insensitive).
 *
 * This is used as a lightweight heuristic to locate the Claude Code terminal
 * tab without requiring the MCP client to have registered first. It iterates
 * over every window → tab → session triple and checks the session name.
 *
 * A diagnostic line is written to stderr when a matching session is found so
 * the watcher log captures the discovery.
 *
 * @returns The iTerm2 session UUID of the first matching session, or `null` if
 *   no session with "claude" in its name was found (or iTerm2 is not running).
 */
export function findClaudeSession(): string | null {
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
 * Determine whether Claude Code is actively running in a given iTerm2 session.
 *
 * Uses iTerm2's `is at shell prompt` property to distinguish between:
 * - A foreground process running (i.e. Claude is active) → returns `true`.
 * - The session is at a bare shell prompt (Claude has exited) → returns `false`
 *   and logs a warning to stderr.
 * - The session UUID was not found at all → returns `false` and logs a warning.
 *
 * This is used by `/kill` to poll until Claude has fully exited before
 * attempting a restart.
 *
 * @param sessionId - The iTerm2 session UUID to inspect.
 * @returns `true` if a foreground process (Claude) is running in the session;
 *   `false` if the session is at a shell prompt or was not found.
 */
export function isClaudeRunningInSession(sessionId: string): boolean {
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
 * Check whether the iTerm2 application is currently running.
 *
 * Uses `pgrep -x iTerm2` (exact process name match) rather than AppleScript
 * `count of windows` because AppleScript itself will hang when the target
 * application is not running. The `pgrep` approach is fast (~3 s timeout) and
 * safe to call even when no GUI is available.
 *
 * @returns `true` if an iTerm2 process is found; `false` otherwise.
 */
export function isItermRunning(): boolean {
  const result = spawnSync("pgrep", ["-x", "iTerm2"], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 3_000,
  });
  return result.status === 0;
}

/**
 * Check whether a specific iTerm2 session is still open.
 *
 * Iterates over all windows → tabs → sessions and returns `true` if the UUID
 * is found in at least one live session. Returns `false` if the session has
 * been closed (the user closed the tab, or the process exited and iTerm2
 * cleaned it up).
 *
 * Used by `getSessionList` to prune stale entries from the `managedSessions`
 * registry without making an expensive AppleScript call for every entry.
 *
 * @param sessionId - The iTerm2 session UUID to look up. Backslashes and
 *   double-quotes are escaped before embedding in the AppleScript string.
 * @returns `true` if the session UUID is found in any open window/tab;
 *   `false` if it does not exist or if the AppleScript call fails.
 */
export function isItermSessionAlive(sessionId: string): boolean {
  const escaped = sessionId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${escaped}" then return "alive"
      end repeat
    end repeat
  end repeat
  return "gone"
end tell`;
  return runAppleScript(script) === "alive";
}
