/**
 * @module setup
 *
 * Interactive CLI operations for Whazaa: setup wizard and uninstall.
 *
 * This module is invoked when the user runs `npx whazaa setup` or
 * `npx whazaa uninstall` from the command line. It is intentionally
 * kept separate from `index.ts` so the MCP server entry point stays
 * lean, and so that setup/uninstall can safely write to stdout (the
 * terminal) without polluting the JSON-RPC transport used by the MCP
 * server.
 *
 * ### Setup wizard (`setup`)
 * 1. Writes the Whazaa entry into `~/.claude/.mcp.json` so Claude Code
 *    discovers the MCP server automatically.
 * 2. Installs the `/name` skill for session renaming.
 * 3. Checks whether an existing WhatsApp session (creds.json) is still
 *    valid. If yes, exits immediately. If not, clears stale credentials.
 * 4. Runs a new QR-code pairing flow and waits for the user to scan it.
 * 5. Lets Baileys finish its initial sync, then exits.
 *
 * ### Uninstall (`uninstall`)
 * - Removes the Whazaa entry from `~/.claude/.mcp.json`.
 * - Deletes the Baileys auth credential directory.
 * - Removes the `~/.whazaa/` directory if it is empty.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  initialize,
  triggerLogin,
  waitForConnection,
  waitForLogout,
  waitForQR,
} from "./whatsapp.js";
import { resolveAuthDir, enableSetupMode, cleanupQR, suppressQRDisplay, unsuppressQRDisplay } from "./auth.js";

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

/**
 * Open a URL in the user's default browser, platform-agnostic.
 *
 * Uses `open` on macOS, `start` on Windows, and `xdg-open` on Linux.
 * The child process is detached and its stdio is ignored so it does not
 * block or inherit the parent's streams.
 *
 * @param url - The URL to open (e.g. a GitHub repository page).
 */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "start"
      : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

/**
 * Run the interactive Whazaa setup wizard.
 *
 * This is the entry point for `npx whazaa setup`. It walks the user through
 * four steps:
 *
 * 1. **MCP config** — Adds the `whazaa` server entry to `~/.claude/.mcp.json`,
 *    creating the file (and its parent directory) if necessary.
 * 2. **Skill install** — Writes the `/name` skill SKILL.md to
 *    `~/.claude/skills/Name/` so Claude Code can rename sessions with
 *    `whatsapp_rename`.
 * 3. **Session check** — If a `creds.json` already exists in the Baileys auth
 *    directory, attempts to verify the live connection. Exits early when the
 *    session is still valid; clears credentials and re-pairs when it is not.
 * 4. **QR pairing** — Triggers a new WhatsApp login, waits for the user to
 *    scan the QR code, then gives Baileys 5 seconds to finish syncing before
 *    exiting with a success message.
 *
 * Pass `--force` / `-f` on the command line to skip the session check and
 * always re-pair, clearing any existing credentials first.
 *
 * @returns A promise that resolves (via `process.exit(0)`) after the wizard
 *   completes successfully.
 */
export async function setup(): Promise<void> {
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
  // Step 1b: Install /name skill for session renaming
  // ------------------------------------------------------------------
  const skillDir = join(homedir(), ".claude", "skills", "Name");
  const skillPath = join(skillDir, "SKILL.md");
  if (existsSync(skillPath)) {
    console.log("Skill /name already installed");
  } else {
    mkdirSync(skillDir, { recursive: true });
    const skillContent = [
      "---",
      "name: name",
      'description: Rename the current Claude session (tab title + registry). USE WHEN user says "/name", "name this session", "rename session", OR wants to label what they\'re working on.',
      "user_invocable: true",
      "---",
      "",
      "# Name — Session Renaming",
      "",
      "Rename the current session using the Whazaa `whatsapp_rename` MCP tool.",
      "",
      "## Usage",
      "",
      "```",
      "/name <new name>",
      "```",
      "",
      "## Instructions",
      "",
      "When this skill is invoked with arguments, immediately call `whatsapp_rename` with the argument as the name. No confirmation needed. Report the result.",
      "",
      "If no argument is provided, ask what name to use.",
      "",
    ].join("\n");
    writeFileSync(skillPath, skillContent);
    console.log("Installed /name skill for session renaming");
  }

  // ------------------------------------------------------------------
  // Step 2: Check whether already paired
  // ------------------------------------------------------------------
  const forceRepair = process.argv.includes("--force") || process.argv.includes("-f");
  const authDir = resolveAuthDir();
  const alreadyPaired =
    !forceRepair && existsSync(authDir) && readdirSync(authDir).some((f) => f === "creds.json");

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
  if (forceRepair && existsSync(authDir)) {
    rmSync(authDir, { recursive: true, force: true });
    console.log("Cleared old credentials (--force).\n");
  }
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

/**
 * Uninstall Whazaa from the local machine.
 *
 * This is the entry point for `npx whazaa uninstall`. It performs three
 * cleanup steps in order:
 *
 * 1. **MCP config** — Removes the `whazaa` entry from `~/.claude/.mcp.json`
 *    and writes the updated file back. Does nothing if the entry does not
 *    exist or the file cannot be parsed.
 * 2. **Auth credentials** — Deletes the Baileys authentication directory
 *    (resolved by `resolveAuthDir`) so that the WhatsApp session is fully
 *    de-linked.
 * 3. **State directory** — Removes `~/.whazaa/` if it exists and is empty,
 *    leaving it in place if other files are still present.
 *
 * Always exits with `process.exit(0)` after completion so that the calling
 * shell script can detect success reliably.
 *
 * @returns A promise that resolves (via `process.exit(0)`) after all
 *   cleanup steps are complete.
 */
export async function uninstall(): Promise<void> {
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
