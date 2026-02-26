/**
 * iterm-sessions.ts — Higher-level iTerm2 session management.
 *
 * This module sits one layer above `iterm-core` and provides the business
 * logic for managing Claude Code sessions inside iTerm2. It handles:
 *
 * - **Session variables** — reading and writing the `user.paiName` custom
 *   variable that survives tab-title rewrites by Claude Code.
 * - **Tab naming** — overriding the visible iTerm2 tab/session title via
 *   AppleScript `set name to`.
 * - **Session discovery** — finding an existing Claude session by directory,
 *   cross-referencing TERM_SESSION_ID environment variables, and listing all
 *   active Claude sessions.
 * - **Session creation** — opening new iTerm2 tabs that launch `claude` or a
 *   plain shell, and the `/relocate` command handler.
 * - **Session lifecycle** — `/kill` (terminate + restart Claude) and `/t`
 *   (open a plain terminal tab) WhatsApp command handlers.
 *
 * All public functions log diagnostic information to stderr with the
 * `[whazaa-watch]` prefix so the watcher process log remains searchable.
 *
 * Dependencies: iterm-core, state, send
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { basename } from "node:path";

import {
  runAppleScript,
  isItermRunning,
  isClaudeRunningInSession,
  isItermSessionAlive,
  typeIntoSession,
  sendKeystrokeToSession,
  stripItermPrefix,
  withSessionAppleScript,
  snapshotAllSessions,
} from "./iterm-core.js";
import { log } from "./log.js";
import {
  sessionRegistry,
  managedSessions,
  activeItermSessionId,
  setActiveItermSessionId,
  clientQueues,
} from "./state.js";
import { watcherSendMessage } from "./send.js";
import { saveSessionRegistry } from "./persistence.js";

// ---------------------------------------------------------------------------
// Session variable helpers
// ---------------------------------------------------------------------------

/**
 * Shared inner helper for `setItermSessionVar` and `setItermTabName`.
 *
 * Builds and runs an AppleScript that finds the session by UUID and executes
 * `body` inside a `tell aSession` block. Uses `execSync` with a heredoc
 * because `execSync` tolerates longer string arguments without the size
 * limitations that can affect `spawnSync` on some macOS versions.
 *
 * Silently no-ops on any error.
 *
 * @param itermSessionId - The iTerm2 session UUID to target.
 * @param body - The AppleScript statement(s) to execute inside `tell aSession`.
 */
function setItermSessionProperty(itermSessionId: string, body: string): void {
  try {
    const script = withSessionAppleScript(
      itermSessionId,
      `          tell aSession\n            ${body}\n          end tell\n          return`,
      ""
    );
    execSync(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      timeout: 5000,
      shell: "/bin/bash",
    });
  } catch {
    // silently ignore
  }
}

/**
 * Persist a human-readable label as the `user.paiName` session variable on an
 * iTerm2 session.
 *
 * Claude Code continuously overwrites the iTerm2 tab title with its own status
 * text. Storing the PAI-assigned name in a custom session variable allows the
 * watcher to recover the label after a restart or tab-title change by calling
 * `getItermSessionVar`.
 *
 * @param itermSessionId - The iTerm2 session UUID to write to.
 * @param name - The label to store. Newlines are replaced with spaces, and
 *   backslashes/double-quotes are escaped before embedding in AppleScript.
 *   Silently no-ops on any error (iTerm2 not running, session not found, etc.).
 */
export function setItermSessionVar(itermSessionId: string, name: string): void {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r]/g, " ");
  setItermSessionProperty(itermSessionId, `set variable named "user.paiName" to "${escaped}"`);
}

/**
 * Set the visible tab title of an iTerm2 session via AppleScript.
 *
 * The AppleScript `set name to` call overrides the dynamic title produced by
 * the shell's `PROMPT_COMMAND` / `precmd` hooks until the next time the shell
 * or a running process updates the title. Because Claude Code rewrites the
 * title frequently, the override is temporary — use `setItermSessionVar` to
 * store the label durably.
 *
 * Silently no-ops on any error (iTerm2 not running, session not found, timeout,
 * etc.).
 *
 * @param itermSessionId - The iTerm2 session UUID whose tab title to update.
 * @param name - The string to display in the tab. Newlines are replaced with
 *   spaces; backslashes and double-quotes are escaped for AppleScript.
 */
export function setItermTabName(itermSessionId: string, name: string): void {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r]/g, " ");
  setItermSessionProperty(itermSessionId, `set name to "${escaped}"`);
}

/**
 * Read the `user.paiName` custom session variable from an iTerm2 session.
 *
 * This is the counterpart to `setItermSessionVar` and is used to recover the
 * PAI-assigned label for a session after the watcher restarts or after Claude
 * Code has overwritten the tab title.
 *
 * AppleScript returns the literal string `"missing value"` when a variable has
 * never been set; this function normalises that to `null`.
 *
 * @param itermSessionId - The iTerm2 session UUID to read from.
 * @returns The stored label string, or `null` if the variable is unset,
 *   the session does not exist, or an error occurs.
 */
export function getItermSessionVar(itermSessionId: string): string | null {
  try {
    const script = withSessionAppleScript(
      itermSessionId,
      `          tell aSession\n            try\n              return (variable named "user.paiName")\n            on error\n              return ""\n            end try\n          end tell`,
      'return ""'
    );
    const result = execSync(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      timeout: 5000,
      encoding: "utf8",
      shell: "/bin/bash",
    }).trim();
    // AppleScript returns literal "missing value" when variable is unset
    return (result && result !== "missing value") ? result : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an iTerm2 session UUID from a `TERM_SESSION_ID` environment variable
 * value (or a directly provided `ITERM_SESSION_ID` hint).
 *
 * MCP hook scripts running inside Claude Code have access to both
 * `TERM_SESSION_ID` (the terminal emulator's session identifier) and
 * `ITERM_SESSION_ID` (the iTerm2-specific UUID in `"w0t2p0:UUID"` format).
 * When the hook provides the latter as `itermSessionIdHint`, this function
 * strips the `"w0t2p0:"` prefix and returns the bare UUID immediately, avoiding
 * a potentially slow AppleScript scan.
 *
 * When only `termSessionId` is available, the function falls back to an
 * AppleScript scan that reads the `TERM_SESSION_ID` variable from every live
 * iTerm2 session and returns the UUID of the first match.
 *
 * @param termSessionId - The value of the `TERM_SESSION_ID` environment
 *   variable from inside the terminal (used as a fallback scan key).
 * @param itermSessionIdHint - Optional. The value of `ITERM_SESSION_ID` from
 *   inside iTerm2, in either `"UUID"` or `"w0t2p0:UUID"` format. When
 *   provided, the AppleScript scan is skipped entirely.
 * @returns The bare iTerm2 session UUID on success, or `null` if no matching
 *   session is found or the scan fails.
 */
export function findItermSessionForTermId(
  termSessionId: string,
  itermSessionIdHint?: string
): string | null {
  // If the client passed its ITERM_SESSION_ID directly, trust it.
  // ITERM_SESSION_ID can be "UUID" or "w0t2p0:UUID" — strip any prefix
  // before the colon because AppleScript's `id of aSession` returns just
  // the bare UUID.
  if (itermSessionIdHint) {
    return stripItermPrefix(itermSessionIdHint) ?? itermSessionIdHint;
  }

  // Otherwise scan all iTerm2 sessions for a matching TERM_SESSION_ID
  const script = `
tell application "iTerm2"
  set output to ""
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set sessionId to id of aSession
        try
          set termId to (variable named "TERM_SESSION_ID" of aSession)
        on error
          set termId to ""
        end try
        if termId is "${termSessionId}" then
          return sessionId
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;

  const result = runAppleScript(script);
  return result && result !== "" ? result : null;
}

/**
 * Return a session label that does not collide with any existing entry in the
 * `sessionRegistry`.
 *
 * When a user assigns the same name to two Claude sessions (e.g. both in a
 * directory called `api`), this function appends a numeric suffix to make the
 * second name unique: `"api"` → `"api (2)"` → `"api (3)"`, etc.
 *
 * The session being renamed is excluded from the collision check so that
 * re-registering an existing session with its current name is always a no-op.
 *
 * @param name - The desired human-readable session label.
 * @param excludeSessionId - The `TERM_SESSION_ID` of the session that is
 *   being registered or renamed. Its own current name is not counted as a
 *   collision so renaming to the same name is idempotent.
 * @returns The deduplicated label — either `name` unchanged if the slot is
 *   free, or `"name (N)"` for the lowest available integer N >= 2.
 */
export function deduplicateName(name: string, excludeSessionId: string): string {
  const taken = new Set<string>();
  for (const [sid, entry] of sessionRegistry) {
    if (sid !== excludeSessionId) {
      taken.add(entry.name);
    }
  }

  if (!taken.has(name)) return name;

  let n = 2;
  while (taken.has(`${name} (${n})`)) {
    n++;
  }
  return `${name} (${n})`;
}

/**
 * Open a new iTerm2 tab, navigate to the user's home directory, and launch
 * Claude Code (`claude`).
 *
 * If iTerm2 is not currently running, this function attempts to launch it via
 * `open -a iTerm` and waits up to 10 seconds for the process to appear.
 *
 * If iTerm2 has no open windows, a new window is created; otherwise a new tab
 * is added to the current window.
 *
 * After spawning Claude, the function waits 8 seconds for Claude Code to
 * initialise before returning, so callers can immediately start sending
 * messages to the session.
 *
 * @returns The iTerm2 session UUID of the newly created session, or `null` if
 *   the AppleScript call to create the tab failed.
 */
export function createClaudeSession(): string | null {
  const home = homedir();

  if (!isItermRunning()) {
    log("iTerm2 not running, launching...");
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
    log("Failed to create new iTerm2 tab");
    return null;
  }

  log(`Created new claude session: ${sessionId}`);
  log("Waiting for Claude Code to start...");
  spawnSync("sleep", ["8"]);

  return sessionId;
}

/**
 * Find an existing iTerm2 session that is running Claude Code in a specific
 * working directory.
 *
 * Reads `session.path` (the shell's current directory as tracked by iTerm2)
 * from every open session and returns the first UUID whose path matches
 * `targetDir` exactly AND whose tab name contains "claude" (case-insensitive).
 *
 * Used by `handleRelocate` to avoid opening a duplicate tab when an existing
 * Claude session is already in the requested directory.
 *
 * @param targetDir - The absolute directory path to match against each
 *   session's `session.path` iTerm2 variable.
 * @returns The iTerm2 session UUID of the first matching session, or `null`
 *   if no matching session exists or the AppleScript call fails.
 */
export function findClaudeInDirectory(targetDir: string): string | null {
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
      log(`Found existing Claude session in ${targetDir}: ${id}`);
      return id;
    }
  }

  return null;
}

/**
 * Expand a shell-style tilde prefix in a file path to the user's home
 * directory.
 *
 * Handles three cases:
 * - `"~"` alone → returns `os.homedir()`
 * - `"~/..."` → returns `os.homedir() + "/..."`
 * - Anything else → returns the path unchanged
 *
 * @param p - A file path that may start with `"~"` or `"~/"`.
 * @returns The absolute expanded path.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Handle the `/t [command]` WhatsApp command.
 *
 * Opens a new plain terminal tab in iTerm2 (running `/bin/zsh`, not Claude).
 * If `commandOrNull` is provided, that command is typed into the new tab
 * immediately after it opens. The new session is registered in
 * `managedSessions` so the `/s` session-list command and `/N` session-switch
 * commands can find it.
 *
 * Side-effects:
 * - Sets the new session as the active iTerm2 session (`setActiveItermSessionId`).
 * - Persists the label in the iTerm2 `user.paiName` session variable so it
 *   survives watcher restarts.
 * - Sends a WhatsApp confirmation message with the label and "← active" marker.
 *
 * @param commandOrNull - An optional shell command to run in the new tab.
 *   Pass `null` or an empty string to open a blank interactive shell. The
 *   command is used as the session label when registering in `managedSessions`.
 */
export function handleTerminal(commandOrNull: string | null): void {
  const command = commandOrNull?.trim() || null;
  log(`/t -> ${command ?? "(plain terminal)"}`);

  // Build AppleScript: open a new tab (plain shell, default profile),
  // optionally run the command, and return the session ID.
  const writeCmd = command
    ? `\n      write text "${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : "";

  const script = `
tell application "iTerm2"
  if (count of windows) = 0 then
    set newWindow to (create window with default profile command "/bin/zsh")
    set newSession to current session of current tab of newWindow
    tell newSession${writeCmd}
    end tell
    activate
    return id of newSession
  else
    tell current window
      set newTab to (create tab with default profile command "/bin/zsh")
      set newSession to current session of newTab
      tell newSession${writeCmd}
      end tell
      return id of newSession
    end tell
  end if
end tell`;

  const result = runAppleScript(script);
  if (result === null) {
    log("/t: failed to open terminal tab");
    watcherSendMessage("Failed to open terminal tab.").catch(() => {});
    return;
  }

  // Register in managedSessions so /s and /N can find it
  const label = command ?? "Terminal";
  managedSessions.set(result, { name: label, createdAt: Date.now() });

  // Track as active iTerm2 session so /N switching works
  setActiveItermSessionId(result);

  // Persist the name in iTerm2 session variable for recovery across watcher restarts
  setItermSessionVar(result, label);

  log(`/t: opened terminal "${label}" (session ${result})`);
  watcherSendMessage(`Opened terminal *${label}* ← active`).catch(() => {});

  // If a command was run, capture its output after a delay and relay it.
  if (command) {
    const sessionId = result;
    (async () => {
      // Wait for the command to produce output. Most quick commands (pwd, ls,
      // ps, pkill) finish within 2s. We poll twice to catch slower commands.
      for (const delay of [2000, 3000]) {
        await new Promise((r) => setTimeout(r, delay));
        const bufferScript = `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${sessionId}" then
          return contents of s
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;
        const contents = runAppleScript(bufferScript);
        if (contents && contents.trim().length > 0) {
          // The buffer includes the shell prompt, command, and output.
          // Split into lines, skip the first line (prompt + command), and trim trailing prompt.
          const lines = contents.split("\n");
          // Find the command in the buffer to skip past it
          const cmdIdx = lines.findIndex((l) => l.includes(command));
          const outputLines = cmdIdx >= 0 ? lines.slice(cmdIdx + 1) : lines;
          // Drop trailing empty lines and the final shell prompt
          while (outputLines.length > 0 && outputLines[outputLines.length - 1].trim() === "") {
            outputLines.pop();
          }
          // If the last line looks like a prompt (ends with $ or % or #), drop it
          if (outputLines.length > 0 && /[%$#>]\s*$/.test(outputLines[outputLines.length - 1])) {
            outputLines.pop();
          }
          const output = outputLines.join("\n").trim();
          if (output.length > 0) {
            const maxLen = 3000;
            const trimmed = output.length > maxLen ? output.slice(0, maxLen) + "\n..." : output;
            await watcherSendMessage(trimmed).catch(() => {});
            log(`/t: relayed ${output.length} chars of output for "${command}"`);
            return;
          }
        }
      }
      log(`/t: no output captured for "${command}"`);
    })().catch((err) => log(`/t: output capture error — ${err}`));
  }
}

/**
 * Handle the `/relocate <path>` WhatsApp command.
 *
 * Attempts to focus an existing Claude Code session already running in
 * `targetPath`. If such a session is found and still alive, it is brought to
 * the foreground and its UUID is returned. If no existing session is found (or
 * the one found has since closed), a new iTerm2 tab is opened with
 * `cd "<path>" && claude` and the new session UUID is returned.
 *
 * Tilde paths (e.g. `"~/Projects/foo"`) are expanded to absolute paths before
 * matching.
 *
 * @param targetPath - The target working directory. May start with `"~"` or
 *   `"~/"` — tilde expansion is applied automatically.
 * @returns The iTerm2 session UUID of the focused or newly created session,
 *   or `null` if opening a new tab failed.
 */
export function handleRelocate(targetPath: string): string | null {
  log(`/relocate -> ${targetPath}`);

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
      log(`/relocate: focused existing session ${existingSession} in ${targetPath}`);
      return existingSession;
    }
    log(`/relocate: session ${existingSession} vanished, opening new tab`);
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
    log("/relocate: failed to open new iTerm2 tab");
    return null;
  }
  log(`/relocate: opened new tab in ${targetPath} (session ${result})`);
  return result;
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

/**
 * Resolve the current working directory of a `claude` process running on the
 * given TTY device.
 *
 * Strategy:
 * 1. Run `ps -eo pid,tty,comm` to find all processes.
 * 2. Find the first line whose TTY matches `tty` (short form, without `/dev/`)
 *    and whose command contains `"claude"`.
 * 3. Run `lsof -a -d cwd -p <pid> -Fn` to read the process's open file
 *    descriptors and extract the `cwd` (`n` record) path.
 *
 * Returns an empty string if no matching process is found or if either
 * command fails.
 *
 * @param tty - The full TTY device path (e.g. `"/dev/ttys003"`) from iTerm2's
 *   `tty of aSession` AppleScript property.
 * @returns The absolute working directory path of the Claude process, or `""`
 *   if it cannot be determined.
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

/**
 * Enumerate all iTerm2 sessions whose tab name contains "Claude" or "claude".
 *
 * For each matching session the function reads the session's TTY device path
 * and then calls `cwdFromTty` to resolve the working directory of the Claude
 * process running on that TTY. The result is an array of plain objects that
 * callers can display in the `/s` session list or use for directory-based
 * matching.
 *
 * Note: This function performs an AppleScript call plus one `ps` and one
 * `lsof` call per session, so it is moderately expensive. It should not be
 * called in tight loops or on every incoming message.
 *
 * @returns An array of `{ id, name, path }` objects — one per Claude session.
 *   `id` is the bare iTerm2 session UUID, `name` is the visible tab title,
 *   and `path` is the working directory (empty string if unknown).
 *   Returns an empty array if iTerm2 is not running or has no Claude sessions.
 */
export function listClaudeSessions(): Array<{ id: string; name: string; path: string }> {
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
 * Batch-resolve working directories for multiple sessions in a single
 * `ps` + `lsof` pass, replacing the previous per-session `cwdFromTty`
 * approach that spawned 2×N sub-processes.
 *
 * @returns A map from TTY device path (e.g. `/dev/ttys003`) to the
 *   absolute working directory of the Claude process on that TTY.
 */
function batchResolveCwds(sessions: Array<{ tty: string }>): Map<string, string> {
  const result = new Map<string, string>();
  if (sessions.length === 0) return result;

  const psResult = spawnSync("ps", ["-eo", "pid,tty,comm"], { timeout: 5000 });
  if (psResult.status !== 0) return result;

  const ttyShorts = new Set(sessions.map((s) => s.tty.replace("/dev/", "")));
  const pids: string[] = [];
  const pidToTty = new Map<string, string>();

  for (const line of psResult.stdout.toString().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.includes("claude")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3 && ttyShorts.has(parts[1])) {
      pids.push(parts[0]);
      const originalTty = sessions.find((s) => s.tty.replace("/dev/", "") === parts[1])?.tty;
      if (originalTty) pidToTty.set(parts[0], originalTty);
    }
  }

  if (pids.length === 0) return result;

  const lsofResult = spawnSync("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"], { timeout: 10_000 });
  if (lsofResult.status !== 0) return result;

  let currentPid = "";
  for (const l of lsofResult.stdout.toString().split("\n")) {
    if (l.startsWith("p")) {
      currentPid = l.slice(1);
    } else if (l.startsWith("n/")) {
      const tty = pidToTty.get(currentPid);
      if (tty) result.set(tty, l.slice(1));
    }
  }

  return result;
}

/**
 * Build the merged session list shown by the `/s` WhatsApp command.
 *
 * Uses `snapshotAllSessions()` to collect all iTerm2 session data in a
 * **single** AppleScript call, and `batchResolveCwds()` to resolve working
 * directories in a single `ps` + `lsof` pass.  This replaces the previous
 * approach that spawned 30-60+ synchronous sub-processes and blocked the
 * event loop long enough to cause Baileys WebSocket timeouts.
 *
 * Combines three sources in priority order:
 * 1. **Auto-detected Claude sessions** — sessions whose tab name contains
 *    "Claude"/"claude".
 * 2. **Registry sessions** from `sessionRegistry` that have an `itermSessionId`
 *    but whose tab name no longer matches "claude".
 * 3. **Managed terminal sessions** from `managedSessions` — plain shell tabs
 *    opened via `/t`. Liveness is checked against the snapshot (zero extra
 *    AppleScript calls).
 *
 * @returns A deduplicated array of session descriptors with `paiName` and
 *   `atPrompt` fields so callers can avoid additional AppleScript calls.
 */
export function getSessionList(): Array<{
  id: string; name: string; path: string;
  type: "claude" | "terminal";
  paiName: string | null; atPrompt: boolean;
}> {
  // Single AppleScript call replaces N×listClaudeSessions + N×isItermSessionAlive
  // + N×getItermSessionVar + isClaudeRunningInSession
  const snapshot = snapshotAllSessions();
  const snapshotIds = new Set(snapshot.map((s) => s.id));

  // Filter for Claude sessions (tab name contains "claude")
  const claudeSnapshots = snapshot.filter((s) =>
    s.name.toLowerCase().includes("claude")
  );

  // Skip cwd resolution here — paiName / registry name is preferred for display
  // and batchResolveCwds (ps + lsof) adds noticeable latency.  Callers that
  // need the working directory can resolve it on demand.
  const claudeSessions = claudeSnapshots.map((s) => ({
    id: s.id,
    name: s.name,
    path: "",
    type: "claude" as const,
    paiName: s.paiName,
    atPrompt: s.atPrompt,
  }));

  const seenIds = new Set(claudeSessions.map((s) => s.id));

  // Merge registered MCP sessions not found by tab-name scan.
  // Only include entries whose iTerm2 session is still alive in the snapshot —
  // otherwise dead registry entries become ghosts that /s shows but /N can't find.
  for (const [, entry] of sessionRegistry) {
    if (entry.itermSessionId && !seenIds.has(entry.itermSessionId) && snapshotIds.has(entry.itermSessionId)) {
      const snap = snapshot.find((s) => s.id === entry.itermSessionId)!;
      claudeSessions.push({
        id: entry.itermSessionId,
        name: entry.name,
        path: "",
        type: "claude" as const,
        paiName: snap.paiName,
        atPrompt: snap.atPrompt,
      });
      seenIds.add(entry.itermSessionId);
    }
  }

  // Managed terminal sessions — check liveness from snapshot (zero AppleScript)
  type SessionEntry = { id: string; name: string; path: string; type: "claude" | "terminal"; paiName: string | null; atPrompt: boolean };
  const terminalSessions: SessionEntry[] = [];
  for (const [id, entry] of managedSessions) {
    if (seenIds.has(id)) {
      managedSessions.delete(id);
      continue;
    }
    if (snapshotIds.has(id)) {
      const snap = snapshot.find((s) => s.id === id)!;
      terminalSessions.push({
        id,
        name: snap.paiName ?? entry.name,
        path: "",
        type: "terminal",
        paiName: snap.paiName,
        atPrompt: snap.atPrompt,
      });
    } else {
      managedSessions.delete(id);
    }
  }

  return [...claudeSessions, ...terminalSessions];
}

/**
 * Handle the `/kill N` WhatsApp command for a Claude Code session.
 *
 * Performs a graceful-then-forced kill of the Claude Code process and
 * immediately restarts it in the same terminal tab. The sequence is:
 *
 * 1. Retrieve the TTY device path of the target session via AppleScript.
 * 2. Use `ps -eo pid,tty,comm` to find the Claude PID on that TTY.
 * 3. Send `SIGTERM`; if that fails, escalate to `SIGKILL`.
 * 4. Poll `isClaudeRunningInSession` for up to 10 seconds waiting for the
 *    shell prompt to return.
 * 5. Send a final `SIGKILL` if the process has not exited after 10 seconds.
 * 6. Type `claude` into the session to restart Claude Code.
 * 7. Wait 3 seconds for Claude to initialise, then send a WhatsApp
 *    confirmation with the session label.
 *
 * If no Claude process is found on the TTY (already at shell prompt), the
 * function skips straight to step 6.
 *
 * @param target - The session to target, as returned by `getSessionList`:
 *   `id` (iTerm2 UUID), `name` (display label), `path` (working directory).
 */
export async function handleKillSession(
  target: { id: string; name: string; path: string }
): Promise<void> {
  await watcherSendMessage(`Killing Claude in session "${target.name}"...`).catch(() => {});
  log(`/kill: targeting session ${target.id} ("${target.name}")`);

  // Get the TTY of the target session
  const ttyScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${target.id}" then
          return tty of aSession
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;

  const tty = runAppleScript(ttyScript);
  if (!tty) {
    await watcherSendMessage("Error: Could not find session TTY.").catch(() => {});
    return;
  }

  // Find the Claude PID on this TTY
  const ttyShort = tty.replace("/dev/", "");
  const psResult = spawnSync("ps", ["-eo", "pid,tty,comm"], { timeout: 5000 });
  if (psResult.status !== 0) {
    await watcherSendMessage("Error: Could not list processes.").catch(() => {});
    return;
  }

  let claudePid: string | null = null;
  const psLines = psResult.stdout.toString().split("\n");
  for (const line of psLines) {
    const trimmed = line.trim();
    if (trimmed.includes(ttyShort) && trimmed.includes("claude")) {
      claudePid = trimmed.split(/\s+/)[0];
      break;
    }
  }

  if (!claudePid) {
    // No Claude process found — might already be at shell prompt
    await watcherSendMessage("No Claude process found in that session. Restarting...").catch(() => {});
    typeIntoSession(target.id, "claude");
    await watcherSendMessage("Restarted Claude.").catch(() => {});
    return;
  }

  log(`/kill: found Claude PID ${claudePid} on ${tty}`);

  // Kill the Claude process
  const killResult = spawnSync("kill", ["-TERM", claudePid], { timeout: 5000 });
  if (killResult.status !== 0) {
    log("/kill: SIGTERM failed, trying SIGKILL");
    spawnSync("kill", ["-KILL", claudePid], { timeout: 5000 });
  }

  // Wait for the shell prompt to come back (poll up to 10 seconds)
  let atPrompt = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isClaudeRunningInSession(target.id)) {
      atPrompt = true;
      break;
    }
  }

  if (!atPrompt) {
    log("/kill: session not at prompt after 10s, sending SIGKILL");
    spawnSync("kill", ["-KILL", claudePid], { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Restart Claude in the same session
  typeIntoSession(target.id, "claude");

  // Wait for Claude to start up
  await new Promise((r) => setTimeout(r, 3000));

  const paiName = getItermSessionVar(target.id);
  const label = paiName ?? (target.path ? basename(target.path) : target.name);
  await watcherSendMessage(`Killed and restarted Claude in *${label}*`).catch(() => {});
  log(`/kill: restarted Claude in session ${target.id}`);
}

/**
 * Handle the `/kill N` WhatsApp command for a plain terminal session (type
 * `"terminal"` as opened by `/t`).
 *
 * Unlike `handleKillSession`, this does not restart the session — it closes
 * the tab entirely. The sequence is:
 *
 * 1. Send Ctrl+C (ASCII 3) to interrupt any running foreground process.
 * 2. Wait 500 ms for the process to react.
 * 3. Close the iTerm2 tab via AppleScript `close aTab`.
 * 4. Remove the session from `managedSessions`.
 * 5. If this was the currently active iTerm2 session
 *    (`activeItermSessionId`), clear the active session so the user must
 *    re-select with `/N`.
 * 6. Send a WhatsApp confirmation message.
 *
 * @param target - The terminal session to close. Must include `id` (iTerm2
 *   UUID), `name` (display label), `path`, and `type` (expected `"terminal"`).
 */
export async function handleKillTerminalSession(
  target: { id: string; name: string; path: string; type: "claude" | "terminal" }
): Promise<void> {
  await watcherSendMessage(`Closing terminal session "${target.name}"...`).catch(() => {});
  log(`/kill: closing terminal session ${target.id} ("${target.name}")`);

  // Send Ctrl+C to interrupt any running process
  sendKeystrokeToSession(target.id, 3);

  // Brief pause to let the process react
  await new Promise((r) => setTimeout(r, 500));

  // Close the iTerm2 tab containing this session
  const closeScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${target.id}" then
          close aTab
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`;

  const result = runAppleScript(closeScript);
  if (result !== "ok") {
    log(`/kill: could not close tab for session ${target.id} (result: ${result})`);
  }

  // Remove from managedSessions registry
  managedSessions.delete(target.id);

  // If this was the active session, clear it so the user must re-select
  if (activeItermSessionId === target.id) {
    setActiveItermSessionId("");
  }

  await watcherSendMessage(`Closed terminal session *${target.name}*`).catch(() => {});
}

/**
 * Handle the `/x N` (or `/end N`) WhatsApp command — truly end a session.
 *
 * Unlike `/k` which kills and restarts Claude, this command closes the iTerm2
 * tab entirely and removes the session from all registries. Works for both
 * Claude and terminal sessions.
 *
 * @param target - The session to end, as returned by `getSessionList`.
 */
export async function handleEndSession(
  target: { id: string; name: string; path: string; type: "claude" | "terminal" }
): Promise<void> {
  const label = target.name;
  await watcherSendMessage(`Ending session "${label}"...`).catch(() => {});
  log(`/x: ending session ${target.id} ("${label}")`);

  if (target.type === "claude") {
    // Kill the Claude process before closing the tab
    const ttyScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${target.id}" then
          return tty of aSession
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;
    const tty = runAppleScript(ttyScript);
    if (tty) {
      const ttyShort = tty.replace("/dev/", "");
      const psResult = spawnSync("ps", ["-eo", "pid,tty,comm"], { timeout: 5000 });
      if (psResult.status === 0) {
        for (const line of psResult.stdout.toString().split("\n")) {
          const trimmed = line.trim();
          if (trimmed.includes(ttyShort) && trimmed.includes("claude")) {
            const pid = trimmed.split(/\s+/)[0];
            spawnSync("kill", ["-TERM", pid], { timeout: 5000 });
            break;
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  } else {
    sendKeystrokeToSession(target.id, 3);
    await new Promise((r) => setTimeout(r, 500));
  }

  // Close the iTerm2 tab
  const closeScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${target.id}" then
          close aTab
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`;
  const closeResult = runAppleScript(closeScript);
  if (closeResult !== "ok") {
    log(`/x: could not close tab for session ${target.id} (result: ${closeResult})`);
  }

  // Remove from managedSessions
  managedSessions.delete(target.id);

  // Remove ALL registry entries pointing to this iTerm session
  for (const [sid, entry] of sessionRegistry) {
    if (entry.itermSessionId === target.id) {
      sessionRegistry.delete(sid);
      clientQueues.delete(sid);
      log(`/x: removed registry entry ${sid} ("${entry.name}")`);
    }
  }

  // Clear active session if this was it
  if (activeItermSessionId === target.id) {
    setActiveItermSessionId("");
  }

  saveSessionRegistry();
  await watcherSendMessage(`Ended session *${label}*`).catch(() => {});
}
