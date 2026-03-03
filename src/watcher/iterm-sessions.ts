/**
 * iterm-sessions.ts — Higher-level iTerm2 session management.
 *
 * Shared primitives (session var read/write, session resolution) are
 * re-exported from aibroker. WA-specific handler functions (handleTerminal,
 * handleRelocate, handleKillSession, handleEndSession) and the more complex
 * getSessionList/createClaudeSession stay local.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";

import {
  setItermSessionVar,
  setItermTabName,
  getItermSessionVar,
  findItermSessionForTermId,
} from "aibroker";

import {
  runAppleScript,
  isItermRunning,
  isClaudeRunningInSession,
  typeIntoSession,
  sendKeystrokeToSession,
  snapshotAllSessions,
} from "./iterm-core.js";
import { log } from "./log.js";
import {
  sessionRegistry,
  managedSessions,
  activeItermSessionId,
  setActiveItermSessionId,
  clientQueues,
  updateSessionTtyCache,
} from "./state.js";
import { watcherSendMessage } from "./send.js";
import { saveSessionRegistry } from "./persistence.js";

// ── Re-export shared session primitives from aibroker ──

export { setItermSessionVar, setItermTabName, getItermSessionVar, findItermSessionForTermId };

// ── Local: Name deduplication (not in aibroker) ──

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

// ── Local: Create Claude session (WA-specific: waits 8s, launches iTerm) ──

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

// ── Local: Find Claude in directory ──

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

// ── Local: Tilde expansion ──

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

// ── Local: handleTerminal (/t command) ──

export function handleTerminal(commandOrNull: string | null): void {
  const command = commandOrNull?.trim() || null;
  log(`/t -> ${command ?? "(plain terminal)"}`);

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

  const label = command ?? "Terminal";
  managedSessions.set(result, { name: label, createdAt: Date.now() });
  setActiveItermSessionId(result);
  setItermSessionVar(result, label);

  log(`/t: opened terminal "${label}" (session ${result})`);
  watcherSendMessage(`Opened terminal *${label}* ← active`).catch(() => {});

  if (command) {
    const sessionId = result;
    (async () => {
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
          const lines = contents.split("\n");
          const cmdIdx = lines.findIndex((l) => l.includes(command));
          const outputLines = cmdIdx >= 0 ? lines.slice(cmdIdx + 1) : lines;
          while (outputLines.length > 0 && outputLines[outputLines.length - 1].trim() === "") {
            outputLines.pop();
          }
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

// ── Local: handleRelocate (/relocate command) ──

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

// ── Local: Session listing (WA-specific: batchResolveCwds, Claude process detection) ──

function cwdFromTty(tty: string): string {
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

export function getSessionList(): Array<{
  id: string; name: string; path: string;
  type: "claude" | "terminal";
  paiName: string | null; atPrompt: boolean;
}> {
  const snapshot = snapshotAllSessions();
  const snapshotIds = new Set(snapshot.map((s) => s.id));

  updateSessionTtyCache(snapshot);

  const claudeTtys = new Set<string>();
  try {
    const psResult = spawnSync("ps", ["-eo", "tty,comm"], {
      timeout: 3_000,
      encoding: "utf8",
    });
    if (psResult.status === 0 && psResult.stdout) {
      for (const line of psResult.stdout.split("\n")) {
        if (/\bclaude\b/.test(line) || /\bnode\b/.test(line)) {
          const tty = line.trim().split(/\s+/)[0];
          if (tty && tty !== "??") claudeTtys.add(`/dev/${tty}`);
        }
      }
    }
  } catch { /* ps failure is non-fatal */ }

  function hasClaudeProcess(snap: { tty: string }): boolean {
    if (!snap.tty || claudeTtys.size === 0) return true;
    return claudeTtys.has(snap.tty);
  }

  const claudeSnapshots = snapshot.filter((s) =>
    s.name.toLowerCase().includes("claude") && hasClaudeProcess(s)
  );

  const claudeSessions = claudeSnapshots.map((s) => ({
    id: s.id,
    name: s.name,
    path: "",
    type: "claude" as const,
    paiName: s.paiName,
    atPrompt: s.atPrompt,
  }));

  const seenIds = new Set(claudeSessions.map((s) => s.id));

  for (const [, entry] of sessionRegistry) {
    if (entry.itermSessionId && !seenIds.has(entry.itermSessionId) && snapshotIds.has(entry.itermSessionId)) {
      const snap = snapshot.find((s) => s.id === entry.itermSessionId)!;
      if (!hasClaudeProcess(snap)) continue;
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

// ── Local: handleKillSession (/kill N for Claude sessions) ──

export async function handleKillSession(
  target: { id: string; name: string; path: string }
): Promise<void> {
  await watcherSendMessage(`Killing Claude in session "${target.name}"...`).catch(() => {});
  log(`/kill: targeting session ${target.id} ("${target.name}")`);

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
    await watcherSendMessage("No Claude process found in that session. Restarting...").catch(() => {});
    typeIntoSession(target.id, "claude");
    await watcherSendMessage("Restarted Claude.").catch(() => {});
    return;
  }

  log(`/kill: found Claude PID ${claudePid} on ${tty}`);

  const killResult = spawnSync("kill", ["-TERM", claudePid], { timeout: 5000 });
  if (killResult.status !== 0) {
    log("/kill: SIGTERM failed, trying SIGKILL");
    spawnSync("kill", ["-KILL", claudePid], { timeout: 5000 });
  }

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

  typeIntoSession(target.id, "claude");
  await new Promise((r) => setTimeout(r, 3000));

  const paiName = getItermSessionVar(target.id);
  const label = paiName ?? (target.path ? basename(target.path) : target.name);
  await watcherSendMessage(`Killed and restarted Claude in *${label}*`).catch(() => {});
  log(`/kill: restarted Claude in session ${target.id}`);
}

// ── Local: handleKillTerminalSession (/kill N for terminal sessions) ──

export async function handleKillTerminalSession(
  target: { id: string; name: string; path: string; type: "claude" | "terminal" }
): Promise<void> {
  await watcherSendMessage(`Closing terminal session "${target.name}"...`).catch(() => {});
  log(`/kill: closing terminal session ${target.id} ("${target.name}")`);

  sendKeystrokeToSession(target.id, 3);
  await new Promise((r) => setTimeout(r, 500));

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

  managedSessions.delete(target.id);

  if (activeItermSessionId === target.id) {
    setActiveItermSessionId("");
  }

  await watcherSendMessage(`Closed terminal session *${target.name}*`).catch(() => {});
}

// ── Local: handleEndSession (/x N command) ──

export async function handleEndSession(
  target: { id: string; name: string; path: string; type: "claude" | "terminal" }
): Promise<void> {
  const label = target.name;
  await watcherSendMessage(`Ending session "${label}"...`).catch(() => {});
  log(`/x: ending session ${target.id} ("${label}")`);

  if (target.type === "claude") {
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

  managedSessions.delete(target.id);

  for (const [sid, entry] of sessionRegistry) {
    if (entry.itermSessionId === target.id) {
      sessionRegistry.delete(sid);
      clientQueues.delete(sid);
      log(`/x: removed registry entry ${sid} ("${entry.name}")`);
    }
  }

  if (activeItermSessionId === target.id) {
    setActiveItermSessionId("");
  }

  saveSessionRegistry();
  await watcherSendMessage(`Ended session *${label}*`).catch(() => {});
}
