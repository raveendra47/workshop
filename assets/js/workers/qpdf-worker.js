// Module worker - qpdf-wasm via qpdf.mjs wrapper (default export = factory).
// Instance is a CLI passthrough (README: "just the CLI").
// Canonical qpdf CLI syntax:
//   encrypt: qpdf --encrypt user owner 256 -- in.pdf out.pdf
//   decrypt: qpdf --password=PW --decrypt in.pdf out.pdf
const send = (msg, transfer) => self.postMessage(msg, transfer || []);

let FACTORY_PROMISE = null;
function loadFactory() {
  if (!FACTORY_PROMISE) {
    FACTORY_PROMISE = import("../../wasm/qpdf/qpdf.mjs").then((m) => {
      const f = m.default || m.init;
      if (typeof f !== "function") throw new Error("No factory in qpdf.mjs. Keys: " + Object.keys(m).join(", "));
      return f;
    });
  }
  return FACTORY_PROMISE;
}

self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    if (d.type !== "run") return;
    const { id, data, op, password } = d;
    let stage = "import engine";
    const T0 = performance.now();
    const el = () => ((performance.now() - T0) / 1000).toFixed(1) + "s";

    console.error("[qpdf] " + el() + ": bootstrapping...");
    const FACTORY = await loadFactory();
    const qp = await FACTORY({
      locateFile: (p) => new URL("../../wasm/qpdf/", import.meta.url).href + p,
      noInitialRun: true,
      print: (l) => console.log("[qpdf-out]", l),
      printErr: (l) => console.error("[qpdf-err]", l),
    });
    console.error("[qpdf] " + el() + ": ready");

    stage = "write input";
    qp.FS.writeFile("in.pdf", new Uint8Array(data));
    console.error("[qpdf] " + el() + ": input written");

    stage = "run";
    const args = op === "encrypt"
      ? ["--encrypt", password, password, "256", "--", "in.pdf", "out.pdf"]
      : ["--password=" + password, "--decrypt", "in.pdf", "out.pdf"];
    console.error("[qpdf] " + el() + ": args " + JSON.stringify(args));

    try { qp.callMain(args); }
    catch (err) { if (!(err && err.name === "ExitStatus" && err.status === 0)) throw err; }
    console.error("[qpdf] " + el() + ": callMain done");

    stage = "read output";
    const exists = qp.FS.analyzePath ? qp.FS.analyzePath("out.pdf").exists : true;
    if (!exists) throw new Error(op === "unlock"
      ? "No output - wrong password, or the file is not encrypted."
      : "qpdf produced no output file.");
    const out = qp.FS.readFile("out.pdf", { encoding: "binary" });
    const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
    try { qp.FS.unlink("in.pdf"); qp.FS.unlink("out.pdf"); } catch {}
    if (!bytes.length) throw new Error("qpdf produced empty output.");

    console.error("[qpdf] " + el() + ": success " + bytes.length + "B");
    send({ type: "done", id, data: bytes.buffer, size: bytes.length }, [bytes.buffer]);
  } catch (err) {
    const detail = "stage=" + stage + " | " + (err?.name || "") + " | " + String(err?.message || err);
    console.error("[qpdf] FAILED:", err);
    send({ type: "error", id: d.id, message: detail });
  }
};
