#!/usr/bin/env node
/**
 * 本地/服务器协作服务：托管构造台，并把场景、卡片和版本记录写入 SQLite。
 *
 *   node scripts/dev-server.mjs
 *   浏览器打开 http://127.0.0.1:8787/
 *
 * 服务器部署可设置：
 *   HOST=0.0.0.0 PORT=8787 AUTHORING_DB_PATH=/srv/starcompanion/authoring.sqlite node scripts/dev-server.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteStore } from "./lib/sqlite-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const SCENE_PATH = path.join(root, "data", "scenes", "scene_library.json");
const PREGENERATED_PATH = path.join(root, "app", "assets", "pending-review.generated.js");
const DB_PATH = path.resolve(process.env.AUTHORING_DB_PATH || path.join(root, "workspace", "authoring.sqlite"));
const APP_DIR = "app";
const APP_HTML = "index.html";
const store = createSqliteStore({
  dbPath: DB_PATH,
  root,
  scenePath: SCENE_PATH,
  pregeneratedPath: PREGENERATED_PATH,
});

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

function readJsonRequest(text) {
  try {
    return { ok: true, value: JSON.parse(text || "null") };
  } catch {
    return { ok: false, error: "JSON 解析失败" };
  }
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

function writeSceneLibrary(payload) {
  const scenes = Array.isArray(payload) ? payload : payload?.scenes;
  if (!Array.isArray(scenes)) {
    throw new Error("请求体需为场景数组，或包含 scenes 数组的对象");
  }
  const editorName = payload?.editorName || payload?.actor || "unknown";
  const deletedDefaultSceneIds = Array.isArray(payload?.deletedDefaultSceneIds)
    ? payload.deletedDefaultSceneIds
    : [];
  return store.replaceScenes(scenes, {
    editorName,
    action: payload?.action || "replace",
    deletedDefaultSceneIds,
  });
}

function recordKeyFromRequest(url, payload = null) {
  return String(
    url.searchParams.get("recordKey")
      || payload?.recordKey
      || "",
  ).trim();
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    const stats = store.stats();
    return sendJson(res, 200, {
      ok: true,
      storage: "sqlite",
      dbPath: path.relative(root, DB_PATH),
      sceneSeedPath: path.relative(root, SCENE_PATH),
      pregeneratedSeedPath: path.relative(root, PREGENERATED_PATH),
      ...stats,
    });
  }

  if (url.pathname === "/api/scenes") {
    if (req.method === "GET") {
      const data = store.listScenes();
      return sendJson(res, 200, data);
    }
    if (req.method === "PUT" || req.method === "POST") {
      const text = await readBody(req);
      const parsed = readJsonRequest(text);
      if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
      try {
        const result = writeSceneLibrary(parsed.value);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 400, { error: error.message || String(error) });
      }
    }
    res.writeHead(405, { Allow: "GET, PUT, POST" });
    return res.end();
  }

  if (url.pathname === "/api/workspace") {
    if (req.method === "GET") {
      return sendJson(res, 200, store.listRecords());
    }
    res.writeHead(405, { Allow: "GET" });
    return res.end();
  }

  if (url.pathname === "/api/workspace-record") {
    if (req.method === "GET") {
      const recordKey = recordKeyFromRequest(url);
      if (!recordKey) return sendJson(res, 400, { error: "缺少 recordKey" });
      const record = store.getRecord(recordKey);
      return sendJson(res, record ? 200 : 404, record ? { recordKey, record } : { error: "not found" });
    }

    if (req.method === "PUT" || req.method === "POST") {
      const text = await readBody(req);
      const parsed = readJsonRequest(text);
      if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
      const payload = parsed.value || {};
      const recordKey = recordKeyFromRequest(url, payload);
      if (!recordKey) return sendJson(res, 400, { error: "缺少 recordKey" });
      try {
        const result = store.upsertRecord(recordKey, payload.record, {
          editorName: payload.editorName,
          action: payload.action || "save",
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { error: error.message || String(error) });
      }
    }

    if (req.method === "DELETE") {
      let payload = {};
      if (req.headers["content-length"] !== "0") {
        const text = await readBody(req);
        const parsed = readJsonRequest(text);
        if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
        payload = parsed.value || {};
      }
      const recordKey = recordKeyFromRequest(url, payload);
      if (!recordKey) return sendJson(res, 400, { error: "缺少 recordKey" });
      try {
        const result = store.deleteRecord(recordKey, {
          editorName: payload.editorName,
          action: payload.action || "delete",
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { error: error.message || String(error) });
      }
    }

    res.writeHead(405, { Allow: "GET, PUT, POST, DELETE" });
    return res.end();
  }

  if (url.pathname === "/api/versions") {
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      return res.end();
    }
    const entityType = url.searchParams.get("entityType") || "record";
    const entityKey = url.searchParams.get("entityKey") || "";
    if (!entityKey) return sendJson(res, 400, { error: "缺少 entityKey" });
    return sendJson(res, 200, {
      versions: store.listVersions({
        entityType,
        entityKey,
        limit: url.searchParams.get("limit") || 50,
      }),
    });
  }

  const versionMatch = url.pathname.match(/^\/api\/versions\/(\d+)$/u);
  if (versionMatch) {
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      return res.end();
    }
    const version = store.getVersion(versionMatch[1]);
    return sendJson(res, version ? 200 : 404, version || { error: "not found" });
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
  console.log(`  数据库: ${path.relative(root, DB_PATH)}`);
  console.log(`  API:    GET/PUT http://${HOST}:${PORT}/api/scenes`);
  console.log(`          GET/PUT/DELETE http://${HOST}:${PORT}/api/workspace-record`);
});
