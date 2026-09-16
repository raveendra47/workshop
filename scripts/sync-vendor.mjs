// Copies browser-ready files from node_modules into /assets.
import { copyFile, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const V = "assets/vendor";
const W = "assets/wasm";
let ok = 0, missing = 0;

async function file(src, dest) {
  const s = `node_modules/${src}`;
  if (!existsSync(s)) { console.warn(`MISSING: ${s}`); missing++; return; }
  await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  await copyFile(s, dest); ok++;
  console.log(`copied  ${dest}`);
}
async function dir(src, dest) {
  const s = `node_modules/${src}`;
  if (!existsSync(s)) { console.warn(`MISSING DIR: ${s}`); missing++; return; }
  await cp(s, dest, { recursive: true }); ok++;
  console.log(`copied  ${dest}/`);
}

await mkdir(V, { recursive: true });
await mkdir(W, { recursive: true });

// core libs
await file("pdf-lib/dist/pdf-lib.min.js",       `${V}/pdf-lib.min.js`);
await file("sortablejs/Sortable.min.js",        `${V}/Sortable.min.js`);
await file("idb/build/umd.js", `${V}/idb.min.js`);
await file("fflate/umd/index.js",               `${V}/fflate.min.js`); // global: fflate

// pdf.js v3 (UMD) + support files needed for text extraction & odd fonts
await file("pdfjs-dist/build/pdf.min.js",         `${V}/pdf.min.js`);
await file("pdfjs-dist/build/pdf.worker.min.js",  `${V}/pdf.worker.min.js`);
await dir ("pdfjs-dist/cmaps",                    `${V}/cmaps`);
await dir ("pdfjs-dist/standard_fonts",           `${V}/standard_fonts`);

// tesseract: js + its worker + the core wasm files (easy to miss!)
await file("tesseract.js/dist/tesseract.min.js",     `${V}/tesseract.min.js`);
await file("tesseract.js/dist/worker.min.js",        `${V}/tesseract.worker.min.js`);
await dir ("tesseract.js-core",                      `${W}/tesseract-core`);

// WASM packages — copy whole dist folders (filenames vary between versions)
await dir("@okathira/ghostpdl-wasm/dist", `${W}/ghostscript`);
await file("@jspawn/qpdf-wasm/qpdf.js",   `${W}/qpdf/qpdf.js`);
await file("@jspawn/qpdf-wasm/qpdf.wasm", `${W}/qpdf/qpdf.wasm`);

console.log(`\nsync finished: ${ok} copied, ${missing} missing`);
if (missing) console.log("→ open the missing package folder in node_modules and fix the path above.");