// Classic worker - pdf-lib UMD loads via importScripts (no import.meta in UMD builds).
importScripts(new URL("../../vendor/pdf-lib.min.js", import.meta.url).href);

const send = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  if (e.data?.type !== "run") return;
  const { id, buffers, names } = e.data;
  try {
    // Pass 1: load all documents, count pages (this gives us the "of N" upfront)
    const docs = [];
    let total = 0;
    for (let i = 0; i < buffers.length; i++) {
      try {
        const src = await PDFLib.PDFDocument.load(buffers[i]);
        docs.push({ name: names[i], src, pageCount: src.getPageCount() });
        total += src.getPageCount();
      } catch (err) {
        const enc = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message));
        throw new Error(enc
          ? `"${names[i]}" is password-protected — unlock it first.`
          : `Could not read "${names[i]}": ${err?.message || err}`);
      }
    }
    send({ type: "start", total });

    // Pass 2: copy page by page, reporting after every page (real-time bar)
    const out = await PDFLib.PDFDocument.create();
    let done = 0;
    for (const doc of docs) {
      for (let i = 0; i < doc.pageCount; i++) {
        const [p] = await out.copyPages(doc.src, [i]);
        out.addPage(p);
        done++;
        send({ type: "progress", page: done, total });
      }
    }

    const bytes = await out.save();
    send({ type: "done", id, data: bytes.buffer, size: bytes.length, pages: total }, [bytes.buffer]);
  } catch (err) {
    send({ type: "error", id, message: err?.message || String(err) });
  }
};