// Run after `npm run build`: node scripts/test-console-guard.mjs
// Emits a libsignal-style session dump with and without the guard, into a file.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "guard-"));
function run(guarded) {
  const out = join(dir, guarded ? "guarded.log" : "raw.log");
  const code = `
    ${guarded ? 'import("./dist/watcher/console-guard.js").then(m => { m.installConsoleGuard(); go(); });' : "go();"}
    function go() {
      console.info("Closing session:", { indexInfo: {}, currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from("SECRETKEY") } } });
      console.info("legit line");
    }`;
  execFileSync("/bin/sh", ["-c", `node -e '${code.replace(/'/g, `'\\''`)}' > ${out} 2>&1`]);
  return readFileSync(out, "utf8");
}

const raw = run(false);
const guarded = run(true);
console.log("before guard:", /privKey/.test(raw) ? "privKey LOGGED" : "clean");
console.log("after guard: ", /privKey|Closing session/.test(guarded) ? "privKey LOGGED" : "clean");
assert(/privKey/.test(raw), "repro must leak without guard");
assert(!/privKey|Closing session/.test(guarded));
assert(/legit line/.test(guarded));
console.log("ok");
