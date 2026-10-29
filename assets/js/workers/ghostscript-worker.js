// Module worker - COMPRESS ONLY. Persistent engine: boots once, reused every run.
// Page sends: { type: "boot" } (warm-up) | { type: "run", id, data, preset }

function dumpErr(err) {
  if (err == null) return "unknown (null/undefined throw)";
  if (typeof err === "string") return err;
  const parts = [];
  parts.push("type=" + (err.constructor?.name || typeof err));
  if (err.name) parts.push("name=" + err.name);
  if (err.errno !== undefined) parts.push("errno=" + err.errno);
  if (err.status !== undefined) parts.push("status=" + err.status);
  if (err.message) parts.push("message=" + JSON.stringify(err.message));
  return parts.join(" | ");
}

let FACTORY = null;
let BOOT_ERR = null;
try {
  const mod = await import("../../wasm/ghostscript/gs.js");
  FACTORY = mod.default;
  if (typeof FACTORY !== "function") {
    BOOT_ERR = "No default export factory in gs.js. Exports seen: " + Object.keys(mod).join(", ");
  }
} catch (err) { BOOT_ERR = "Import failed: " + dumpErr(err); }

const WASM_DIR = new URL("../../wasm/ghostscript/", import.meta.url).href;
const send = (msg, transfer) => self.postMessage(msg, transfer || []);
let gsLogs = [];
const tap = (line) => { gsLogs.push(String(line)); send({ type: "log", line: String(line) }); };
const tail = (n) => gsLogs.slice(-n).join(" // ") || "(no output captured)";

let GS = null;         // persistent engine instance
let WASM_BIN = null;   // cached binary
let busy = false;
let stage = "idle";

async function getWasmBinary() {
  if (WASM_BIN) return WASM_BIN;
  const resp = await fetch(WASM_DIR + "gs.wasm", { cache: "force-cache", credentials: "same-origin" });
  if (!resp.ok) throw new Error("gs.wasm fetch failed: HTTP " + resp.status);
  WASM_BIN = new Uint8Array(await resp.arrayBuffer());
  return WASM_BIN;
}

async function boot() {
  if (GS) return GS;
  if (BOOT_ERR) throw new Error(BOOT_ERR);
  stage = "boot";
  const wasmBinary = await getWasmBinary();
  GS = await FACTORY({
    wasmBinary,                        // no second fetch inside Emscripten
    locateFile: (p) => WASM_DIR + p,   // fallback for any extra files (cmaps etc.)
    noInitialRun: true,
    noExitRuntime: true,               // ← runtime survives callMain → REUSABLE
    print: tap,
    printErr: tap,
  });
  if (!GS.FS) throw new Error("No FS on module. Keys: " + Object.keys(GS).join(", "));
  return GS;
}

self.onmessage = async (e) => {
  const msg = e.data || {};

  if (msg.type === "boot") {
    if (GS) return send({ type: "engine-ready" });
    try { gsLogs = []; await boot(); send({ type: "engine-ready" }); }
    catch (err) {
      GS = null; BOOT_ERR = dumpErr(err);
      send({ type: "error", id: 0, message: "Engine boot failed: " + BOOT_ERR });
    }
    return;
  }

  if (msg.type !== "run") return;
  if (busy) return send({ type: "error", id: msg.id, message: "busy" });
  busy = true;
  const T0 = performance.now();
  const el = () => ((performance.now() - T0) / 1000).toFixed(1) + "s";
  let { id, data, preset } = msg;

  try {
    gsLogs = [];
    const gs = await boot();
    stage = "write input";
    gs.FS.writeFile("in.pdf", new Uint8Array(data));
    data = null;
    stage = "run";
    const args = [
      "-sDEVICE=pdfwrite",
      ...(preset ? ["-dPDFSETTINGS=/" + preset] : []),
      // tuned overrides (win when images actually get re-encoded)
      "-dAutoRotatePages=/None",
      "-dDetectDuplicateImages=true",
      "-dAutoFilterColorImages=false", "-dColorImageFilter=/DCTEncode",
      "-dAutoFilterGrayImages=false", "-dGrayImageFilter=/DCTEncode",
      "-dNOPAUSE", "-dBATCH",
      "-sOutputFile=out.pdf", "in.pdf",
    ];
    stage = "callMain";
    try { gs.callMain(args); }
    catch (err) { if (!(err && err.name === "ExitStatus" && err.status === 0)) throw err; }
    stage = "read output";
    const exists = gs.FS.analyzePath ? gs.FS.analyzePath("out.pdf").exists : true;
    if (!exists) throw new Error("No out.pdf created. Last output:\n" + tail(15));
    const out = gs.FS.readFile("out.pdf", { encoding: "binary" });
    const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
    try { gs.FS.unlink("in.pdf"); gs.FS.unlink("out.pdf"); } catch {}
    if (!bytes.length) throw new Error("Empty out.pdf. Last output:\n" + tail(15));
    console.error("[gs] " + el() + ": success, out=" + bytes.length + "B");
    send({ type: "done", id, data: bytes.buffer, size: bytes.length }, [bytes.buffer]);
  } catch (err) {
    GS = null;   // self-heal: next run reboots a fresh engine
    const blob = (err?.name || "") + " " + (err?.message || "");
    const oom = /memory|allocat|enlarge|RangeError/i.test(blob);
    const detail = (oom ? "out-of-memory" : "stage=" + stage) + " | " + dumpErr(err)
      + (gsLogs.length ? " | gs-tail: " + tail(8) : "");
    console.error("[gs] FAILED at " + stage + " (" + el() + "):", err);
    send({ type: "error", id, message: oom ? "Ran out of memory - file too large for this device." : detail });
  } finally {
    busy = false;
  }
};