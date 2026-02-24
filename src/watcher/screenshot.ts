/**
 * @file screenshot.ts
 * @module watcher/screenshot
 *
 * Screenshot capture and WhatsApp delivery for the `/ss` command.
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

import { runAppleScript } from "./iterm-core.js";
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
    // Resolve the target iTerm2 session UUID (same priority chain as handleScreenshot)
    const stripItermPrefix = (id: string | undefined): string | undefined => {
      if (!id) return id;
      const colonIdx = id.lastIndexOf(":");
      return colonIdx >= 0 ? id.slice(colonIdx + 1) : id;
    };

    const activeEntry = activeClientId ? sessionRegistry.get(activeClientId) : undefined;
    let itermSessionId = stripItermPrefix(
      (activeItermSessionId || undefined) ?? activeEntry?.itermSessionId
    );

    if (!itermSessionId) {
      const registryEntries = [...sessionRegistry.values()]
        .sort((a, b) => b.registeredAt - a.registeredAt);
      const newest = registryEntries.find((e) => e.itermSessionId);
      if (newest?.itermSessionId) {
        itermSessionId = stripItermPrefix(newest.itermSessionId);
      }
    }

    if (!itermSessionId) {
      await watcherSendMessage(
        "Screen is locked and no iTerm2 session found — cannot capture."
      ).catch(() => {});
      return;
    }

    // Get the terminal buffer contents via AppleScript
    const script = `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${itermSessionId}" then
          return contents of s
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;

    const contents = runAppleScript(script);
    if (!contents || contents.trim() === "") {
      await watcherSendMessage(
        "Screen is locked — could not read terminal buffer (empty)."
      ).catch(() => {});
      return;
    }

    // Trim to last ~4000 chars to stay within WhatsApp message limits
    const maxLen = 4000;
    const trimmed =
      contents.length > maxLen
        ? "...\n" + contents.slice(-maxLen)
        : contents;

    await watcherSendMessage(
      `*Terminal capture (screen locked):*\n\n\`\`\`\n${trimmed}\n\`\`\``
    ).catch(() => {});

    process.stderr.write("[whazaa-watch] /ss: text capture sent (screen locked fallback)\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[whazaa-watch] /ss: text capture error — ${msg}\n`);
    await watcherSendMessage(
      `Screen is locked — text capture also failed: ${msg}`
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
      process.stderr.write("[whazaa-watch] /ss: screen is locked — falling back to terminal text capture\n");
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
      // Prefer registry itermSessionId; fall back to the module-level activeItermSessionId.
      // Strip any "w0t2p0:"-style prefix from ITERM_SESSION_ID so the bare UUID is used
      // in AppleScript comparisons (iTerm2's `id of aSession` returns just the UUID).
      const stripItermPrefix = (id: string | undefined): string | undefined => {
        if (!id) return id;
        const colonIdx = id.lastIndexOf(":");
        return colonIdx >= 0 ? id.slice(colonIdx + 1) : id;
      };
      // Prefer activeItermSessionId (explicitly set by /N switch, message delivery,
      // auto-discovery) over registry lookup — it's always the most up-to-date.
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
          process.stderr.write(`[whazaa-watch] /ss: registry fallback to session ${newest.sessionId} (${newest.name}), iTerm ${itermSessionId}\n`);
        }
      }

      // Priority 4: Auto-discover from live Claude tab names (backwards-compat fallback
      // for cold starts where no sessions have registered yet).
      if (!itermSessionId) {
        const liveSessions = listClaudeSessions();
        if (liveSessions.length > 0) {
          itermSessionId = liveSessions[0].id;
          setActiveItermSessionId(liveSessions[0].id);
          process.stderr.write(`[whazaa-watch] /ss: tab-name fallback — discovered session ${liveSessions[0].id} (${liveSessions[0].name})\n`);
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
          process.stderr.write(`[whazaa-watch] /ss: found session ${itermSessionId} in window ${windowId}, tab switched and activated\n`);
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
          process.stderr.write(`[whazaa-watch] /ss: session ${itermSessionId} not found, falling back to window 1 (id=${windowId})\n`);
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
        process.stderr.write(`[whazaa-watch] /ss: no Claude sessions found, falling back to window 1 (id=${windowId})\n`);
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
    process.stderr.write(`[whazaa-watch] /ss: capturing screen region ${bounds} (iTerm2 window ${windowId})\n`);
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
