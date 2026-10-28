// Classic worker - embeds images as pages, in submitted order.
importScripts("../../vendor/pdf-lib.min.js");

const send = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    if (d.type !== "run") return;
    const { id, images } = d;   // images: [{ name, bytes, mime }] - order = page order
    if (!images?.length) throw new Error("No images submitted.");

    const out = await PDFLib.PDFDocument.create();
    send({ type: "start", total: images.length });

    for (let i = 0; i < images.length; i++) {
      const it = images[i];
      let img;
      if (it.mime === "image/png") {
        img = await out.embedPng(it.bytes);
      } else {
        img = await out.embedJpg(it.bytes).catch(() => out.embedPng(it.bytes));
      }
      const page = out.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      send({ type: "progress", page: i + 1, total: images.length });
    }

    const bytes = await out.save();
    send({ type: "done", id, data: bytes.buffer, size: bytes.length, count: images.length },
         [bytes.buffer]);
  } catch (err) {
    send({ type: "error", id: d.id, message: err?.message || String(err) });
  }
};
