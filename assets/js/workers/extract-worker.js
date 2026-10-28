// Classic worker — shared by Extract and Remove pages.
// Payload in: { type: "probe" | "run", ... }
// run: { id, data, pages: [1-based page numbers to KEEP, in output order] }
importScripts("../../vendor/pdf-lib.min.js");

const send = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    if (d.type === "probe") {
      const src = await PDFLib.PDFDocument.load(d.data);
      send({ type: "probe", pageCount: src.getPageCount() });
      return;
    }
    if (d.type !== "run") return;

    const { id, data, pages } = d;
    const src = await PDFLib.PDFDocument.load(data);
    const total = pages.length;
    send({ type: "start", total });

    const out = await PDFLib.PDFDocument.create();
    for (let i = 0; i < total; i++) {
      const [pg] = await out.copyPages(src, [pages[i] - 1]);
      out.addPage(pg);
      send({ type: "progress", page: i + 1, total });
    }
    const bytes = await out.save();

    send({ type: "done", id, data: bytes.buffer, size: bytes.length, count: total },
         [bytes.buffer]);
  } catch (err) {
    const enc = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message));
    send({ type: "error", id: d.id,
           message: enc ? "This PDF is password-protected — unlock it first."
                        : (err?.message || String(err)) });
  }
};