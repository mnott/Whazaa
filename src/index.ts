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
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initialize,
  getStatus,
  sendMessage,
  drainMessages,
  triggerLogin,
} from "./whatsapp.js";

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
  // Start WhatsApp connection in the background.
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
