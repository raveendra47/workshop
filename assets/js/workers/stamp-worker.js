// Classic worker — shared by Numbering and Watermark.
// spec.text  = { text, fontSize, colorRGB:[r,g,b], opacity, angle }  + fontBytes (TTF)
// spec.image = { scalePct, opacity, angle }  + imageBytes (PNG/JPEG bytes)
// spec.numbering = { start } → enables {n}/{total}/{page} substitution
// spec.position = tl|tc|tr|ml|mc|mr|bl|bc|br   spec.margin (pts)   spec.pages (1-based, optional)
importScripts("../../vendor/pdf-lib.min.js");
importScripts("../../vendor/fontkit.umd.min.js");

const send = (msg, transfer) => self.postMessage(msg, transfer || []);
const POS = {
  tl: [0, 1], tc: [0.5, 1], tr: [1, 1],
  ml: [0, 0.5], mc: [0.5, 0.5], mr: [1, 0.5],
  bl: [0, 0], bc: [0.5, 0], br: [1, 0],
};

self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    if (d.type === "probe") {
      const src = await PDFLib.PDFDocument.load(d.data);
      send({ type: "probe", pageCount: src.getPageCount() });
      return;
    }
    if (d.type !== "run") return;

    const { id, data, spec, fontBytes, imageBytes } = d;
    const src = await PDFLib.PDFDocument.load(data);
    const pages = src.getPages();
    send({ type: "start", total: pages.length });


    let font = null;
    let img = null;
    if (spec.text) {
      src.registerFontkit(self.fontkit);
      font = await src.embedFont(fontBytes, { subset: true });
    } else {
      img = await src.embedPng(imageBytes).catch(() => src.embedJpg(imageBytes));
    }

    const numberingTotal = pages.length;
    const targets = spec.pages ? new Set(spec.pages) : null;
    let done = 0;

    for (let i = 0; i < pages.length; i++) {
      if (targets && !targets.has(i + 1)) continue;
      const page = pages[i];
      const { width: W, height: H } = page.getSize();
      const fx = (POS[spec.position] || POS.br)[0];
      const fy = (POS[spec.position] || POS.br)[1];
      const m = spec.margin || 0;

      if (spec.text) {
        const { text, fontSize, colorRGB, opacity, angle } = spec.text;
        let finalText = text;
        if (spec.numbering) {
          const label = (spec.numbering.start || 1) + i;   // displayed number, respects start-at
          finalText = text
            .replaceAll("{n}", String(label))
            .replaceAll("{total}", String(numberingTotal))
            .replaceAll("{page}", String(i + 1));
        }
        const w = font.widthOfTextAtSize(finalText, fontSize);
        const h = font.heightAtSize(fontSize);
        const x = fx * (W - w) + (fx === 0 ? m : fx === 1 ? -m : 0);
        const y = fy === 0 ? m : fy === 1 ? H - h - m : (H - h) / 2;
        page.drawText(finalText, {
          x, y, size: fontSize, font,
          color: PDFLib.rgb(colorRGB[0], colorRGB[1], colorRGB[2]),
          opacity,
          rotate: PDFLib.degrees(angle || 0),
        });
      } else {
        const dims = img.scale(spec.image.scalePct / 100);
        const x = fx * (W - dims.width) + (fx === 0 ? m : fx === 1 ? -m : 0);
        const y = fy === 0 ? m : fy === 1 ? H - dims.height - m : (H - dims.height) / 2;
        page.drawImage(img, {
          x, y, width: dims.width, height: dims.height,
          opacity: spec.image.opacity,
          rotate: PDFLib.degrees(spec.image.angle || 0),
        });
      }

      done++;
      send({ type: "progress", page: done, total: pages.length });
    }

    const bytes = await src.save();
    send({ type: "done", id, data: bytes.buffer, size: bytes.length, stamped: done }, [bytes.buffer]);
  } catch (err) {
    const enc = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message));
    send({ type: "error", id: d.id,
           message: enc ? "This PDF is password-protected — unlock it first."
                        : (err?.message || String(err)) });
  }
};