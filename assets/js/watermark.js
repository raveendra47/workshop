import { initStampTool } from "./shared-stamp.js";

const typeInputs = document.querySelectorAll("input[name=wm-type]");
typeInputs.forEach((r) => r.addEventListener("change", () => {
  const v = document.querySelector("input[name=wm-type]:checked").value;
  document.getElementById("wm-text-controls").hidden = v !== "text";
  document.getElementById("wm-image-controls").hidden = v !== "image";
}));

let imageBytes = null;
const imgInput = document.getElementById("wm-img");
if (imgInput) {
  imgInput.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) { imageBytes = null; return; }
    imageBytes = await f.arrayBuffer();
  });
}

initStampTool({
  tool: "watermark",
  outSuffix: "_watermarked.pdf",
  specBuilder() {
    const type = document.querySelector("input[name=wm-type]:checked").value;
    const position = document.querySelector("input[name=pos]:checked").value;
    const opacity = Math.min(1, Math.max(0.05, Number(document.getElementById("wm-opacity").value) / 100));

    if (type === "text") {
      const text = document.getElementById("wm-text").value.trim();
      if (!text) throw new Error("Enter watermark text (or switch to Image type)");
      return {
        text: {
          text,
          fontSize: Number(document.getElementById("wm-size").value) || 48,
          colorRGB: [0.55, 0.55, 0.55],
          opacity, angle: Number(document.getElementById("wm-angle").value) || 0,
        },
        position, margin: 0,
      };
    }

    if (!imageBytes) throw new Error("Choose an image first (or switch to Text type)");
    return {
      image: {
        scalePct: Number(document.getElementById("wm-scale").value) || 30,
        opacity, angle: 0,
      },
      imageBytes, position, margin: 0,
    };
  },
  note: () => {
    const type = document.querySelector("input[name=wm-type]:checked").value;
    return type === "text" ? document.getElementById("wm-text").value : "image";
  },
});