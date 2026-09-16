// ---- Upload widget ----
export function initUpload(zone, onFiles) {
  const input = zone.querySelector("input[type=file]");
  input.addEventListener("change", () => { onFiles([...input.files]); input.value = ""; });
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    onFiles([...e.dataTransfer.files]);
  });
}

// ---- Download helper ----
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---- Formatting ----
export const formatBytes = (n) =>
  n < 1024 ? `${n} B`
  : n < 1048576 ? `${(n / 1024).toFixed(1)} KB`
  : `${(n / 1048576).toFixed(1)} MB`;

// ---- History (IndexedDB, local-only) ----
let dbPromise = null;
function historyDB() {
  dbPromise ??= idb.openDB("pdf-tools", 1, {
    upgrade(db) {
      db.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
    },
  });
  return dbPromise;
}

const MAX_ENTRIES = 500; // metadata-only entries (~200 B each) — cap is hygiene, not necessity

export async function logHistoryEntry({ tool, filename, inSize, outSize, note = "" }) {
  const db = await historyDB();
  await db.add("entries", { tool, filename, inSize, outSize, note, ts: Date.now() });

  // Evict oldest past the cap.
  const all = await db.getAll("entries");
  if (all.length > MAX_ENTRIES) {
    all.sort((a, b) => a.ts - b.ts);
    for (const e of all.slice(0, all.length - MAX_ENTRIES)) {
      await db.delete("entries", e.id);
    }
  }
}

export async function getHistoryEntries() {
  const db = await historyDB();
  const all = await db.getAll("entries");
  return all.sort((a, b) => b.ts - a.ts); // newest first
}

export async function deleteHistoryEntry(id) {
  const db = await historyDB();
  await db.delete("entries", id);
}

export async function clearHistory() {
  const db = await historyDB();
  await db.clear("entries");
}