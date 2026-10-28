import { getHistoryEntries, deleteHistoryEntry, clearHistory, formatBytes } from "./shared.js";

const filterRow = document.getElementById("filter-row");
const entriesEl = document.getElementById("entries");
const emptyEl = document.getElementById("empty");
const clearBtn = document.getElementById("clear-btn");

let all = [];
let activeFilter = "all";

const relTime = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
};

function renderFilters() {
  const tools = [...new Set(all.map((e) => e.tool))].sort();
  const pills = [["all", `All (${all.length})`],
                 ...tools.map((t) => [t, `${t} (${all.filter((e) => e.tool === t).length})`])];
  filterRow.textContent = "";
  for (const [value, label] of pills) {
    const lab = document.createElement("label");
    lab.className = "preset-pill";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "history-filter";
    input.value = value;
    input.checked = value === activeFilter;
    const span = document.createElement("span");
    span.textContent = label;
    input.addEventListener("change", () => { activeFilter = value; renderEntries(); });
    lab.append(input, span);
    filterRow.append(lab);
  }
}

function renderEntries() {
  entriesEl.textContent = "";
  const list = activeFilter === "all" ? all : all.filter((e) => e.tool === activeFilter);
  emptyEl.hidden = list.length > 0;
  clearBtn.hidden = all.length === 0;
  resetClearBtn();

  for (const e of list) {
    const row = document.createElement("div");
    row.className = "file-row history-row";

    const main = document.createElement("span");
    const badge = document.createElement("span");
    badge.className = "badge same tool-badge";
    badge.textContent = e.tool;
    const name = document.createElement("span");
    name.className = "history-name";
    name.textContent = e.filename;
    name.title = e.filename;
    const meta = document.createElement("span");
    meta.className = "history-meta";
    const sizes = e.inSize != null && e.outSize != null
      ? `${formatBytes(e.inSize)} → ${formatBytes(e.outSize)} · ` : "";
    meta.textContent = `${sizes}${relTime(e.ts)}${e.note ? ` · ${e.note}` : ""}`;
    meta.title = new Date(e.ts).toLocaleString();
    main.append(badge, name, meta);

    const controls = document.createElement("span");
    controls.className = "row-controls";
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "✕";
    del.title = "Delete this entry";
    del.setAttribute("aria-label", "Delete this entry");
    del.addEventListener("click", async () => {
      await deleteHistoryEntry(e.id);
      all = all.filter((x) => x.id !== e.id);
      renderFilters();
      renderEntries();
    });
    controls.append(del);

    row.append(main, controls);
    entriesEl.append(row);
  }
}

// Clear-all: two-step confirm, no native dialogs.
let clearArmed = false, clearTimer = null;
function resetClearBtn() {
  clearArmed = false;
  clearTimeout(clearTimer);
  clearBtn.textContent = "Clear all";
}
clearBtn.addEventListener("click", async () => {
  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = "Really wipe everything?";
    clearTimer = setTimeout(resetClearBtn, 4000);
    return;
  }
  await clearHistory();
  all = [];
  activeFilter = "all";
  renderFilters();
  renderEntries();
});

(async () => {
  all = await getHistoryEntries();
  renderFilters();
  renderEntries();
})();