// Classic worker — rotation is metadata-only: lossless and instant.
importScripts("../../vendor/pdf-lib.min.js");

const send = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    if (d.type === "probe") {
      const src = await PDFLib.PDFDocument.load(d.data);
      const pages = src.getPages();
      const baked = pages.filter((p) => (p.getRotation().angle || 0) % 360 !== 0).length;
      send({ type: "probe", pageCount: pages.length, baked });
      return;
    }
    if (d.type !== "run") return;

    const { id, data, deltas } = d;
    const src = await PDFLib.PDFDocument.load(data);
    const pages = src.getPages();
    const total = pages.length;
    send({ type: "start", total });

    let changed = 0;
    for (let i = 0; i < total; i++) {
      const delta = deltas[i] || 0;
      if (delta !== 0) {
        const cur = (pages[i].getRotation().angle || 0) % 360;
        let target = (cur + delta) % 360;
        if (target < 0) target += 360;
        pages[i].setRotation(PDFLib.degrees(target));
        changed++;
      }
      send({ type: "progress", page: i + 1, total });
    }

    const bytes = await src.save();
    send({ type: "done", id, data: bytes.buffer, size: bytes.length, changed },
         [bytes.buffer]);
  } catch (err) {
    const enc = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message));
    send({ type: "error", id: d.id,
           message: enc ? "This PDF is password-protected — unlock it first."
                        : (err?.message || String(err)) });
  }
};