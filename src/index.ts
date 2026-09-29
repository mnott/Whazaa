#!/usr/bin/env node
/**
 * Whazaa — WhatsApp adapter for AIBroker.
 *
 * This is a transport adapter, NOT an MCP server. All MCP tools are served
 * by the unified AIBroker MCP server (aibroker entry in ~/.claude.json).
 *
 * Entry points:
 *   - `watch [sessionId]` — Start the watcher daemon (Baileys connection,
 *     IPC server, message queues). Connects to AIBroker hub.
 *   - `setup` — Interactive setup wizard.
 *   - `uninstall` — Remove config and credentials.
 */

import { watch } from "./watcher/index.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setup, uninstall } from "./setup.js";

const SERVICE_VERBS: Record<string, string> = { start: "start", stop: "stop", status: "status", unit: "plist" };

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "setup":
      await setup();
      break;
    case "uninstall":
      await uninstall();
      break;
    case "watch":
      await watch(process.argv[3]);
      break;
    case "service": {
      const verb = SERVICE_VERBS[process.argv[3] ?? ""];
      if (!verb) {
        process.stderr.write("Usage: whazaa service start [session-id] | stop | status | unit\n");
        process.exit(1);
      }
      const script = fileURLToPath(new URL("../scripts/watcher-ctl.sh", import.meta.url));
      const r = spawnSync("bash", [script, verb, ...process.argv.slice(4)], { stdio: "inherit" });
      process.exit(r.status ?? 1);
    }
    default:
      process.stderr.write(
        "Whazaa is now an adapter for AIBroker.\n" +
        "MCP tools are served by the unified aibroker MCP server.\n\n" +
        "Usage:\n" +
        "  whazaa watch [sessionId]  — Start the watcher daemon\n" +
        "  whazaa setup              — Run setup wizard\n" +
        "  whazaa uninstall          — Remove config\n" +
        "  whazaa service start [session-id] | stop | status | unit\n"
      );
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[whazaa] Fatal error: ${err}\n`);
  process.exit(1);
});
