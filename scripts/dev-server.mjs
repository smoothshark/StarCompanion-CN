#!/usr/bin/env node
/**
 * 本地开发服务：托管构造台，并把场景库读写落到 data/scenes/scene_library.json
 *
 *   node scripts/dev-server.mjs
 *   浏览器打开 http://127.0.0.1:8787/
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const SCENE_PATH = path.join(root, "data", "scenes", "scene_library.json");
const APP_DIR = "app";
const APP_HTML = "index.html";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  res.writeHead(status, {
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data, null, 2) + "\n", {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const max = 32 * 1024 * 1024;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? path.join(APP_DIR, APP_HTML) : decoded.replace(/^\//, "");
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep) && absolute !== root) {
    return null;
  }
  return absolute;
}

function readSceneFile() {
  if (!fs.existsSync(SCENE_PATH)) {
    return { version: 1, scenes: [], deletedDefaultSceneIds: [] };
  }
  const raw = JSON.parse(fs.readFileSync(SCENE_PATH, "utf8"));
  if (Array.isArray(raw)) {
    return { version: 1, scenes: raw, deletedDefaultSceneIds: [] };
  }
  if (raw && Array.isArray(raw.scenes)) {
    return {
      version: Number(raw.version) || 1,
      scenes: raw.scenes,
      deletedDefaultSceneIds: Array.isArray(raw.deletedDefaultSceneIds)
        ? raw.deletedDefaultSceneIds
        : [],
    };
  }
  throw new Error("scene_library.json 格式无效：需要数组或 { scenes: [] }");
}

function writeSceneFile(payload) {
  const scenes = Array.isArray(payload) ? payload : payload?.scenes;
  if (!Array.isArray(scenes)) {
    throw new Error("请求体需为场景数组，或包含 scenes 数组的对象");
  }
  // 仓库约定：对外文件保持「纯数组」，便于开发者直接读
  fs.mkdirSync(path.dirname(SCENE_PATH), { recursive: true });
  fs.writeFileSync(SCENE_PATH, JSON.stringify(scenes, null, 2) + "\n", "utf8");
  return { count: scenes.length, path: path.relative(root, SCENE_PATH) };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      scenePath: path.relative(root, SCENE_PATH),
      sceneExists: fs.existsSync(SCENE_PATH),
    });
  }

  if (url.pathname === "/api/scenes") {
    if (req.method === "GET") {
      const data = readSceneFile();
      return sendJson(res, 200, data);
    }
    if (req.method === "PUT" || req.method === "POST") {
      const text = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(text || "null");
      } catch {
        return sendJson(res, 400, { error: "JSON 解析失败" });
      }
      try {
        const result = writeSceneFile(payload);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 400, { error: error.message || String(error) });
      }
    }
    res.writeHead(405, { Allow: "GET, PUT, POST" });
    return res.end();
  }

  return sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end();
    }

    const filePath = safeResolve(url.pathname);
    if (!filePath) {
      return send(res, 403, "Forbidden");
    }

    let target = filePath;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, "index.html");
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return send(res, 404, "Not Found");
    }

    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const body = fs.readFileSync(target);
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
      return res.end();
    }
    return send(res, 200, body, { "Content-Type": type });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  const toolUrl = `http://${HOST}:${PORT}/${APP_DIR}/`;
  console.log(`本地服务已启动`);
  console.log(`  构造台: ${toolUrl}`);
  console.log(`  根入口: http://${HOST}:${PORT}/`);
  console.log(`  场景库: ${path.relative(root, SCENE_PATH)}`);
  console.log(`  API:    GET/PUT http://${HOST}:${PORT}/api/scenes`);
});
