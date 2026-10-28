// Classic worker — Repair: Ghostscript rebuild first, pdf-lib fallback.
// Strategy per blueprint: GS re-interprets damaged structure; pdf-lib is the
// stricter parser that sometimes succeeds where GS refuses.
importScripts(new URL("../../vendor/pdf-lib.min.js", import.meta.url).href);

const send = (msg, transfer) => self.postMessage(msg, transfer || []);

// Quick structural sniff — feeds the diagnosis.
function sniff(bytes) {
  const head = new TextDecoder().decode(bytes.slice(0, 1024));
  const tail = new TextDecoder().decode(bytes.slice(-1024));
  const isPdf = head.startsWith("%PDF-");
  const version = head.match(/%PDF-(\d\.\d)/)?.[1] || "?";
  const hasEOF = tail.includes("%%EOF");
  return { isPdf, version, hasEOF };
}

self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    if (d.type !== "run") return;
    const { id, data } = d;
    const bytes = new Uint8Array(data);
    const diag = sniff(bytes);
    send({ type: "note", text: `Input: PDF-${diag.version}, ${diag.hasEOF ? "EOF marker present" : "EOF marker MISSING"} — trying Ghostscript rebuild…` });

    let outBytes = null;
    let method = "";

    // ---- Attempt 1: Ghostscript re-interpretation ----
    try {
      send({ type: "note", text: "Ghostscript: importing engine…" });
      const mod = await import("../../wasm/ghostscript/gs.js");
      const FACTORY = mod.default;
      if (typeof FACTORY !== "function") throw new Error("gs.js factory missing");
      const gs = await FACTORY({
        locateFile: (p) => new URL("../../wasm/ghostscript/", import.meta.url).href + p,
        noInitialRun: true,
        print: () => {},
        printErr: () => {},
      });
      if (!gs.FS || typeof gs.callMain !== "function") throw new Error("gs API surface unexpected");

      send({ type: "note", text: "Ghostscript: rebuilding structure…" });
      gs.FS.writeFile("in.pdf", bytes);
      try {
        gs.callMain([
          "-sDEVICE=pdfwrite",
          "-dPDFSETTINGS=/default",
          "-dNOPAUSE", "-dBATCH",
          "-dPDFSTOPONERROR=false",
          "-dStopOnResolvedBindingError=false",
          "-sOutputFile=out.pdf",
          "in.pdf",
        ]);
      } catch (err) {
        if (!(err && err.name === "ExitStatus" && err.status === 0)) throw err;
      }
      const exists = gs.FS.analyzePath ? gs.FS.analyzePath("out.pdf").exists : true;
      if (exists) {
        const out = gs.FS.readFile("out.pdf", { encoding: "binary" });
        const b = out instanceof Uint8Array ? out : new Uint8Array(out);
        if (b.length > 0) { outBytes = b; method = "Ghostscript rebuild"; }
        try { gs.FS.unlink("in.pdf"); gs.FS.unlink("out.pdf"); } catch {}
      }
    } catch (gsErr) {
      send({ type: "note", text: "Ghostscript route failed (" + (gsErr?.message || gsErr) + ") — trying pdf-lib…" });
    }

    // ---- Attempt 2: pdf-lib strict parse ----
    if (!outBytes) {
      try {
        const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: false });
        const n = doc.getPageCount();
        outBytes = await doc.save();
        method = "pdf-lib re-save";
        send({ type: "note", text: `pdf-lib succeeded — ${n} pages recovered.` });
      } catch (libErr) {
        throw new Error(
          `Both engines failed. GS route and pdf-lib route exhausted. ` +
          `Most likely: the file is truncated (bytes physically missing), encrypted with an unknown password, or not actually a PDF. ` +
          `pdf-lib said: ${libErr?.message || libErr}`
        );
      }
    }

    // Sanity: output must be a PDF
    const head = new TextDecoder().decode(outBytes.slice(0, 5));
    if (!head.startsWith("%PDF-")) throw new Error("Repair output failed sanity check (not a PDF).");

    send({ type: "done", id, data: outBytes.buffer, size: outBytes.length, method }, [outBytes.buffer]);
  } catch (err) {
    send({ type: "error", id: d.id, message: err?.message || String(err) });
  }
};