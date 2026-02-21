#!/usr/bin/env node
/**
 * index.ts — Whazaa MCP server entry point
 *
 * Exposes four tools over the Model Context Protocol (stdio transport):
 *
 *   whatsapp_status   — Report connection state and phone number
 *   whatsapp_send     — Send a message to your own WhatsApp number
 *   whatsapp_receive  — Drain queued incoming messages from your phone
 *   whatsapp_login    — Trigger a new QR pairing flow
 *
 * CRITICAL: stdout is the MCP JSON-RPC transport.
 *   - NEVER write non-JSON to stdout.
 *   - All debug output, QR codes, and logs go to stderr.
 *
 * SETUP MODE: When invoked with the "setup" argument (e.g. `npx whazaa setup`),
 * the script runs an interactive setup wizard instead of starting the MCP server.
 * In setup mode stdout is the terminal — console.log is safe to use.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initialize,
  getStatus,
  sendMessage,
  drainMessages,
  triggerLogin,
  waitForConnection,
} from "./whatsapp.js";
import { resolveAuthDir, enableSetupMode, cleanupQR } from "./auth.js";

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

/**
 * Interactive setup wizard invoked via `npx whazaa setup`.
 *
 * 1. Adds the whazaa entry to ~/.claude/.mcp.json (creates file if absent).
 * 2. Checks whether a pairing session already exists.
 * 3. If not yet paired, starts the WhatsApp connection so the QR code is
 *    displayed on stderr, then waits until the user scans it.
 * 4. Prints a success message and exits.
 */
async function setup(): Promise<void> {
  enableSetupMode();
  console.log("Whazaa Setup\n");

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
    // If we already have credentials on disk, we're paired (or were previously).
    // Still start the connection so we can confirm.
    console.log("\nExisting session found — verifying connection...");
    initialize().catch(() => {
      // Ignore init errors during setup; we'll report via getStatus below.
    });
    const phoneNumber = await waitForConnection();
    console.log(`\nConnected to WhatsApp as +${phoneNumber}`);
    console.log("\nSetup complete! Restart Claude Code and Whazaa will be ready.");
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Step 3: First-time pairing — show QR code
  // ------------------------------------------------------------------
  console.log("\nScan the QR code below with WhatsApp:");
  console.log("  Open WhatsApp -> Linked Devices -> Link a Device\n");

  // initialize() resolves once QR is shown OR connected.
  // We call it to trigger the QR display, then wait for full connection.
  initialize().catch(() => {
    // Errors are written to stderr; don't crash the setup flow.
  });

  const phoneNumber = await waitForConnection();
  cleanupQR();

  // ------------------------------------------------------------------
  // Step 4: Success
  // ------------------------------------------------------------------
  console.log(`\nConnected to WhatsApp as +${phoneNumber}`);
  console.log("\nSetup complete! Restart Claude Code and Whazaa will be ready.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "whazaa",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool: whatsapp_status
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_status",
  "Check the Whazaa connection state and the WhatsApp phone number it is logged in as.",
  {},
  async () => {
    const s = getStatus();

    let text: string;
    if (s.awaitingQR) {
      text =
        "Awaiting QR scan. Check the terminal where Whazaa is running and scan the QR code with WhatsApp.";
    } else if (s.connected && s.phoneNumber) {
      text = `Connected. Phone: +${s.phoneNumber}`;
    } else {
      text =
        "Disconnected. Whazaa is attempting to reconnect in the background.";
    }

    return { content: [{ type: "text", text }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: whatsapp_send
// ---------------------------------------------------------------------------

server.tool(
  "whatsapp_send",
  [
    "Send a message to yourself via WhatsApp self-chat.",
    "Supports basic Markdown: **bold**, *italic*, `code`.",
    "The message appears in your own WhatsApp chat with yourself.",
  ].join(" "),
  {
    message: z
      .string()
      .min(1)
      .describe("The message text to send to your WhatsApp self-chat"),
  },
  async ({ message }) => {
    try {
      await sendMessage(message);
      const preview =
        message.length > 80 ? `${message.slice(0, 80)}...` : message;
      return {
        content: [{ type: "text", text: `Sent: ${preview}` }],
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
    "Return all queued incoming WhatsApp messages received since the last call, then clear the queue.",
    "Messages are from your own WhatsApp number (self-chat) — i.e. messages you type on your phone.",
    "Returns 'No new messages.' if the queue is empty.",
  ].join(" "),
  {},
  async () => {
    const messages = drainMessages();

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
    "A QR code will be printed to the Whazaa server's stderr — check the terminal where it is running.",
  ].join(" "),
  {},
  async () => {
    try {
      // Non-blocking: triggerLogin initiates the reconnect but QR display
      // happens asynchronously via the Baileys event handler.
      triggerLogin().catch((err) => {
        process.stderr.write(`[whazaa] Login trigger error: ${err}\n`);
      });

      return {
        content: [
          {
            type: "text",
            text: "QR pairing initiated. Check the terminal where Whazaa is running and scan the QR code with WhatsApp (Linked Devices -> Link a Device).",
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
  // Dispatch to setup wizard if invoked with the "setup" argument.
  // e.g.: npx whazaa setup   or   npx -y whazaa setup
  if (process.argv.includes("setup")) {
    await setup();
    return; // setup() calls process.exit(), but return here for clarity
  }

  // Default: Start WhatsApp connection in the background.
  // initialize() resolves once connected OR once a QR code has been emitted,
  // so the MCP server is immediately available for tool calls in both cases.
  initialize().catch((err) => {
    process.stderr.write(`[whazaa] Initialization error: ${err}\n`);
  });

  // Start the MCP server over stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[whazaa] Fatal error: ${err}\n`);
  process.exit(1);
});
