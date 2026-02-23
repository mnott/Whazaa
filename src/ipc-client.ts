/**
 * ipc-client.ts — MCP server side of the IPC bridge
 *
 * WatcherClient connects to the Unix Domain Socket served by watch.ts and
 * exposes typed methods that mirror the IPC protocol. The MCP tools call
 * these methods instead of talking to whatsapp.ts directly.
 *
 * If the watcher is not running, every method rejects with a clear error
 * so the MCP tool can return a helpful message to the caller.
 */

import { connect, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

export const IPC_SOCKET_PATH = "/tmp/whazaa-watcher.sock";

interface IpcRequest {
  id: string;
  sessionId: string;
  itermSessionId?: string;
  method: string;
  params: Record<string, unknown>;
}

interface IpcResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Result types (mirrors watcher handler return shapes)
// ---------------------------------------------------------------------------

export interface StatusResult {
  connected: boolean;
  phoneNumber: string | null;
  awaitingQR: boolean;
}

export interface SendResult {
  preview: string;
  targetJid?: string;
}

export interface ReceiveResult {
  messages: Array<{ body: string; timestamp: number }>;
}

export interface WaitResult {
  messages: Array<{ body: string; timestamp: number }>;
}

export interface ContactEntry {
  jid: string;
  name: string | null;
  phoneNumber: string;
  lastSeen: number;
}

export interface ContactsResult {
  contacts: ContactEntry[];
}

export interface LoginResult {
  message: string;
}

export interface RegisterResult {
  registered: boolean;
}

export interface RenameResult {
  success: boolean;
  name?: string;
  error?: string;
}

export interface ChatEntry {
  jid: string;
  name: string;
  lastMessageTimestamp: number;
  unreadCount: number;
}

export interface ChatsResult {
  chats: ChatEntry[];
}

export interface HistoryMessage {
  id: string | null;
  fromMe: boolean;
  timestamp: number;
  date: string;
  text: string;
  type: string;
}

export interface HistoryResult {
  messages: HistoryMessage[];
  count: number;
}

export interface TtsResult {
  targetJid: string;
  voice: string;
  bytesSent: number;
}

export interface VoiceConfigResult {
  success: boolean;
  config?: {
    defaultVoice: string;
    voiceMode: boolean;
    localMode: boolean;
    personas: Record<string, string>;
  };
  error?: string;
}

export interface SpeakResult {
  success: boolean;
  voice?: string;
  error?: string;
}

export interface SendFileResult {
  fileName: string;
  fileSize: number;
  targetJid: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Thin IPC proxy that forwards tool calls to the watcher over a Unix
 * Domain Socket. Each call opens a fresh connection, sends one NDJSON
 * request, reads the response, and closes. This keeps the client stateless
 * and avoids connection management complexity.
 */
export class WatcherClient {
  private readonly sessionId: string;

  constructor() {
    // Use TERM_SESSION_ID set by iTerm2, or fall back to a stable placeholder.
    this.sessionId = process.env.TERM_SESSION_ID ?? "unknown-session";
  }

  /** The iTerm2 session ID this client is associated with */
  get session(): string {
    return this.sessionId;
  }

  /**
   * Human-readable name derived from the current working directory.
   * Used as the default session name when registering.
   */
  private get defaultName(): string {
    const cwd = process.cwd();
    const home = homedir();
    if (cwd === home) return "Home";
    return basename(cwd);
  }

  // -------------------------------------------------------------------------
  // Public tool methods
  // -------------------------------------------------------------------------

  async register(name?: string): Promise<RegisterResult> {
    const params: Record<string, unknown> = {
      name: name ?? this.defaultName,
    };
    // Pass ITERM_SESSION_ID if available so the watcher can skip the AppleScript scan
    const itermSessionId = process.env.ITERM_SESSION_ID;
    if (itermSessionId) {
      params.itermSessionId = itermSessionId;
    }
    const result = await this.call("register", params);
    return result as unknown as RegisterResult;
  }

  async rename(name: string): Promise<RenameResult> {
    const result = await this.call("rename", { name });
    return result as unknown as RenameResult;
  }

  async status(): Promise<StatusResult> {
    const result = await this.call("status", {});
    return result as unknown as StatusResult;
  }

  async send(message: string, recipient?: string): Promise<SendResult> {
    const params: Record<string, unknown> = { message };
    if (recipient !== undefined) params.recipient = recipient;
    const result = await this.call("send", params);
    return result as unknown as SendResult;
  }

  async receive(from?: string): Promise<ReceiveResult> {
    const params: Record<string, unknown> = {};
    if (from !== undefined) params.from = from;
    const result = await this.call("receive", params);
    return result as unknown as ReceiveResult;
  }

  async contacts(search?: string, limit?: number): Promise<ContactsResult> {
    const params: Record<string, unknown> = {};
    if (search !== undefined) params.search = search;
    if (limit !== undefined) params.limit = limit;
    const result = await this.call("contacts", params);
    return result as unknown as ContactsResult;
  }

  async chats(params?: { search?: string; limit?: number }): Promise<ChatsResult> {
    const ipcParams: Record<string, unknown> = {};
    if (params?.search !== undefined) ipcParams.search = params.search;
    if (params?.limit !== undefined) ipcParams.limit = params.limit;
    const result = await this.call("chats", ipcParams);
    return result as unknown as ChatsResult;
  }

  async wait(timeoutMs: number): Promise<WaitResult> {
    const result = await this.call("wait", { timeoutMs });
    return result as unknown as WaitResult;
  }

  async login(): Promise<LoginResult> {
    const result = await this.call("login", {});
    return result as unknown as LoginResult;
  }

  async history(params: { jid: string; count?: number }): Promise<HistoryResult> {
    const ipcParams: Record<string, unknown> = { jid: params.jid };
    if (params.count !== undefined) ipcParams.count = params.count;
    const result = await this.call("history", ipcParams);
    return result as unknown as HistoryResult;
  }

  async tts(params: { text: string; voice?: string; jid?: string }): Promise<TtsResult> {
    const ipcParams: Record<string, unknown> = { text: params.text };
    if (params.voice !== undefined) ipcParams.voice = params.voice;
    if (params.jid !== undefined) ipcParams.jid = params.jid;
    const result = await this.call("tts", ipcParams);
    return result as unknown as TtsResult;
  }

  async voiceConfig(action: "get" | "set", updates?: Record<string, unknown>): Promise<VoiceConfigResult> {
    const params: Record<string, unknown> = { action, ...updates };
    const result = await this.call("voice_config", params);
    return result as unknown as VoiceConfigResult;
  }

  async sendFile(filePath: string, recipient?: string, caption?: string): Promise<SendFileResult> {
    const params: Record<string, unknown> = { filePath };
    if (recipient !== undefined) params.recipient = recipient;
    if (caption !== undefined) params.caption = caption;
    const result = await this.call("send_file", params);
    return result as unknown as SendFileResult;
  }

  async speak(text: string, voice?: string): Promise<SpeakResult> {
    const params: Record<string, unknown> = { text };
    if (voice !== undefined) params.voice = voice;
    const result = await this.call("speak", params);
    return result as unknown as SpeakResult;
  }

  // -------------------------------------------------------------------------
  // Internal transport
  // -------------------------------------------------------------------------

  /**
   * Send a single IPC request and wait for the response.
   * Opens a new socket connection per call — simple and reliable.
   *
   * The per-call timeout is 310 seconds (slightly over the max 'wait' timeout
   * of 300 seconds) so we never cut off a legitimate long-poll response.
   */
  private call(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let socket: Socket | null = null;
      let done = false;
      let buffer = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      function finish(err: Error | null, value?: Record<string, unknown>): void {
        if (done) return;
        done = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        try {
          socket?.destroy();
        } catch {
          // ignore
        }
        if (err) {
          reject(err);
        } else {
          resolve(value!);
        }
      }

      socket = connect(IPC_SOCKET_PATH, () => {
        const request: IpcRequest = {
          id: randomUUID(),
          sessionId: this.sessionId,
          method,
          params,
        };
        // Include ITERM_SESSION_ID so the watcher can auto-register after restarts
        const itermId = process.env.ITERM_SESSION_ID;
        if (itermId) request.itermSessionId = itermId;
        socket!.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;

        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        let response: IpcResponse;
        try {
          response = JSON.parse(line) as IpcResponse;
        } catch {
          finish(new Error(`IPC parse error: ${line}`));
          return;
        }

        if (!response.ok) {
          finish(new Error(response.error ?? "IPC call failed"));
        } else {
          finish(null, response.result ?? {});
        }
      });

      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
          finish(
            new Error("Watcher not running. Start it with: npx whazaa watch")
          );
        } else {
          finish(err);
        }
      });

      socket.on("end", () => {
        if (!done) {
          finish(new Error("IPC connection closed before response"));
        }
      });

      // Safety timeout: slightly above the max 'wait' timeout (300 s)
      timer = setTimeout(() => {
        finish(new Error("IPC call timed out"));
      }, 310_000);
    });
  }
}
