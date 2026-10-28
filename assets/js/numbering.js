import { initStampTool } from "./shared-stamp.js";

initStampTool({
  tool: "numbering",
  outSuffix: "_numbered.pdf",
  specBuilder() {
    const fmt = document.getElementById("fmt").value.trim();
    if (!fmt) throw new Error("Enter a format, e.g. Page {n} of {total}");
    const start = Math.max(1, Math.floor(Number(document.getElementById("start").value) || 1));
    const fontSize = Number(document.getElementById("size").value) || 10;
    const position = document.querySelector("input[name=pos]:checked").value;
    return {
      text: { text: fmt, fontSize, colorRGB: [0.15, 0.13, 0.1], opacity: 0.9, angle: 0 },
      position, margin: 18,
      numbering: { start },
    };
  },
  note: () => document.getElementById("fmt").value,
});