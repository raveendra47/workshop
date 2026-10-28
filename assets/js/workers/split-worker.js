// Classic worker — pdf-lib + fflate load via importScripts (UMD builds).
importScripts("../../vendor/pdf-lib.min.js");
importScripts("../../vendor/fflate.min.js");

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

    const { id, data, filePages, fileNames, wantFiles } = d;
    const src = await PDFLib.PDFDocument.load(data);

    const total = filePages.reduce((s, pages) => s + pages.length, 0);
    send({ type: "start", total });

    let donePages = 0;
    const entries = {};
    const small = [];
    let single = null;

    for (let i = 0; i < filePages.length; i++) {
      const out = await PDFLib.PDFDocument.create();
      for (const p of filePages[i]) {
        const [pg] = await out.copyPages(src, [p - 1]);
        out.addPage(pg);
        donePages++;
        send({ type: "progress", page: donePages, total });
      }
      const bytes = await out.save();
      if (filePages.length === 1) {
        single = { name: fileNames[0], bytes };
      } else {
        entries[fileNames[i]] = bytes;
        if (wantFiles) small.push({ name: fileNames[i], bytes });
      }
    }

    if (single) {
      send({ type: "done", id, count: 1, size: single.bytes.length,
             files: [{ name: single.name, bytes: single.bytes }] },
            [single.bytes.buffer]);
      return;
    }

    const zip = fflate.zipSync(entries, { level: 0 }); // PDFs already compressed — store, don't re-deflate
    send({ type: "done", id, count: filePages.length, size: zip.length,
           zip: zip.buffer, files: wantFiles ? small : undefined },
          [zip.buffer, ...small.map((f) => f.bytes.buffer)]);
  } catch (err) {
    const enc = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message));
    send({ type: "error", id: d.id,
           message: enc ? "This PDF is password-protected — unlock it first."
                        : (err?.message || String(err)) });
  }
};