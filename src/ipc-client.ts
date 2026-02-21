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

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

export const IPC_SOCKET_PATH = "/tmp/whazaa-watcher.sock";

interface IpcRequest {
  id: string;
  sessionId: string;
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
}

export interface ReceiveResult {
  messages: Array<{ body: string; timestamp: number }>;
}

export interface WaitResult {
  messages: Array<{ body: string; timestamp: number }>;
}

export interface LoginResult {
  message: string;
}

export interface RegisterResult {
  registered: boolean;
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

  // -------------------------------------------------------------------------
  // Public tool methods
  // -------------------------------------------------------------------------

  async register(): Promise<RegisterResult> {
    const result = await this.call("register", {});
    return result as unknown as RegisterResult;
  }

  async status(): Promise<StatusResult> {
    const result = await this.call("status", {});
    return result as unknown as StatusResult;
  }

  async send(message: string): Promise<SendResult> {
    const result = await this.call("send", { message });
    return result as unknown as SendResult;
  }

  async receive(): Promise<ReceiveResult> {
    const result = await this.call("receive", {});
    return result as unknown as ReceiveResult;
  }

  async wait(timeoutMs: number): Promise<WaitResult> {
    const result = await this.call("wait", { timeoutMs });
    return result as unknown as WaitResult;
  }

  async login(): Promise<LoginResult> {
    const result = await this.call("login", {});
    return result as unknown as LoginResult;
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
