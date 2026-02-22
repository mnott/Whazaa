#!/usr/bin/env node
/**
 * index.ts — Whazaa MCP server entry point
 *
 * Exposes five tools over the Model Context Protocol (stdio transport):
 *
 *   whatsapp_status   — Report connection state and phone number
 *   whatsapp_send     — Send a message to your own WhatsApp number
 *   whatsapp_receive  — Drain queued incoming messages from your phone
 *   whatsapp_wait     — Long-poll for the next incoming message
 *   whatsapp_login    — Trigger a new QR pairing flow
 *
 * Architecture: The MCP server is a thin IPC proxy. All WhatsApp operations
 * are forwarded to the watcher daemon (watch.ts) over a Unix Domain Socket
 * at /tmp/whazaa-watcher.sock. The watcher is the sole owner of the Baileys
 * connection. If the watcher is not running, tools return a clear error.
 *
 * CRITICAL: stdout is the MCP JSON-RPC transport.
 *   - NEVER write non-JSON to stdout.
 *   - All debug output, QR codes, and logs go to stderr.
 *
 * SETUP MODE: When invoked with "setup" argument, runs an interactive setup
 * wizard. In setup mode stdout is the terminal — console.log is safe.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initialize,
  triggerLogin,
  waitForConnection,
  waitForLogout,
  waitForQR,
} from "./whatsapp.js";
import { resolveAuthDir, enableSetupMode, cleanupQR, suppressQRDisplay, unsuppressQRDisplay } from "./auth.js";
import { watch } from "./watch.js";
import { WatcherClient, ChatsResult, HistoryResult } from "./ipc-client.js";
import { listChats, getMessages, isDesktopDbAvailable } from "./desktop-db.js";

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

/**
 * Open a URL in the user's default browser, platform-agnostic.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "start"
      : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

async function setup(): Promise<void> {
  enableSetupMode();

  const repoUrl = "https://github.com/mnott/Whazaa";
  console.log(`Opening Whazaa on GitHub: ${repoUrl}`);
  openBrowser(repoUrl);

  console.log("\nWhazaa Setup\n");

  // ------------------------------------------------------------------
  // Step 1: Configure ~/.claude/.mcp.json
  // ------------------------------------------------------------------
  const mcpPath = join(homedir(), ".claude", ".mcp.json");

  interface McpConfig {
    mcpServers?: Record<string, { command: string; args: string[] }>;
  }

  let config: McpConfig = {};

  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFileSync(mcpPath, "utf-8")) as McpConfig;
    } catch {
      console.log("Warning: ~/.claude/.mcp.json exists but could not be parsed. Overwriting.");
      config = {};
    }

    if (config.mcpServers?.whazaa) {
      console.log("Already configured in ~/.claude/.mcp.json");
    } else {
      config.mcpServers = config.mcpServers ?? {};
      config.mcpServers.whazaa = { command: "npx", args: ["-y", "whazaa"] };
      writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
      console.log("Added Whazaa to ~/.claude/.mcp.json");
    }
  } else {
    mkdirSync(dirname(mcpPath), { recursive: true });
    config = {
      mcpServers: {
        whazaa: { command: "npx", args: ["-y", "whazaa"] },
      },
    };
    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
    console.log("Created ~/.claude/.mcp.json with Whazaa");
  }

  // ------------------------------------------------------------------
  // Step 2: Check whether already paired
  // ------------------------------------------------------------------
  const authDir = resolveAuthDir();
  const alreadyPaired =
    existsSync(authDir) && readdirSync(authDir).some((f) => f === "creds.json");

  if (alreadyPaired) {
    console.log("\nExisting session found — verifying connection...");
    suppressQRDisplay();
    initialize().catch(() => {});

    const VERIFY_TIMEOUT_MS = 10_000;
    const result = await Promise.race([
      waitForConnection().then((phone) => ({ outcome: "connected" as const, phone })),
      waitForLogout().then(() => ({ outcome: "logout" as const, phone: null })),
      waitForQR().then(() => ({ outcome: "qr" as const, phone: null })),
      new Promise<{ outcome: "timeout"; phone: null }>((resolve) =>
        setTimeout(() => resolve({ outcome: "timeout", phone: null }), VERIFY_TIMEOUT_MS)
      ),
    ]);

    unsuppressQRDisplay();

    if (result.outcome === "connected") {
      console.log(`\nAlready connected! Your WhatsApp session is active as +${result.phone}.`);
      console.log("\nSetup complete! Restart Claude Code if Whazaa is not yet available.");
      process.exit(0);
    }

    if (result.outcome === "logout" || result.outcome === "qr") {
      console.log("\nSession expired or revoked. Clearing old credentials and re-pairing...\n");
    } else {
      console.log("\nCould not verify connection (another Whazaa instance may already be running).");
      console.log("Assuming session is active. If Whazaa tools are not working, run `npx whazaa setup` again.");
      process.exit(0);
    }

    rmSync(authDir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------
  // Step 3: First-time pairing — show QR code
  // ------------------------------------------------------------------
  console.log("Scan the QR code in your browser with WhatsApp:");
  console.log("  Settings -> Linked Devices -> Link a Device\n");

  triggerLogin().catch(() => {});

  const phoneNumber = await waitForConnection();
  cleanupQR();

  // ------------------------------------------------------------------
  // Step 4: Success
  // ------------------------------------------------------------------
  console.log(`\nConnected to WhatsApp as +${phoneNumber}`);
  console.log("Finishing sync with WhatsApp...");

  await new Promise((resolve) => setTimeout(resolve, 5_000));

  console.log("\nSetup complete! Restart Claude Code and Whazaa will be ready.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

async function uninstall(): Promise<void> {
  console.log("Whazaa Uninstall\n");

  const mcpPath = join(homedir(), ".claude", ".mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const config = JSON.parse(readFileSync(mcpPath, "utf-8"));
      if (config.mcpServers?.whazaa) {
        delete config.mcpServers.whazaa;
        writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
        console.log("Removed Whazaa from ~/.claude/.mcp.json");
      } else {
        console.log("Whazaa not found in ~/.claude/.mcp.json");
      }
    } catch {
      console.log("Warning: could not parse ~/.claude/.mcp.json");
    }
  }

  const authDir = resolveAuthDir();
  if (existsSync(authDir)) {
    rmSync(authDir, { recursive: true, force: true });
    console.log("Removed auth credentials from " + authDir);
  }

  const whazaaDir = join(homedir(), ".whazaa");
  if (existsSync(whazaaDir)) {
    try {
      const remaining = readdirSync(whazaaDir);
      if (remaining.length === 0) {
        rmSync(whazaaDir, { recursive: true });
        console.log("Removed ~/.whazaa/");
      }
    } catch { /* ignore */ }
  }

  console.log("\nWhazaa has been uninstalled. Restart Claude Code to apply.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "whazaa",
  version: "0.1.0",
});

// Shared IPC client — one per MCP server process, bound to the session
// identified by TERM_SESSION_ID (set by iTerm2).
const watcher = new WatcherClient();

// ---------------------------------------------------------------------------
// Tool: whatsapp_status
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_status",
  "Check the Whazaa connection state and the WhatsApp phone number it is logged in as.",
  {},
  async () => {
    try {
      const s = await watcher.status();

      let text: string;
      if (s.awaitingQR) {
        text =
          "Awaiting QR scan. Check the terminal where the watcher is running and scan the QR code with WhatsApp.";
      } else if (s.connected && s.phoneNumber) {
        text = `Connected. Phone: +${s.phoneNumber}`;
      } else {
        text =
          "Disconnected. The watcher is attempting to reconnect in the background.";
      }

      return { content: [{ type: "text", text }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_send
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_send",
  [
    "Send a WhatsApp message.",
    "Without a recipient, sends to your own self-chat (same as before).",
    "With a recipient, sends to any contact or group.",
    "Recipient can be a phone number with country code (e.g. '+41764502698'),",
    "a WhatsApp JID (e.g. '41764502698@s.whatsapp.net'), or a contact name.",
    "Supports basic Markdown: **bold**, *italic*, `code`.",
  ].join(" "),
  {
    message: z
      .string()
      .min(1)
      .describe("The message text to send"),
    recipient: z
      .string()
      .optional()
      .describe(
        "Optional recipient: phone number (e.g. '+41764502698'), WhatsApp JID, or contact name. Omit to send to self-chat."
      ),
  },
  async ({ message, recipient }) => {
    try {
      const result = await watcher.send(message, recipient);
      const dest = result.targetJid ?? "self-chat";
      return {
        content: [{ type: "text", text: `Sent to ${dest}: ${result.preview}` }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_receive
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_receive",
  [
    "Return queued incoming WhatsApp messages since the last call, then clear the queue.",
    "Without 'from': returns self-chat messages (default, backwards compatible).",
    "With 'from' set to a phone number, JID, or contact name: returns messages from that contact.",
    "With 'from' set to 'all': returns messages from all chats (self-chat + all contacts), prefixed with sender JID.",
    "Returns 'No new messages.' if the queue is empty.",
  ].join(" "),
  {
    from: z
      .string()
      .optional()
      .describe(
        "Optional sender filter: phone number, JID, contact name, or 'all'. Omit for self-chat only."
      ),
  },
  async ({ from }) => {
    try {
      const result = await watcher.receive(from);
      const { messages } = result;

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No new messages." }] };
      }

      const formatted = messages
        .map((m) => {
          const ts = new Date(m.timestamp).toISOString();
          return `[${ts}] ${m.body}`;
        })
        .join("\n");

      return { content: [{ type: "text", text: formatted }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_contacts
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_contacts",
  [
    "List recently seen WhatsApp contacts.",
    "Returns contacts that have sent or received messages in this session, most recent first.",
    "Optionally filter by name or phone number using the 'search' parameter.",
    "Use the returned phone number or JID as the 'recipient' parameter for whatsapp_send.",
  ].join(" "),
  {
    search: z
      .string()
      .optional()
      .describe("Optional search string to filter contacts by name or phone number"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe("Maximum number of contacts to return (default 50)"),
  },
  async ({ search, limit }) => {
    try {
      const result = await watcher.contacts(search, limit);
      const { contacts } = result;

      if (contacts.length === 0) {
        const msg = search
          ? `No contacts found matching '${search}'.`
          : "No contacts seen yet. Send a message first, or wait for incoming messages.";
        return { content: [{ type: "text", text: msg }] };
      }

      const lines = contacts.map((c) => {
        const name = c.name ? `${c.name} ` : "";
        const ts = new Date(c.lastSeen).toISOString();
        return `${name}+${c.phoneNumber} (${c.jid}) — last seen ${ts}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `${contacts.length} contact(s):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_chats
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_chats",
  [
    "List WhatsApp chat conversations (inbox).",
    "Reads directly from the WhatsApp Desktop macOS SQLite database when available (complete inbox, no Baileys sync required).",
    "Falls back to the Baileys in-memory store when the Desktop DB is not present (~100-150 chats synced on connect).",
    "Use the returned JID as the 'recipient' parameter for whatsapp_send,",
    "or with whatsapp_receive to read messages from a specific contact.",
    "Optionally filter by name or phone number using the 'search' parameter.",
  ].join(" "),
  {
    search: z
      .string()
      .optional()
      .describe("Optional search string to filter chats by name or phone number"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe("Maximum number of chats to return (default 50)"),
  },
  async ({ search, limit }) => {
    try {
      // Try the Desktop DB first — it has the full inbox without needing Baileys sync
      const desktopChats = listChats(search, limit);

      if (desktopChats !== null) {
        // Desktop DB is available
        if (desktopChats.length === 0) {
          const msg = search
            ? `No chats found matching '${search}'.`
            : "No chats found in the WhatsApp Desktop database.";
          return { content: [{ type: "text", text: msg }] };
        }

        const lines = desktopChats.map((c) => {
          const ts = c.lastMessageDate || "unknown";
          const unread = c.unreadCount > 0 ? ` [${c.unreadCount} unread]` : "";
          const archived = c.archived ? " [archived]" : "";
          return `${c.name} (${c.jid})${unread}${archived} — last message ${ts}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `${desktopChats.length} chat(s) [source: Desktop DB]:\n${lines.join("\n")}`,
            },
          ],
        };
      }

      // Fall back to Baileys IPC store
      const result: ChatsResult = await watcher.chats({ search, limit });
      const { chats } = result;

      if (chats.length === 0) {
        const msg = search
          ? `No chats found matching '${search}'.`
          : "No chats available yet. The store may still be syncing — try again in a few seconds.";
        return { content: [{ type: "text", text: msg }] };
      }

      const lines = chats.map((c) => {
        const ts = c.lastMessageTimestamp
          ? new Date(c.lastMessageTimestamp).toISOString()
          : "unknown";
        const unread = c.unreadCount > 0 ? ` [${c.unreadCount} unread]` : "";
        return `${c.name} (${c.jid})${unread} — last message ${ts}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `${chats.length} chat(s) [source: Baileys store]:\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_wait
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_wait",
  [
    "Wait for the next incoming WhatsApp message.",
    "Blocks until a message arrives or the timeout is reached (default 120 seconds).",
    "Use this instead of polling whatsapp_receive in a loop.",
    "Run this in the background so you can continue working while waiting.",
  ].join(" "),
  {
    timeout: z
      .number()
      .min(1)
      .max(300)
      .default(120)
      .describe("Max seconds to wait for a message (default 120)"),
  },
  async ({ timeout }) => {
    try {
      const result = await watcher.wait(timeout * 1_000);
      const { messages } = result;

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No messages received (timed out)." }] };
      }

      const formatted = messages
        .map((m) => {
          const ts = new Date(m.timestamp).toISOString();
          return `[${ts}] ${m.body}`;
        })
        .join("\n");

      return { content: [{ type: "text", text: formatted }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_login
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_login",
  [
    "Trigger a new WhatsApp QR pairing flow.",
    "Use this when the connection is lost and automatic reconnection fails,",
    "or when you need to link a different phone number.",
    "A QR code will be printed to the watcher's stderr — check the terminal where it is running.",
  ].join(" "),
  {},
  async () => {
    try {
      const result = await watcher.login();
      return {
        content: [{ type: "text", text: result.message }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_history
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_history",
  [
    "Fetch message history for a WhatsApp chat.",
    "Reads directly from the WhatsApp Desktop macOS SQLite database when available — no phone connection required.",
    "Falls back to Baileys on-demand fetch (requires phone online) when the Desktop DB is not present.",
    "Accepts a full JID (e.g. '41796074745@s.whatsapp.net') or a phone number (e.g. '+41796074745').",
  ].join(" "),
  {
    jid: z
      .string()
      .min(1)
      .describe(
        "The chat JID (e.g. '41796074745@s.whatsapp.net') or phone number (e.g. '+41796074745')"
      ),
    count: z
      .number()
      .min(1)
      .max(500)
      .default(50)
      .describe("Number of messages to fetch (default 50, max 500)"),
  },
  async ({ jid, count }) => {
    try {
      // Try the Desktop DB first — works offline, no anchor message needed
      const desktopMessages = getMessages(jid, count);

      if (desktopMessages !== null) {
        // Desktop DB is available
        if (desktopMessages.length === 0) {
          return {
            content: [{ type: "text", text: `No messages found for ${jid} in the WhatsApp Desktop database.` }],
          };
        }

        const lines = desktopMessages.map((m) => {
          const direction = m.fromMe ? "Me" : (m.pushName ?? "Them");
          return `[${m.date}] ${direction}: ${m.text}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `${desktopMessages.length} message(s) for ${jid} [source: Desktop DB]:\n${lines.join("\n")}`,
            },
          ],
        };
      }

      // Fall back to Baileys IPC (on-demand fetch from phone)
      const result: HistoryResult = await watcher.history({ jid, count });
      const { messages } = result;

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No messages found for this chat." }] };
      }

      const lines = messages.map((m) => {
        const direction = m.fromMe ? "Me" : "Them";
        return `[${m.date}] ${direction}: ${m.text}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `${messages.length} message(s) for ${jid} [source: Baileys]:\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes("setup")) {
    await setup();
    return;
  }

  if (process.argv.includes("uninstall")) {
    await uninstall();
    return;
  }

  if (process.argv.includes("watch")) {
    const watchIdx = process.argv.indexOf("watch");
    const sessionId = process.argv[watchIdx + 1];
    await watch(sessionId);
    return;
  }

  // MCP server mode: register this session with the watcher so incoming
  // messages are routed to our queue. Registration failure is non-fatal —
  // the watcher may not be running yet, and the user will see a clear error
  // when they try to use the tools.
  watcher.register().catch((err) => {
    process.stderr.write(`[whazaa] Could not register with watcher: ${err}\n`);
    process.stderr.write(`[whazaa] Start the watcher with: npx whazaa watch\n`);
  });

  // Start the MCP server over stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[whazaa] Fatal error: ${err}\n`);
  process.exit(1);
});
