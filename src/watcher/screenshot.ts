/**
 * screenshot.ts — Screenshot capture and WhatsApp delivery for the `/ss` command.
 *
 * This module implements the two-phase screenshot pipeline:
 *
 * 1. **Screen-lock detection** — Before attempting a capture, the module
 *    checks `ioreg` for the `CGSSessionScreenIsLocked` flag. macOS silently
 *    produces a blank/black image when `screencapture` is called on a locked
 *    display, so the module detects this early and falls back to the text
 *    capture path instead.
 *
 * 2. **Image capture** (`handleScreenshot`) — Resolves which iTerm2 session
 *    and window to capture using a four-level priority chain (registry lookup,
 *    `activeItermSessionId`, registry scan, tab-name scan). It then raises the
 *    target window, waits for iTerm2 to redraw, reads the window bounds, and
 *    calls `screencapture -x -R <bounds>` to capture exactly the iTerm2 window
 *    as a PNG. The image is sent to the user's own WhatsApp JID as a media
 *    message.
 *
 * 3. **Text fallback** (`handleTextScreenshot`) — When the screen is locked,
 *    reads the terminal buffer contents via AppleScript (`contents of session`)
 *    and sends the last ~4 000 characters as a formatted WhatsApp text message.
 *    iTerm2 continues to service AppleScript calls even when the display is
 *    locked because the target is the iTerm2 process, not the display server.
 *
 * Dependencies: iterm-core, iterm-sessions, state, send
 */

import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execSync } from "node:child_process";

import { runAppleScript, stripItermPrefix } from "./iterm-core.js";
import { log } from "./log.js";
import {
  activeClientId,
  activeItermSessionId,
  setActiveItermSessionId,
  sessionRegistry,
  watcherSock,
  watcherStatus,
  sentMessageIds,
} from "./state.js";
import { watcherSendMessage } from "./send.js";
import { listClaudeSessions } from "./iterm-sessions.js";

/**
 * Locked-screen fallback for the `/ss` command.
 *
 * When `screencapture` would produce a blank image (the display is locked),
 * this function reads the visible terminal buffer of the target iTerm2 session
 * via AppleScript's `contents of session` property and sends it as a
 * triple-backtick code block in WhatsApp.
 *
 * Session resolution uses the same priority chain as `handleScreenshot`:
 * 1. Registry entry for `activeClientId`.
 * 2. Module-level `activeItermSessionId`.
 * 3. Most-recently-registered session in `sessionRegistry` that has an
 *    `itermSessionId`.
 *
 * The buffer is trimmed to the last 4 000 characters before sending to stay
 * within WhatsApp's message size limits; a leading `"...\n"` is prepended when
 * the content is truncated.
 *
 * @returns A promise that resolves when the text message has been sent (or
 *   when an error message has been sent instead). Never rejects — all errors
 *   are caught and reported via WhatsApp.
 */
export async function handleTextScreenshot(): Promise<void> {
  try {
    // Build a list of candidate iTerm2 session UUIDs to try (best-first order).
    // If the first one is stale (tab closed, process killed), we try the rest.
    const candidates: Array<{ id: string; source: string }> = [];

    const activeEntry = activeClientId ? sessionRegistry.get(activeClientId) : undefined;
    const primaryId = stripItermPrefix(
      (activeItermSessionId || undefined) ?? activeEntry?.itermSessionId
    );
    if (primaryId) {
      candidates.push({ id: primaryId, source: "active" });
    }

    // Add all registry sessions as fallbacks (sorted newest-first)
    const registryEntries = [...sessionRegistry.values()]
      .sort((a, b) => b.registeredAt - a.registeredAt);
    for (const entry of registryEntries) {
      const rid = stripItermPrefix(entry.itermSessionId);
      if (rid && !candidates.some((c) => c.id === rid)) {
        candidates.push({ id: rid, source: `registry:${entry.name}` });
      }
    }

    if (candidates.length === 0) {
      await watcherSendMessage(
        "Screen is locked and no iTerm2 session found — cannot capture."
      ).catch(() => {});
      return;
    }

    log(`/ss text: ${candidates.length} candidate(s): ${candidates.map((c) => `${c.id.slice(0, 8)}… (${c.source})`).join(", ")}`);

    // Try each candidate until one returns buffer content.
    // Use a longer timeout (10s) — macOS deprioritises iTerm2 when the screen
    // is locked, so AppleScript calls can be slow.
    for (const candidate of candidates) {
      const script = `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${candidate.id}" then
          return contents of s
        end if
      end repeat
    end repeat
  end repeat
  return "::NOT_FOUND::"
end tell`;

      const result = spawnSync("osascript", [], {
        input: script,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });

      const exitCode = result.status;
      const stdout = result.stdout?.toString().trim() ?? "";
      const stderr = result.stderr?.toString().trim() ?? "";
      const timedOut = result.signal === "SIGTERM";

      if (timedOut) {
        log(`/ss text: ${candidate.source} (${candidate.id.slice(0, 8)}…) — timed out after 10s`);
        continue;
      }

      if (exitCode !== 0) {
        log(`/ss text: ${candidate.source} (${candidate.id.slice(0, 8)}…) — AppleScript error (exit ${exitCode}): ${stderr}`);
        continue;
      }

      if (stdout === "::NOT_FOUND::") {
        log(`/ss text: ${candidate.source} (${candidate.id.slice(0, 8)}…) — session not found in iTerm2`);
        continue;
      }

      if (stdout === "") {
        log(`/ss text: ${candidate.source} (${candidate.id.slice(0, 8)}…) — buffer empty`);
        continue;
      }

      // Got content — send it
      const maxLen = 4000;
      const trimmed =
        stdout.length > maxLen
          ? "...\n" + stdout.slice(-maxLen)
          : stdout;

      await watcherSendMessage(
        `*Terminal capture (screen locked):*\n\n\`\`\`\n${trimmed}\n\`\`\``
      ).catch(() => {});

      log(`/ss: text capture sent via ${candidate.source} (${candidate.id.slice(0, 8)}…)`);
      return;
    }

    // All candidates exhausted — report what happened
    const summary = candidates.map((c) => `${c.source}`).join(", ");
    log(`/ss text: all ${candidates.length} candidate(s) failed: ${summary}`);
    await watcherSendMessage(
      `Screen is locked — tried ${candidates.length} session(s) but none returned buffer content. Check watcher logs.`
    ).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`/ss: text capture error — ${msg}`);
    await watcherSendMessage(
      `Screen is locked — text capture failed: ${msg}`
    ).catch(() => {});
  }
}

/**
 * Handle the `/ss` (screenshot) WhatsApp command.
 *
 * Captures the iTerm2 window that contains the target Claude session and sends
 * it back to the user's own WhatsApp number as a PNG image with the caption
 * "Screenshot".
 *
 * Full flow:
 * 1. Send an immediate "Capturing screenshot..." ack so the user knows the
 *    command was received.
 * 2. Check `ioreg` for `CGSSessionScreenIsLocked`. If the screen is locked,
 *    delegate to `handleTextScreenshot` and return early.
 * 3. Resolve the target iTerm2 session using a four-level priority chain:
 *    a. Registry entry for `activeClientId` (most precise).
 *    b. Module-level `activeItermSessionId` (set by `/N` switches and message
 *       delivery).
 *    c. Most-recently-registered session in `sessionRegistry` that has an
 *       `itermSessionId` (registry scan fallback).
 *    d. First session returned by `listClaudeSessions` (tab-name scan;
 *       backwards-compat cold-start fallback).
 * 4. Two-phase AppleScript window raise:
 *    - Phase 1: Select the session's tab, raise the window to index 1,
 *      activate iTerm2, and return the numeric window ID.
 *    - Phase 2: After a 1 500 ms render delay, re-read the window bounds by
 *      ID so they reflect any resize caused by the tab switch.
 * 5. Call `screencapture -x -R <x,y,w,h>` to capture the exact window region.
 * 6. Read the PNG file and send it via `watcherSock.sendMessage` to
 *    `watcherStatus.selfJid`.
 * 7. Track the outgoing message ID in `sentMessageIds` (auto-expires in 30 s)
 *    so the watcher does not echo its own screenshot back to itself.
 * 8. Delete the temporary PNG file in the `finally` block regardless of
 *    success or failure.
 *
 * @returns A promise that resolves when the screenshot has been sent or when
 *   an error message has been sent instead. Never rejects — all errors are
 *   caught and reported to the user via WhatsApp.
 */
export async function handleScreenshot(): Promise<void> {
  // Ack immediately so the user knows we're working on it
  await watcherSendMessage("Capturing screenshot...").catch(() => {});

  // Check if the screen is locked — screencapture silently fails when locked.
  try {
    const lockCheck = spawnSync(
      "sh",
      ["-c", "ioreg -n Root -d1 -a | grep -c CGSSessionScreenIsLocked"],
      { timeout: 5_000, encoding: "utf8" }
    );
    const lockCount = parseInt((lockCheck.stdout ?? "0").trim(), 10);
    if (lockCount > 0) {
      log("/ss: screen is locked — falling back to terminal text capture");
      await handleTextScreenshot();
      return;
    }
  } catch {
    // If the check itself fails, proceed and let screencapture surface any error.
  }

  const filePath = join(tmpdir(), `whazaa-screenshot-${Date.now()}.png`);

  try {
    // Resolve the window ID to capture.
    // Priority:
    //   1. Registry entry for activeClientId (most precise — set when MCP client registered)
    //   2. activeItermSessionId (set by /N switch commands — always up-to-date)
    //   3. Auto-discover from live Claude sessions (handles cold start / post-restart)
    //   4. Fall back to window 1 (last resort)
    let windowId: string;
    try {
      const activeEntry = activeClientId ? sessionRegistry.get(activeClientId) : undefined;
      // Prefer activeItermSessionId (explicitly set by /N switch, message delivery,
      // auto-discovery) over registry lookup — it's always the most up-to-date.
      // Strip any "w0t2p0:"-style prefix so the bare UUID is used in AppleScript comparisons.
      let itermSessionId = stripItermPrefix((activeItermSessionId || undefined) ?? activeEntry?.itermSessionId);

      // Priority 3: Registry scan — find the most-recently-registered session that
      // has an iTerm2 UUID. Avoids tab-name matching (which breaks on renamed tabs).
      if (!itermSessionId) {
        const registryEntries = [...sessionRegistry.values()]
          .sort((a, b) => b.registeredAt - a.registeredAt);
        const newest = registryEntries.find(e => e.itermSessionId);
        if (newest?.itermSessionId) {
          itermSessionId = stripItermPrefix(newest.itermSessionId);
          setActiveItermSessionId(itermSessionId!);
          log(`/ss: registry fallback to session ${newest.sessionId} (${newest.name}), iTerm ${itermSessionId}`);
        }
      }

      // Priority 4: Auto-discover from live Claude tab names (backwards-compat fallback
      // for cold starts where no sessions have registered yet).
      if (!itermSessionId) {
        const liveSessions = listClaudeSessions();
        if (liveSessions.length > 0) {
          itermSessionId = liveSessions[0].id;
          setActiveItermSessionId(liveSessions[0].id);
          log(`/ss: tab-name fallback — discovered session ${liveSessions[0].id} (${liveSessions[0].name})`);
        }
      }

      if (itermSessionId) {
        // Two-phase AppleScript approach for reliable multi-tab screenshots:
        //
        // Phase 1: Find the session, switch to its tab using the correct
        //   iTerm2 API (set current tab of w to t), raise the window, and
        //   activate iTerm2. Return only the window ID so we don't capture
        //   bounds before the tab has actually switched and re-rendered.
        //
        // Phase 2: After a render-wait delay, re-read the window bounds by
        //   its ID. This ensures the bounds reflect the correct tab's layout
        //   (which may differ in height if tabs have different terminal sizes).
        const findAndRaiseScript = `tell application "iTerm2"
  repeat with w in windows
    set tabCount to count of tabs of w
    repeat with tabIdx from 1 to tabCount
      set t to tab tabIdx of w
      repeat with s in sessions of t
        if id of s is "${itermSessionId}" then
          -- Switch to the correct tab. "select t" on a tab reference works
          -- reliably. "set current tab of w to t" throws -10000 errors.
          select t
          -- Raise THIS window to the top of all iTerm2 windows
          set index of w to 1
          -- Bring iTerm2 to the foreground of all applications
          activate
          -- Return only the window ID; bounds are read after the render delay
          -- so they reflect the actual tab layout, not a pre-switch state.
          return (id of w as text)
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;
        const findResult = runAppleScript(findAndRaiseScript);
        if (findResult && findResult !== "") {
          windowId = findResult.trim();
          log(`/ss: found session ${itermSessionId} in window ${windowId}, tab switched and activated`);
        } else {
          // Session not found — fall back to frontmost window
          runAppleScript('tell application "iTerm2" to activate');
          const fallbackScript = `tell application "iTerm2"
  set w to window 1
  activate
  return (id of w as text)
end tell`;
          const fallbackResult = runAppleScript(fallbackScript) ?? "";
          windowId = fallbackResult.trim();
          log(`/ss: session ${itermSessionId} not found, falling back to window 1 (id=${windowId})`);
        }
      } else {
        // Truly no Claude sessions — activate iTerm2 and use frontmost window
        runAppleScript('tell application "iTerm2" to activate');
        const fallbackScript = `tell application "iTerm2"
  set w to window 1
  activate
  return (id of w as text)
end tell`;
        const fallbackResult = runAppleScript(fallbackScript) ?? "";
        windowId = fallbackResult.trim();
        log(`/ss: no Claude sessions found, falling back to window 1 (id=${windowId})`);
      }
    } catch {
      await watcherSendMessage("Error: iTerm2 is not running or has no open windows.").catch(() => {});
      return;
    }

    if (!windowId) {
      await watcherSendMessage("Error: Could not get iTerm2 window ID.").catch(() => {});
      return;
    }

    // Wait for iTerm2 to fully redraw after being raised and the tab switched.
    // When iTerm2 was in the background, macOS throttles rendering and the
    // window server holds a stale buffer. We also need time for the tab switch
    // to complete — if the new tab has a different terminal size, the window
    // will resize during this delay.
    await new Promise((r) => setTimeout(r, 1500));

    // Re-read the window bounds AFTER the delay so they reflect the current
    // tab's layout (the tab may have caused the window to resize).
    // We look up the window by ID to avoid targeting the wrong window if
    // another window became frontmost during the wait.
    const boundsScript = `tell application "iTerm2"
  repeat with w in windows
    if (id of w as text) is "${windowId}" then
      set wBounds to bounds of w
      set wx to item 1 of wBounds
      set wy to item 2 of wBounds
      set wx2 to item 3 of wBounds
      set wy2 to item 4 of wBounds
      return (wx as text) & "," & (wy as text) & "," & ((wx2 - wx) as text) & "," & ((wy2 - wy) as text)
    end if
  end repeat
  return ""
end tell`;
    const boundsResult = runAppleScript(boundsScript) ?? "";
    const bounds = boundsResult.trim();
    if (!bounds || !bounds.includes(",")) {
      throw new Error("Could not get window bounds from iTerm2");
    }
    log(`/ss: capturing screen region ${bounds} (iTerm2 window ${windowId})`);
    execSync(`screencapture -x -R ${bounds} "${filePath}"`, { timeout: 15_000 });

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

    log("/ss: screenshot sent successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`/ss: error — ${msg}`);
    await watcherSendMessage(`Error taking screenshot: ${msg}`).catch(() => {});
  } finally {
    try {
      unlinkSync(filePath);
    } catch {
      // File may not exist if capture failed before writing — ignore
    }
  }
}
