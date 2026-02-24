/**
 * Minimal logger — all watcher output goes to stderr (stdout is MCP JSON-RPC).
 */
export function log(msg: string): void {
  process.stderr.write(`[whazaa-watch] ${msg}\n`);
}
