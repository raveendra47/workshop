// Module worker - spawned with { type: "module" }, loads gs.js via import().
// API per @okathira/ghostpdl-wasm README: default-export factory, Module.FS, Module.callMain.

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
  const mod = await import("/assets/wasm/ghostscript/gs.js");
  FACTORY = mod.default;                      // README: default export is the loader
  if (typeof FACTORY !== "function") {
    BOOT_ERR = "No default export factory in gs.js. Exports seen: " + Object.keys(mod).join(", ");
  }
} catch (e) {
  BOOT_ERR = "Import failed: " + dumpErr(e);
}

const WASM_DIR = "/assets/wasm/ghostscript/";
const send = (msg, transfer) => self.postMessage(msg, transfer || []);

let gsLogs = [];
const tap = (line) => {
  gsLogs.push(String(line));
  send({ type: "log", line: String(line) });
};
const tail = (n) => gsLogs.slice(-n).join(" // ") || "(no output captured from Ghostscript)";

self.onmessage = async (e) => {
  if (e.data?.type !== "run") return;
  const { id, data, preset } = e.data;
  let stage = "init";
  try {
    if (BOOT_ERR) throw new Error(BOOT_ERR);

    gsLogs = [];
    stage = "init";
    console.error("[gs] initializing WASM module...");
    const gs = await FACTORY({
      locateFile: (p) => WASM_DIR + p,
      noInitialRun: true,
      print: tap,
      printErr: tap,
    });
    console.error("[gs] module ready. API keys:", Object.keys(gs).join(", "));

    if (!gs.FS) throw new Error("No FS on module. Keys: " + Object.keys(gs).join(", "));

    stage = "write input";
    gs.FS.writeFile("in.pdf", new Uint8Array(data));

    stage = "run";
    const args = [
      "-sDEVICE=pdfwrite",
      "-dPDFSETTINGS=/" + preset,
      "-dNOPAUSE",
      "-dBATCH",
      "-sOutputFile=out.pdf",
      "in.pdf",
    ];
    try {
      gs.callMain(args);                      // README: callMain is the run API
    } catch (e) {
      // Ghostscript terminates via exit(0); Emscripten may surface that as ExitStatus.
      if (!(e && e.name === "ExitStatus" && e.status === 0)) throw e;
      console.error("[gs] callMain exited via ExitStatus(0) - normal termination");
    }

    stage = "read output";
    const exists = gs.FS.analyzePath ? gs.FS.analyzePath("out.pdf").exists : true;
    if (!exists) {
      throw new Error("Ghostscript ran but created no out.pdf. Last output:\n" + tail(15));
    }
    const out = gs.FS.readFile("out.pdf", { encoding: "binary" });  // README-exact
    const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
    try { gs.FS.unlink("in.pdf"); gs.FS.unlink("out.pdf"); } catch {}

    if (!bytes.length) {
      throw new Error("Ghostscript produced an empty out.pdf. Last output:\n" + tail(15));
    }

    console.error("[gs] success:", bytes.length, "bytes");
    send({ type: "done", id, data: bytes.buffer, size: bytes.length }, [bytes.buffer]);
  } catch (err) {
    const detail = "stage=" + stage + " | " + dumpErr(err)
      + (gsLogs.length ? " | gs-tail: " + tail(8) : "");
    console.error("[gs] FAILED at " + stage + ":", err);
    send({ type: "error", id, message: detail });
  }
};