// Module worker - GRAYSCALE ONLY.
// Design: onmessage is registered synchronously; the gs.js import is lazy.
// Every stage reports to the page/console - silence is now impossible.

const WASM_DIR = "/assets/wasm/ghostscript/";
const send = (msg, transfer) => self.postMessage(msg, transfer || []);

let gsLogs = [];
const tap = (line) => { gsLogs.push(String(line)); send({ type: "log", line: String(line) }); };
const tail = (n) => gsLogs.slice(-n).join(" // ") || "(no output captured)";

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

let FACTORY_PROMISE = null;
function loadFactory() {
  if (!FACTORY_PROMISE) {
    FACTORY_PROMISE = import(WASM_DIR + "gs.js").then((m) => {
      if (typeof m.default !== "function") {
        throw new Error("No default export in gs.js. Exports: " + Object.keys(m).join(", "));
      }
      return m.default;
    });
  }
  return FACTORY_PROMISE;
}

self.onmessage = async (e) => {
  if (e.data?.type !== "run") return;
  let { id, data, preset } = e.data;
  let stage = "import engine";
  const T0 = performance.now();
  const el = () => ((performance.now() - T0) / 1000).toFixed(1) + "s";
  try {
    console.error("[gs] " + el() + ": message received, importing engine...");
    const FACTORY = await loadFactory();
    console.error("[gs] " + el() + ": engine imported, bootstrapping module...");

    stage = "init";
    gsLogs = [];
    const gs = await FACTORY({
      locateFile: (p) => WASM_DIR + p,
      noInitialRun: true,
      print: tap,
      printErr: tap,
    });
    console.error("[gs] " + el() + ": module ready");
    if (!gs.FS) throw new Error("No FS on module. Keys: " + Object.keys(gs).join(", "));

    stage = "write input";
    gs.FS.writeFile("in.pdf", new Uint8Array(data));
    data = null;

    stage = "run";
    const args = [
      "-sDEVICE=pdfwrite",
      "-sColorConversionStrategy=Gray",
      ...(preset ? ["-dPDFSETTINGS=/" + preset] : []),
      "-dNOPAUSE", "-dBATCH",
      "-sOutputFile=out.pdf", "in.pdf",
    ];
    console.error("[gs] " + el() + ": callMain start");
    try { gs.callMain(args); }
    catch (err) { if (!(err && err.name === "ExitStatus" && err.status === 0)) throw err; }
    console.error("[gs] " + el() + ": callMain done");

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
    const blob = (err?.name || "") + " " + (err?.message || "");
    const oom = /memory|allocat|enlarge|RangeError/i.test(blob);
    const detail = (oom ? "out-of-memory" : "stage=" + stage) + " | " + dumpErr(err)
      + (gsLogs.length ? " | gs-tail: " + tail(8) : "");
    console.error("[gs] FAILED at " + stage + " (" + el() + "):", err);
    send({ type: "error", id, message: oom ? "Ran out of memory - file too large for this device." : detail });
  }
};
