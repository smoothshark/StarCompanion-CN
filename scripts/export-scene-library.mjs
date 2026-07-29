#!/usr/bin/env node
/**
 * 从构造工具 HTML 导出 DEFAULT_SCENE_LIBRARY → data/scenes/scene_library.json
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "app", "index.html");
const outPath = path.join(root, "data", "scenes", "scene_library.json");

const html = fs.readFileSync(htmlPath, "utf8");
const dataMatch = html.match(/id="sceneLibraryData"[^>]*>([\s\S]*?)<\/script>/);
if (!dataMatch) {
  throw new Error("未找到 sceneLibraryData");
}

const start = html.indexOf("const EXPANDED_AGE_SCOPES");
const endMarker = html.indexOf("const DEFAULT_SCENE_LIBRARY =");
if (start < 0 || endMarker < 0) {
  throw new Error("未找到选题库定义片段");
}
const endLine = html.indexOf("\n", endMarker);
const code = html.slice(start, endLine);

const sandbox = {
  document: {
    getElementById: (id) =>
      id === "sceneLibraryData" ? { textContent: dataMatch[1] } : null,
  },
  console,
  JSON,
};
vm.createContext(sandbox);
vm.runInContext(
  `${code}\n;this.__OUT = DEFAULT_SCENE_LIBRARY;`,
  sandbox,
);

const lib = sandbox.__OUT;
if (!Array.isArray(lib) || !lib.length) {
  throw new Error("导出结果为空");
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(lib, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      outputPath: outPath,
      count: lib.length,
      bytes: Buffer.byteLength(JSON.stringify(lib)),
    },
    null,
    2,
  ),
);
