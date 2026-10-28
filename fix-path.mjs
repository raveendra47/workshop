// fix-paths.mjs — one-shot fixer for hosting Eleventy under a subpath (/workshop/)
// Run from the project root:  node fix-paths.mjs
// Safe to run twice (idempotent).
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";

let changes = 0;

const walk = (dir, ext, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, acc);
    else if (e.name.endsWith(ext)) acc.push(p);
  }
  return acc;
};

const toPosix = (s) => s.split("\\").join("/");

// relative path from the current file's folder to "/assets/<target>",
// preserving a trailing slash (pdf.js cMapUrl needs it)
const relTo = (fromDir, target) => {
  const trail = target.endsWith("/") ? "/" : "";
  let rel = toPosix(relative(fromDir, join("assets", target)));
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel + trail;
};

const edit = (p, fn) => {
  const before = readFileSync(p, "utf8");
  const after = fn(before, p);
  if (after !== before) {
    writeFileSync(p, after);
    changes++;
    console.log("fixed:", p);
  }
};

// ---------- 1) Nunjucks templates: absolute href/src -> Eleventy url filter ----------
for (const f of walk("src", ".njk")) {
  edit(f, (c) => c.replace(/(href|src)="\/([^"]*)"/g, '$1="{{ \'/$2\' | url }}"'));
}

// ---------- 2) CSS: url("/assets/...") -> relative to the css file itself ----------
for (const f of walk("assets", ".css")) {
  edit(f, (c) => c.replace(/url\(\s*["']\/assets\/([^"')]+)["']\s*\)/g, 'url("$1")'));
}

// ---------- 3) JS ----------
for (const f of walk("assets", ".js")) {
  edit(f, (c, p) => {
    const dir = dirname(p);

    // 3a) module imports:  import ... from "/assets/..."   |   import("/assets/...")
    //     -> relative specifier (modules resolve relative to their own file)
    c = c.replace(
      /(from\s*|import\s*\(\s*|import\s+)(["'])\/assets\/([^"']+)\2/g,
      (m, pre, q, target) => `${pre}${q}${relTo(dir, target)}${q}`
    );

    // 3b) runtime strings (new Worker, fetch, workerSrc, cMapUrl, standardFontDataUrl ...)
    //     -> absolute URL built from the module's own location
    c = c.replace(
      /(["'])\/assets\/([^"']+)\1/g,
      (m, q, target) => `new URL("${relTo(dir, target)}", import.meta.url).href`
    );
    return c;
  });
}

// ---------- 4) self-check ----------
let leftovers = 0;
for (const f of [...walk("src", ".njk"), ...walk("assets", ".js"), ...walk("assets", ".css")]) {
  let c = readFileSync(f, "utf8");
  if (f.endsWith(".njk")) c = c.replace(/\{\{[\s\S]*?\}\}/g, ""); // ignore Eleventy filter args
  const bad = c.match(/(href|src)="\/[^"]|["']\/assets\/|url\(\s*["']\/assets\//g);
  if (bad) {
    leftovers++;
    console.log("REMAINING ABSOLUTE PATHS in", f);
  }
}

console.log(`\ndone: ${changes} file(s) changed`);
if (leftovers === 0) console.log("self-check: no absolute /-paths left in src/, assets/js, assets/css");
else console.log(`self-check: ${leftovers} file(s) still contain absolute paths — send those to me`);