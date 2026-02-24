/**
 * @module commands
 * @file commands.ts — WhatsApp slash-command router and iTerm2 message delivery
 *
 * This module is responsible for interpreting every message that arrives from
 * the user's self-chat WhatsApp conversation and either:
 * (a) executing a built-in slash command immediately, or
 * (b) forwarding the text to the active Claude Code session in iTerm2.
 *
 * Architecture
 * ------------
 * The module exports a single factory function `createMessageHandler()` that
 * captures mutable local state (active session ID, consecutive failure count)
 * through closures and returns the concrete `handleMessage(text, timestamp)`
 * function.  This design avoids module-level mutable variables and makes the
 * handler easy to construct in `watch()` without circular imports.
 *
 * Slash commands
 * --------------
 * Commands are matched in priority order within `handleMessage`:
 *
 * | Pattern              | Description |
 * |----------------------|-------------|
 * | `/relocate <path>`   | `cd` the active session to `<path>` (alias: `/r`). |
 * | `/s`, `/sessions`    | List all iTerm2 sessions with type, name, and active marker. |
 * | `/<N> [name]`        | Switch focus to session number N; optionally rename it. |
 * | `/t [cmd]`           | Open a new raw terminal tab; optionally run a command. |
 * | `/ss`, `/screenshot` | Capture the iTerm2 window and send it back via WhatsApp. |
 * | `/cc`                | Send Ctrl+C to the active session (interrupt). |
 * | `/esc`               | Send Escape to the active session. |
 * | `/enter`             | Send Enter/Return to the active session. |
 * | `/tab`               | Send Tab (completion) to the active session. |
 * | `/up`/`/down`/`/left`/`/right` | Send arrow-key escape sequences. |
 * | `/pick N [text]`     | Navigate down (N-1) items then press Enter; optionally type text. |
 * | `/kill N`, `/k N`    | Kill session N (Claude or terminal). |
 * | _anything else_      | Dispatch to IPC client queues **and** deliver to iTerm2. |
 *
 * Message delivery strategy (`deliverMessage`)
 * ----------------------------------------------
 * 1. If the active session is a managed raw-terminal tab, type directly into it.
 * 2. If the active session is running Claude, type into it.
 * 3. If neither works, scan all iTerm2 sessions for a running Claude process.
 * 4. If still nothing, create a new iTerm2 tab and launch Claude.
 * 5. After successful delivery, start the WhatsApp typing indicator so the
 *    user sees that Claude is processing.
 *
 * Dependencies: state, iterm-sessions, screenshot, send, iterm-core, typing
 */

import { basename } from "node:path";

import {
  sessionRegistry,
  activeClientId,
  setActiveClientId,
  activeItermSessionId,
  setActiveItermSessionId,
  cachedSessionList,
  cachedSessionListTime,
  setCachedSessionList,
  clientQueues,
  managedSessions,
  watcherStatus,
  dispatchIncomingMessage,
} from "./state.js";
import {
  getSessionList,
  handleRelocate,
  handleTerminal,
  handleKillSession,
  handleKillTerminalSession,
  getItermSessionVar,
  setItermSessionVar,
  setItermTabName,
  listClaudeSessions,
  createClaudeSession,
} from "./iterm-sessions.js";
import { handleScreenshot } from "./screenshot.js";
import { watcherSendMessage } from "./send.js";
import {
  runAppleScript,
  findClaudeSession,
  isClaudeRunningInSession,
  typeIntoSession,
  sendKeystrokeToSession,
  sendEscapeSequenceToSession,
} from "./iterm-core.js";
import { startTypingIndicator } from "./typing.js";

/**
 * Create the top-level message handler function used by `watch()`.
 *
 * The factory pattern is used here because the handler needs read/write access
 * to `activeSessionId` and `consecutiveFailures`, which are owned by the
 * `watch()` function in `index.ts`.  Passing getters/setters keeps the state
 * in one place without making the variables global.
 *
 * @param getActiveSessionId     - Returns the current iTerm2 session ID that
 *   messages are delivered to.  May be an empty string if no session has been
 *   selected yet.
 * @param setActiveSessionId     - Updates the active session ID after auto-
 *   discovery or a `/N` switch command.
 * @param getConsecutiveFailures - Returns the count of successive delivery
 *   failures; used for diagnostic logging.
 * @param setConsecutiveFailures - Increments or resets the failure counter.
 *
 * @returns `handleMessage(text, timestamp)` — the function passed to
 *   `connectWatcher`'s `onMessage` callback.  Routes the text to a slash-
 *   command handler or to the iTerm2 delivery path.
 */
export function createMessageHandler(
  getActiveSessionId: () => string,
  setActiveSessionId: (id: string) => void,
  getConsecutiveFailures: () => number,
  setConsecutiveFailures: (n: number) => void,
): (text: string, timestamp: number) => void {

  /**
   * Deliver a plain text message to the active iTerm2 session.
   *
   * Uses a multi-step fallback strategy so messages are never silently dropped
   * even when the previously active session has been closed:
   *
   * 1. Sync `activeSessionId` from the module-level `activeItermSessionId`
   *    (updated by `/t`, `/N`, and auto-discovery) so changes made outside
   *    this closure are respected.
   * 2. If the active session is a managed raw-terminal tab (opened via `/t`),
   *    type directly into it.  If the tab has since closed, remove it from
   *    `managedSessions` and fall through.
   * 3. If the active session is running Claude, type into it.
   * 4. Scan all iTerm2 sessions for any running Claude process.
   * 5. Create a new iTerm2 tab and start Claude if no existing session works.
   *
   * @param text - The message body to type into the session.
   * @returns `true` if the message was successfully delivered to an iTerm2
   *   session, `false` otherwise (increments the consecutive-failure counter).
   */
  function deliverMessage(text: string): boolean {
    let activeSessionId = getActiveSessionId();

    // Sync from module-level activeItermSessionId (set by /t, /N, handleTerminal)
    // so that terminal tabs opened outside the watch() closure are respected.
    if (activeItermSessionId && activeItermSessionId !== activeSessionId) {
      activeSessionId = activeItermSessionId;
      setActiveSessionId(activeSessionId);
    }

    // If the active session is a managed terminal tab (no Claude), type directly.
    // managedSessions is keyed by bare UUID; activeSessionId may have a prefix like "w0t3p0:UUID".
    const bareSessionId = activeSessionId?.includes(":") ? activeSessionId.split(":").pop()! : activeSessionId;
    if (bareSessionId && managedSessions.has(bareSessionId)) {
      if (typeIntoSession(bareSessionId, text)) {
        setConsecutiveFailures(0);
        return true;
      }
      // Terminal session may have closed — clean up and fall through
      managedSessions.delete(bareSessionId);
    }

    if (activeSessionId && isClaudeRunningInSession(activeSessionId)) {
      if (typeIntoSession(activeSessionId, text)) {
        setConsecutiveFailures(0);
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
      setActiveSessionId(found);
      setActiveItermSessionId(found);
      if (typeIntoSession(found, text)) {
        setConsecutiveFailures(0);
        return true;
      }
    }

    process.stderr.write(
      `[whazaa-watch] No running Claude session found. Starting new one...\n`
    );

    const created = createClaudeSession();
    if (created) {
      setActiveSessionId(created);
      setActiveItermSessionId(created);
      if (typeIntoSession(created, text)) {
        setConsecutiveFailures(0);
        return true;
      }
    }

    setConsecutiveFailures(getConsecutiveFailures() + 1);
    process.stderr.write(
      `[whazaa-watch] Failed to deliver message (attempt ${getConsecutiveFailures()})\n`
    );
    return false;
  }

  /**
   * Process one incoming WhatsApp self-chat message.
   *
   * Checks for every slash-command pattern in priority order.  If the text
   * matches a command, executes that command and returns.  Otherwise, the
   * message is:
   * 1. Dispatched to all registered IPC client queues via `dispatchIncomingMessage`
   *    so MCP `whatsapp_wait` calls can receive it.
   * 2. Delivered to the active iTerm2 Claude session via `deliverMessage`.
   * 3. If delivery succeeded, the WhatsApp typing indicator is started to show
   *    the user that their message is being processed.
   *
   * @param text      - The raw text body of the incoming WhatsApp message.
   * @param timestamp - The message timestamp in milliseconds since epoch, as
   *   provided by Baileys (used for queue ordering in IPC dispatch).
   */
  return function handleMessage(text: string, timestamp: number): void {
    // --- /relocate <path> (alias: /r) ---------------------------------------
    const trimmedText = text.trim();
    const relocateMatch = trimmedText.match(/^\/relocate\s+(.+)$/) || trimmedText.match(/^\/r\s+(.+)$/);
    if (relocateMatch) {
      const targetPath = relocateMatch[1].trim();
      if (targetPath) {
        const newSessionId = handleRelocate(targetPath);
        if (newSessionId) {
          setActiveSessionId(newSessionId);
          setActiveItermSessionId(newSessionId);
          process.stderr.write(`[whazaa-watch] Active session switched to ${newSessionId}\n`);
        }
        return;
      }
      process.stderr.write("[whazaa-watch] /relocate: no path provided\n");
      return;
    }

    // --- /sessions (aliases: /s) — list sessions ------------------------------
    if (trimmedText === "/sessions" || trimmedText === "/s") {
      // Clean up stale registry entries by cross-referencing live iTerm2 sessions
      const allSessions = getSessionList();
      const allSessionIds = new Set(allSessions.map((s) => s.id));
      for (const [sid, entry] of sessionRegistry) {
        if (entry.itermSessionId && !allSessionIds.has(entry.itermSessionId)) {
          sessionRegistry.delete(sid);
          clientQueues.delete(sid);
          if (activeClientId === sid) {
            const remaining = [...sessionRegistry.values()].sort((a, b) => b.registeredAt - a.registeredAt);
            setActiveClientId(remaining.length > 0 ? remaining[0].sessionId : null);
          }
        }
      }

      if (allSessions.length === 0 && sessionRegistry.size === 0) {
        watcherSendMessage("No sessions found.").catch(() => {});
        return;
      }

      // If no active session tracked yet, auto-discover from live Claude sessions
      if (!activeItermSessionId && allSessions.length > 0) {
        const firstClaude = allSessions.find((s) => s.type === "claude" && isClaudeRunningInSession(s.id));
        if (firstClaude) {
          setActiveSessionId(firstClaude.id);
          setActiveItermSessionId(firstClaude.id);
        }
      }

      // Cache the session list so /N uses the exact same ordering
      setCachedSessionList(allSessions, Date.now());

      // Build display list: prefer user.paiName session variable, then registry,
      // then cwd basename, then iTerm2 session name.
      const lines = allSessions.map((s, i) => {
        // Find registry entry by matching iTerm2 session ID
        const regEntry = [...sessionRegistry.values()].find(
          (e) => e.itermSessionId === s.id
        );
        // Read the persistent session variable set by setItermSessionVar
        const paiName = getItermSessionVar(s.id);
        const label = paiName
          ?? (regEntry ? regEntry.name : null)
          ?? (s.path ? basename(s.path) : null)
          ?? s.name;
        const typeTag = s.type === "terminal" ? " [terminal]" : "";
        // activeItermSessionId is the single source of truth — always set by
        // /N switch, message delivery, and auto-discovery.  Only fall back to
        // activeClientId (registry-based) when no explicit session has been chosen yet.
        const isActive = activeItermSessionId
          ? s.id === activeItermSessionId
          : regEntry ? activeClientId === regEntry.sessionId : false;
        return `${i + 1}. ${label}${typeTag}${isActive ? " \u2190 active" : ""}`;
      });
      const reply = lines.join("\n");
      watcherSendMessage(reply).catch(() => {});
      return;
    }

    // --- /N [name] — switch to session N, optionally rename it (/1, /2 Whazaa TTS) ---
    const sessionSwitchMatch = trimmedText.match(/^\/(\d+)\s*(.*)?$/);
    if (sessionSwitchMatch) {
      const num = parseInt(sessionSwitchMatch[1], 10);
      const newName = sessionSwitchMatch[2]?.trim() || null;
      // Use the cached list from the last /s call (valid for 60s) so the
      // session numbers match what was displayed. Fall back to a fresh call.
      const CACHE_TTL_MS = 60_000;
      const sessions =
        cachedSessionList && (Date.now() - cachedSessionListTime < CACHE_TTL_MS)
          ? cachedSessionList
          : getSessionList();
      if (sessions.length === 0) {
        watcherSendMessage("No sessions found.").catch(() => {});
        return;
      }
      if (num < 1 || num > sessions.length) {
        watcherSendMessage(`Invalid session number. Use /s to list (1-${sessions.length}).`).catch(() => {});
        return;
      }
      const chosen = sessions[num - 1];
      const escapedSessionId = chosen.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const focusScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${escapedSessionId}" then
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
        setActiveSessionId(chosen.id);
        setActiveItermSessionId(chosen.id);

        // Also update activeClientId to the registered session for this iTerm2 session
        const regEntry = [...sessionRegistry.values()].find(
          (e) => e.itermSessionId === chosen.id
        );
        if (regEntry) {
          setActiveClientId(regEntry.sessionId);
          process.stderr.write(`[whazaa-watch] /sessions: activeClientId -> ${regEntry.sessionId} ("${regEntry.name}")\n`);
        } else {
          // Clear stale activeClientId so it doesn't conflict with activeItermSessionId
          setActiveClientId(null);
          process.stderr.write(`[whazaa-watch] /sessions: activeClientId cleared (no registry entry for ${chosen.id})\n`);
        }

        // If a new name was provided, persist it as a session variable and update registry
        if (newName) {
          setItermSessionVar(chosen.id, newName);
          setItermTabName(chosen.id, newName);
          if (regEntry) {
            regEntry.name = newName;
          }
          process.stderr.write(`[whazaa-watch] /sessions: renamed session ${chosen.id} to "${newName}"\n`);
        }

        const displayName = newName
          ?? getItermSessionVar(chosen.id)
          ?? (regEntry ? regEntry.name : null)
          ?? (chosen.path ? basename(chosen.path) : chosen.name);
        process.stderr.write(`[whazaa-watch] /sessions: switched to iTerm2 session ${chosen.id} (${displayName})\n`);
        watcherSendMessage(`Switched to *${displayName}*`).catch(() => {});
      } else {
        watcherSendMessage("Session not found — it may have closed.").catch(() => {});
      }
      return;
    }

    // --- /t [command] (alias: /terminal) — open a raw terminal tab in iTerm2 --
    if (trimmedText === "/t" || trimmedText === "/terminal") {
      handleTerminal(null);
      return;
    }
    const terminalMatch = trimmedText.match(/^\/(?:t|terminal)\s+(.+)$/);
    if (terminalMatch) {
      handleTerminal(terminalMatch[1].trim());
      return;
    }

    // --- /ss, /screenshot — capture and send iTerm2 window screenshot ---------
    if (trimmedText === "/ss" || trimmedText === "/screenshot") {
      handleScreenshot().catch((err) => {
        process.stderr.write(`[whazaa-watch] /ss: unhandled error — ${err}\n`);
      });
      return;
    }

    // =========================================================================
    // Keyboard control commands — send keystrokes to the active iTerm2 session
    // =========================================================================
    // These commands do NOT forward text to Claude; they inject raw keystrokes
    // directly into the active session so the user can control interactive TUIs,
    // navigate menus, cancel operations, etc. from WhatsApp.
    //
    //   /cc     — Ctrl+C  (interrupt)
    //   /esc    — Escape
    //   /enter  — Enter / Return
    //   /tab    — Tab (completion)
    //   /up     — Up arrow
    //   /down   — Down arrow
    //   /left   — Left arrow
    //   /right  — Right arrow
    //   /pick N — Navigate down (N-1) times then press Enter (menu selection)
    // =========================================================================

    if (
      trimmedText === "/cc" ||
      trimmedText === "/esc" ||
      trimmedText === "/enter" ||
      trimmedText === "/tab" ||
      trimmedText === "/up" ||
      trimmedText === "/down" ||
      trimmedText === "/left" ||
      trimmedText === "/right" ||
      /^\/pick\s+(\d+)$/.test(trimmedText)
    ) {
      if (!activeItermSessionId) {
        watcherSendMessage("No active session. Use /s to list and /N to select.").catch(() => {});
        return;
      }

      if (trimmedText === "/cc") {
        sendKeystrokeToSession(activeItermSessionId, 3);
        watcherSendMessage("Ctrl+C sent").catch(() => {});
        return;
      }

      if (trimmedText === "/esc") {
        sendKeystrokeToSession(activeItermSessionId, 27);
        watcherSendMessage("Esc sent").catch(() => {});
        return;
      }

      if (trimmedText === "/enter") {
        sendKeystrokeToSession(activeItermSessionId, 13);
        watcherSendMessage("Enter sent").catch(() => {});
        return;
      }

      if (trimmedText === "/tab") {
        sendKeystrokeToSession(activeItermSessionId, 9);
        watcherSendMessage("Tab sent").catch(() => {});
        return;
      }

      if (trimmedText === "/up") {
        sendEscapeSequenceToSession(activeItermSessionId, "A");
        watcherSendMessage("\u2191").catch(() => {});
        return;
      }

      if (trimmedText === "/down") {
        sendEscapeSequenceToSession(activeItermSessionId, "B");
        watcherSendMessage("\u2193").catch(() => {});
        return;
      }

      if (trimmedText === "/left") {
        sendEscapeSequenceToSession(activeItermSessionId, "D");
        watcherSendMessage("\u2190").catch(() => {});
        return;
      }

      if (trimmedText === "/right") {
        sendEscapeSequenceToSession(activeItermSessionId, "C");
        watcherSendMessage("\u2192").catch(() => {});
        return;
      }

      const pickMatch = trimmedText.match(/^\/pick\s+(\d+)(?:\s+(.+))?$/);
      if (pickMatch) {
        const pickNum = parseInt(pickMatch[1], 10);
        const pickText = pickMatch[2] || null;
        if (pickNum < 1) {
          watcherSendMessage("Pick number must be at least 1.").catch(() => {});
          return;
        }
        // Send down arrow (N-1) times from current position, then Enter
        const sessionId = activeItermSessionId;
        (async () => {
          for (let i = 0; i < pickNum - 1; i++) {
            sendEscapeSequenceToSession(sessionId, "B");
            await new Promise((r) => setTimeout(r, 50));
          }
          sendKeystrokeToSession(sessionId, 13);

          if (pickText) {
            // Wait briefly for input field to appear
            await new Promise((r) => setTimeout(r, 200));
            typeIntoSession(sessionId, pickText);
          }

          const msgText = pickText ? `Picked option ${pickNum}: ${pickText}` : `Picked option ${pickNum}`;
          watcherSendMessage(msgText).catch(() => {});
        })().catch((err) => {
          process.stderr.write(`[whazaa-watch] /pick: error — ${err}\n`);
        });
        return;
      }
    }

    // --- /kill N (alias: /k N) — kill a stuck session (Claude or terminal) --
    const killMatch = trimmedText.match(/^\/(?:kill|k)\s+(\d+)$/);
    if (killMatch) {
      const num = parseInt(killMatch[1], 10);
      const sessions = getSessionList();
      if (sessions.length === 0) {
        watcherSendMessage("No sessions found.").catch(() => {});
        return;
      }
      if (num < 1 || num > sessions.length) {
        watcherSendMessage(`Invalid session number. Use /s to list (1-${sessions.length}).`).catch(() => {});
        return;
      }
      const target = sessions[num - 1];
      if (target.type === "terminal") {
        handleKillTerminalSession(target).catch((err) => {
          process.stderr.write(`[whazaa-watch] /kill: unhandled error — ${err}\n`);
        });
      } else {
        handleKillSession(target).catch((err) => {
          process.stderr.write(`[whazaa-watch] /kill: unhandled error — ${err}\n`);
        });
      }
      return;
    }

    // Dispatch to IPC clients (additive — does not replace iTerm2 delivery)
    dispatchIncomingMessage(text, timestamp);

    // Deliver to iTerm2 (always)
    const delivered = deliverMessage(text);

    // Show typing indicator so the user sees Claude is processing.
    // Only start if delivery succeeded — no point indicating if nothing was typed.
    if (delivered && watcherStatus.selfJid) {
      startTypingIndicator(watcherStatus.selfJid);
    }
  };
}
