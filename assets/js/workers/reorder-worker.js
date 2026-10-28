// Classic worker — rebuilds the PDF in the submitted page order.
importScripts(new URL("../../vendor/pdf-lib.min.js", import.meta.url).href);

const send = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    if (d.type !== "run") return;
    const { id, data, order } = d;
    const src = await PDFLib.PDFDocument.load(data);
    const n = src.getPageCount();

    // Validate: order must be a permutation of 1..n
    if (!Array.isArray(order) || order.length !== n ||
        new Set(order).size !== n || order.some((p) => !Number.isInteger(p) || p < 1 || p > n)) {
      throw new Error("Page order is not a valid permutation of the document's pages.");
    }

    send({ type: "start", total: n });
    const out = await PDFLib.PDFDocument.create();
    for (let i = 0; i < n; i++) {
      const [pg] = await out.copyPages(src, [order[i] - 1]);
      out.addPage(pg);
      send({ type: "progress", page: i + 1, total: n });
    }
    const bytes = await out.save();
    send({ type: "done", id, data: bytes.buffer, size: bytes.length }, [bytes.buffer]);
  } catch (err) {
    const enc = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message));
    send({ type: "error", id: d.id,
           message: enc ? "This PDF is password-protected — unlock it first."
                        : (err?.message || String(err)) });
  }
};