/**
 * watcher/ws-gateway.ts — WebSocket gateway for PAILot app connections.
 *
 * Runs alongside the IPC server. When the PAILot iOS app connects via
 * WebSocket, incoming messages are routed through the same handleMessage()
 * path as WhatsApp self-chat messages. Outbound messages from Claude
 * (via whatsapp_send / whatsapp_tts) are broadcast to all connected clients.
 *
 * The gateway also supports structured commands (sessions, screenshot,
 * navigation keys) so the app can interact with the watcher without
 * going through text-based slash commands.
 */

import { WebSocketServer, WebSocket } from "ws";
import { basename, join } from "node:path";
import { writeFileSync, readFileSync, existsSync, unlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";

const DEBUG_LOG = "/tmp/whazaa-ws-debug.log";
function dbg(msg: string): void {
  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
}
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { log } from "./log.js";
import { WHISPER_BIN, WHISPER_MODEL } from "./media.js";
import {
  setMessageSource,
  activeClientId,
  activeItermSessionId,
  setActiveItermSessionId,
  setActiveClientId,
  sessionRegistry,
  cachedSessionList,
  setCachedSessionList,
} from "./state.js";
import { getSessionList, setItermSessionVar, setItermTabName } from "./iterm-sessions.js";
import { runAppleScript, sendKeystrokeToSession, sendEscapeSequenceToSession } from "./iterm-core.js";

const WS_PORT = parseInt(process.env.PAILOT_PORT ?? "8765", 10);

/** Session data sent to PAILot app */
interface WsSession {
  index: number;
  name: string;
  type: "claude" | "terminal";
  isActive: boolean;
  id: string;
}

// --- State ---

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

// Reference to the screenshot handler — set via setScreenshotHandler()
// to avoid circular imports (screenshot.ts imports from state.ts which
// would create a cycle if we imported it here directly).
let screenshotHandler: (() => Promise<void>) | null = null;

/**
 * Provide the screenshot handler so ws-gateway can trigger screenshots
 * for navigation commands without a circular import.
 */
export function setScreenshotHandler(handler: () => Promise<void>): void {
  screenshotHandler = handler;
}

// --- Structured command handling ---

function handleSessionsCommand(ws: WebSocket): void {
  const allSessions = getSessionList();
  setCachedSessionList(allSessions, Date.now());

  const sessions: WsSession[] = allSessions.map((s, i) => {
    const regEntry = [...sessionRegistry.values()].find(
      (e) => e.itermSessionId === s.id
    );
    const label = s.paiName
      ?? (regEntry ? regEntry.name : null)
      ?? (s.path ? basename(s.path) : null)
      ?? s.name;
    const isActive = activeItermSessionId
      ? s.id === activeItermSessionId
      : regEntry ? activeClientId === regEntry.sessionId : false;

    return { index: i + 1, name: label, type: s.type, isActive, id: s.id };
  });

  const payload = JSON.stringify({ type: "sessions", sessions });
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
  }
}

function handleSwitchCommand(ws: WebSocket, args: Record<string, unknown>): void {
  const sessionId = args.sessionId as string | undefined;
  const newName = args.name as string | undefined;

  if (!sessionId) {
    sendTo(ws, { type: "error", message: "Missing sessionId" });
    return;
  }

  const escapedSessionId = sessionId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

  const result = runAppleScript(focusScript);
  if (result === "focused") {
    setActiveItermSessionId(sessionId);

    const regEntry = [...sessionRegistry.values()].find(
      (e) => e.itermSessionId === sessionId
    );
    if (regEntry) {
      setActiveClientId(regEntry.sessionId);
    } else {
      setActiveClientId(null);
    }

    if (newName) {
      setItermSessionVar(sessionId, newName);
      setItermTabName(sessionId, newName);
      if (regEntry) regEntry.name = newName;
    }

    const displayName = newName
      ?? regEntry?.name
      ?? sessionId.slice(0, 8);

    sendTo(ws, { type: "session_switched", name: displayName, sessionId });
    log(`[PAILot] switched to session ${sessionId} (${displayName})`);
  } else {
    sendTo(ws, { type: "error", message: "Session not found — it may have closed." });
  }
}

function handleRenameCommand(ws: WebSocket, args: Record<string, unknown>): void {
  const sessionId = args.sessionId as string | undefined;
  const name = args.name as string | undefined;

  if (!sessionId || !name) {
    sendTo(ws, { type: "error", message: "Missing sessionId or name" });
    return;
  }

  setItermSessionVar(sessionId, name);
  setItermTabName(sessionId, name);
  const regEntry = [...sessionRegistry.values()].find(
    (e) => e.itermSessionId === sessionId
  );
  if (regEntry) regEntry.name = name;

  sendTo(ws, { type: "session_renamed", sessionId, name });
  log(`[PAILot] renamed session ${sessionId} to "${name}"`);
}

async function handleNavCommand(ws: WebSocket, args: Record<string, unknown>): Promise<void> {
  const key = args.key as string | undefined;
  if (!key) return;

  const targetSession = activeItermSessionId;
  if (!targetSession) {
    sendTo(ws, { type: "error", message: "No active session" });
    return;
  }

  // Map key names to actions
  // sendKeystrokeToSession takes ASCII code: 13=enter, 9=tab, 27=escape
  // sendEscapeSequenceToSession takes ANSI direction char: A=up, B=down, C=right, D=left
  const keyMap: Record<string, () => void> = {
    up: () => sendEscapeSequenceToSession(targetSession, "A"),
    down: () => sendEscapeSequenceToSession(targetSession, "B"),
    left: () => sendEscapeSequenceToSession(targetSession, "D"),
    right: () => sendEscapeSequenceToSession(targetSession, "C"),
    enter: () => sendKeystrokeToSession(targetSession, 13),
    tab: () => sendKeystrokeToSession(targetSession, 9),
    escape: () => sendKeystrokeToSession(targetSession, 27),
    "ctrl-c": () => {
      // Send Ctrl+C (ETX, ASCII 3)
      runAppleScript(`tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${targetSession}" then
          tell s to write text (ASCII character 3)
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`);
    },
  };

  const action = keyMap[key];
  if (!action) {
    sendTo(ws, { type: "error", message: `Unknown key: ${key}` });
    return;
  }

  action();
  log(`[PAILot] nav: sent ${key} to session ${targetSession.slice(0, 8)}...`);

  // Auto-screenshot after navigation key with a brief delay for render
  if (screenshotHandler) {
    await new Promise((r) => setTimeout(r, 600));
    await triggerScreenshotForPailot();
  }
}

async function triggerScreenshotForPailot(): Promise<void> {
  if (!screenshotHandler) return;
  // screenshotHandler captures and sends to WhatsApp.
  // broadcastImage is called from screenshot.ts after capture.
  await screenshotHandler();
}

// --- Helpers ---

function sendTo(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg: Record<string, unknown>): void {
  if (clients.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// --- Voice transcription for PAILot ---

const execFileAsync = promisify(execFile);

async function transcribeAndRoute(
  audioBase64: string,
  onMessage: (text: string, timestamp: number) => void | Promise<void>
): Promise<void> {
  const base = `pailot-voice-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const audioFile = join(tmpdir(), `${base}.m4a`);
  const filesToClean = [
    audioFile,
    join(tmpdir(), `${base}.txt`),
    join(tmpdir(), `${base}.json`),
    join(tmpdir(), `${base}.vtt`),
    join(tmpdir(), `${base}.srt`),
    join(tmpdir(), `${base}.tsv`),
  ];

  try {
    dbg(`transcribeAndRoute: base64 length=${audioBase64.length}`);
    const buffer = Buffer.from(audioBase64, "base64");
    writeFileSync(audioFile, buffer);
    dbg(`Audio saved: ${audioFile} (${buffer.length} bytes)`);
    log(`[PAILot] Voice note saved (${buffer.length} bytes), running Whisper...`);

    await execFileAsync(
      WHISPER_BIN,
      [audioFile, "--model", WHISPER_MODEL, "--output_format", "txt", "--output_dir", tmpdir(), "--verbose", "False"],
      {
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        },
      }
    );

    const txtPath = join(tmpdir(), `${base}.txt`);
    if (!existsSync(txtPath)) {
      log(`[PAILot] Whisper did not produce output`);
      return;
    }

    const transcript = readFileSync(txtPath, "utf-8").trim();
    if (!transcript) {
      log(`[PAILot] Empty transcript`);
      return;
    }

    log(`[PAILot] Transcription: ${transcript.slice(0, 80)}${transcript.length > 80 ? "..." : ""}`);

    setMessageSource("pailot");
    onMessage(`[PAILot:voice] ${transcript}`, Date.now());
    setMessageSource("whatsapp");
  } catch (err) {
    log(`[PAILot] Whisper transcription failed: ${err}`);
  } finally {
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

// --- Public API ---

/**
 * Start the WebSocket gateway.
 * @param onMessage — the same handleMessage(text, timestamp) used for WhatsApp
 */
export function startWsGateway(onMessage: (text: string, timestamp: number) => void | Promise<void>): void {
  wss = new WebSocketServer({ port: WS_PORT });

  wss.on("listening", () => {
    log(`WebSocket gateway listening on ws://0.0.0.0:${WS_PORT}`);
  });

  wss.on("connection", (ws, req) => {
    const addr = req.socket.remoteAddress ?? "unknown";
    log(`PAILot client connected from ${addr}`);
    clients.add(ws);

    ws.on("message", (raw) => {
      try {
        const rawStr = raw.toString();
        dbg(`RAW msg (${rawStr.length} chars): type=${JSON.parse(rawStr).type}, hasAudio=${!!JSON.parse(rawStr).audioBase64}, content=${(JSON.parse(rawStr).content ?? "").slice(0, 50)}`);
        const msg = JSON.parse(rawStr);

        // Structured commands from PAILot app
        if (msg.type === "command") {
          const command = msg.command as string;
          const args = (msg.args ?? {}) as Record<string, unknown>;
          log(`[PAILot] ← command: ${command}`);

          switch (command) {
            case "sessions":
              handleSessionsCommand(ws);
              return;
            case "switch":
              handleSwitchCommand(ws, args);
              return;
            case "rename":
              handleRenameCommand(ws, args);
              return;
            case "screenshot":
              triggerScreenshotForPailot().catch((err) => {
                log(`[PAILot] screenshot error: ${err}`);
              });
              return;
            case "nav":
              handleNavCommand(ws, args).catch((err) => {
                log(`[PAILot] nav error: ${err}`);
              });
              return;
            default:
              break;
          }
        }

        // Voice message — transcribe with Whisper then route
        if (msg.type === "voice" && msg.audioBase64) {
          dbg(`Voice message received, audioBase64 length: ${(msg.audioBase64 as string).length}`);
          transcribeAndRoute(msg.audioBase64 as string, onMessage).catch((err) => {
            log(`[PAILot] voice transcription error: ${err}`);
          });
          return;
        }

        // Plain text message — route through handleMessage
        const text = msg.content ?? "";
        if (!text.trim()) return;

        log(`[PAILot] ← ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);

        // Set source so commands.ts uses [PAILot] prefix instead of [Whazaa]
        setMessageSource("pailot");
        onMessage(text, Date.now());
        setMessageSource("whatsapp");
      } catch {
        log(`[PAILot] Invalid message from ${addr}`);
      }
    });

    ws.on("close", () => {
      log(`PAILot client disconnected from ${addr}`);
      clients.delete(ws);
    });

    ws.on("error", (err) => {
      log(`[PAILot] WebSocket error: ${err.message}`);
      clients.delete(ws);
    });

    // Welcome
    sendTo(ws, { type: "text", content: "Connected to PAILot gateway." });
  });

  wss.on("error", (err) => {
    log(`WebSocket gateway error: ${err.message}`);
  });
}

/**
 * Broadcast a text message to all connected PAILot clients.
 */
export function broadcastText(text: string): void {
  broadcast({ type: "text", content: text });
}

/**
 * Broadcast a voice note to all connected PAILot clients.
 */
export function broadcastVoice(audioBuffer: Buffer, transcript: string): void {
  broadcast({
    type: "voice",
    content: transcript,
    audioBase64: audioBuffer.toString("base64"),
  });
}

/**
 * Broadcast a screenshot/image to all connected PAILot clients.
 */
export function broadcastImage(imageBuffer: Buffer, caption?: string): void {
  broadcast({
    type: "image",
    imageBase64: imageBuffer.toString("base64"),
    caption: caption ?? "Screenshot",
  });
}

/**
 * Returns true if any PAILot clients are connected.
 */
export function hasPailotClients(): boolean {
  return clients.size > 0;
}

/**
 * Stop the WebSocket gateway.
 */
export function stopWsGateway(): void {
  if (wss) {
    for (const ws of clients) ws.close();
    clients.clear();
    wss.close();
    wss = null;
  }
}
