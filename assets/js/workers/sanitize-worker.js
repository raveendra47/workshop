// Classic worker — strips Info dict keys + XMP stream reference entirely.
importScripts(new URL("../../vendor/pdf-lib.min.js", import.meta.url).href);

const send = (msg, transfer) => self.postMessage(msg, transfer || []);

const INFO_KEYS = ["Title", "Author", "Subject", "Keywords",
                   "Creator", "Producer", "CreationDate", "ModDate"];

// Load with updateMetadata:false — CRITICAL: pdf-lib would otherwise stamp
// its own Producer and ModDate on load, re-contaminating the file.
function loadClean(data) {
  return PDFLib.PDFDocument.load(data, { updateMetadata: false });
}

function readMeta(doc) {
  const m = {};
  const safe = (fn) => { try { return fn() || ""; } catch { return ""; } };
  m.title    = safe(() => doc.getTitle());
  m.author   = safe(() => doc.getAuthor());
  m.subject  = safe(() => doc.getSubject());
  m.keywords = safe(() => doc.getKeywords());
  m.creator  = safe(() => doc.getCreator());
  m.producer = safe(() => doc.getProducer());
  m.creationDate = safe(() => { const d = doc.getCreationDate(); return d.toISOString(); });
  m.modDate      = safe(() => { const d = doc.getModificationDate(); return d.toISOString(); });
  try {
    m.hasXMP = !!doc.catalog.lookup(PDFLib.PDFName.of("Metadata"));
  } catch { m.hasXMP = false; }
  return m;
}

function countExposed(m) {
  let n = 0;
  for (const k of ["title","author","subject","keywords","creator","producer","creationDate","modDate"]) {
    if (m[k]) n++;
  }
  if (m.hasXMP) n++;
  return n;
}

self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    if (d.type === "probe") {
      const doc = await loadClean(d.data);
      const meta = readMeta(doc);
      send({ type: "probe", pageCount: doc.getPageCount(), meta,
             exposed: countExposed(meta) });
      return;
    }
    if (d.type !== "run") return;

    const { id, data, keepTitle } = d;
    const doc = await loadClean(data);
    const before = readMeta(doc);

    const title = keepTitle ? before.title : "";

    // Delete Info keys outright — no blank-field residue.
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    if (info instanceof PDFLib.PDFDict) {
      for (const k of INFO_KEYS) info.delete(PDFLib.PDFName.of(k));
    }
    // Remove the XMP metadata stream reference.
    doc.catalog.delete(PDFLib.PDFName.of("Metadata"));

    if (keepTitle && title) doc.setTitle(title);

    const bytes = await doc.save();
    const removed = countExposed(before) - (keepTitle && before.title ? 1 : 0);

    send({ type: "done", id, data: bytes.buffer, size: bytes.length, removed },
         [bytes.buffer]);
  } catch (err) {
    const enc = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message));
    send({ type: "error", id: d.id,
           message: enc ? "This PDF is password-protected — unlock it first."
                        : (err?.message || String(err)) });
  }
};