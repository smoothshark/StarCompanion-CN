import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const VALID_STATUSES = new Set(["draft", "pending_review", "completed"]);
const DEFAULT_EDITOR = "system";

function nowIso() {
  return new Date().toISOString();
}

function parseJsonText(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function parsePregeneratedWorkspace(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, "utf8");
  const match = text.match(/window\.A1_PREGENERATED_WORKSPACE\s*=\s*(\{[\s\S]*\});?\s*$/u);
  if (!match) return {};
  const parsed = parseJsonText(match[1], {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

function readSceneSeed(scenePath) {
  if (!fs.existsSync(scenePath)) return [];
  const parsed = parseJsonText(fs.readFileSync(scenePath, "utf8"), []);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.scenes)) return parsed.scenes;
  return [];
}

function recordKeyParts(recordKey, record = null) {
  const [ageBand, sceneId] = String(recordKey || "").split("::");
  return {
    ageBand: record?.ageBand || record?.sample?.age_band || ageBand || "",
    sceneId: record?.sceneId || sceneId || "",
  };
}

function normalizeEditorName(editorName) {
  const trimmed = String(editorName || "").trim();
  if (!trimmed) return "";
  return trimmed.slice(0, 64);
}

function normalizeRecord(recordKey, record) {
  if (!record || typeof record !== "object") {
    throw new Error("记录 payload 必须是对象");
  }
  const parts = recordKeyParts(recordKey, record);
  if (!parts.sceneId || !parts.ageBand) {
    throw new Error("recordKey 需要采用 ageBand::sceneId 格式");
  }
  const status = VALID_STATUSES.has(record.status) ? record.status : "draft";
  const updatedAt = record.updatedAt || nowIso();
  return {
    ...record,
    status,
    updatedAt,
    sceneId: parts.sceneId,
    ageBand: parts.ageBand,
  };
}

export function createSqliteStore({ dbPath, root, scenePath, pregeneratedPath }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS records (
      record_key TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL,
      age_band TEXT NOT NULL,
      status TEXT NOT NULL,
      sample_id TEXT,
      source TEXT,
      model TEXT,
      generated_at TEXT,
      human_confirmed_at TEXT,
      confirmation_source TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_records_scene_age ON records(scene_id, age_band);
    CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
    CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records(updated_at);

    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT,
      editor_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_versions_entity ON versions(entity_type, entity_key, id DESC);
  `);

  const getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMetaStmt = db.prepare(`
    INSERT INTO meta(key, value)
    VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const countScenesStmt = db.prepare("SELECT COUNT(*) AS count FROM scenes");
  const countRecordsStmt = db.prepare("SELECT COUNT(*) AS count FROM records");
  const insertSceneStmt = db.prepare(`
    INSERT INTO scenes(id, payload, created_at, updated_at, updated_by)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `);
  const deleteScenesNotInStmt = db.prepare("DELETE FROM scenes WHERE id NOT IN (SELECT value FROM json_each(?))");
  const deleteAllScenesStmt = db.prepare("DELETE FROM scenes");
  const selectScenesStmt = db.prepare("SELECT payload FROM scenes ORDER BY id");
  const upsertRecordStmt = db.prepare(`
    INSERT INTO records(
      record_key, scene_id, age_band, status, sample_id, source, model, generated_at,
      human_confirmed_at, confirmation_source, payload, created_at, updated_at, updated_by
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_key) DO UPDATE SET
      scene_id = excluded.scene_id,
      age_band = excluded.age_band,
      status = excluded.status,
      sample_id = excluded.sample_id,
      source = excluded.source,
      model = excluded.model,
      generated_at = excluded.generated_at,
      human_confirmed_at = excluded.human_confirmed_at,
      confirmation_source = excluded.confirmation_source,
      payload = excluded.payload,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `);
  const getRecordStmt = db.prepare("SELECT payload FROM records WHERE record_key = ?");
  const deleteRecordStmt = db.prepare("DELETE FROM records WHERE record_key = ?");
  const selectRecordsStmt = db.prepare("SELECT record_key, payload FROM records ORDER BY record_key");
  const insertVersionStmt = db.prepare(`
    INSERT INTO versions(entity_type, entity_key, action, status, editor_name, created_at, payload)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `);
  const selectVersionsStmt = db.prepare(`
    SELECT id, entity_type AS entityType, entity_key AS entityKey, action, status,
      editor_name AS editorName, created_at AS createdAt
    FROM versions
    WHERE entity_type = ? AND entity_key = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const getVersionStmt = db.prepare(`
    SELECT id, entity_type AS entityType, entity_key AS entityKey, action, status,
      editor_name AS editorName, created_at AS createdAt, payload
    FROM versions
    WHERE id = ?
  `);

  function runTransaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  function getMeta(key, fallback = null) {
    return getMetaStmt.get(key)?.value ?? fallback;
  }

  function setMeta(key, value) {
    setMetaStmt.run(key, String(value));
  }

  function appendVersion({ entityType, entityKey, action, status = null, editorName = DEFAULT_EDITOR, payload }) {
    insertVersionStmt.run(
      entityType,
      entityKey,
      action,
      status,
      normalizeEditorName(editorName) || DEFAULT_EDITOR,
      nowIso(),
      JSON.stringify(payload),
    );
  }

  function replaceScenes(scenes, { editorName = DEFAULT_EDITOR, action = "replace", deletedDefaultSceneIds = [] } = {}) {
    if (!Array.isArray(scenes)) throw new Error("scenes 必须是数组");
    const changedAt = nowIso();
    const ids = [];
    runTransaction(() => {
      if (!scenes.length) deleteAllScenesStmt.run();
      for (const scene of scenes) {
        const id = String(scene?.id || "").trim();
        if (!id) throw new Error("场景缺少 id");
        ids.push(id);
        insertSceneStmt.run(
          id,
          JSON.stringify(scene),
          changedAt,
          changedAt,
          normalizeEditorName(editorName) || DEFAULT_EDITOR,
        );
      }
      if (scenes.length) deleteScenesNotInStmt.run(JSON.stringify(ids));
      setMeta("deletedDefaultSceneIds", JSON.stringify(deletedDefaultSceneIds));
      appendVersion({
        entityType: "scene_library",
        entityKey: "main",
        action,
        status: null,
        editorName,
        payload: { scenes, deletedDefaultSceneIds },
      });
    });
    return { count: scenes.length, path: path.relative(root, dbPath) };
  }

  function listScenes() {
    const scenes = selectScenesStmt.all()
      .map(row => parseJsonText(row.payload, null))
      .filter(Boolean);
    const deletedDefaultSceneIds = parseJsonText(getMeta("deletedDefaultSceneIds", "[]"), []);
    return {
      version: 1,
      scenes,
      deletedDefaultSceneIds: Array.isArray(deletedDefaultSceneIds) ? deletedDefaultSceneIds : [],
    };
  }

  function upsertRecord(recordKey, record, { editorName = DEFAULT_EDITOR, action = "save" } = {}) {
    const normalized = normalizeRecord(recordKey, record);
    const editor = normalizeEditorName(editorName);
    if (!editor) throw new Error("请先填写修改人名称");
    const existing = getRecord(recordKey);
    const createdAt = existing?.updatedAt || normalized.updatedAt || nowIso();
    const sampleId = normalized.sample?.sample_id || null;
    runTransaction(() => {
      upsertRecordStmt.run(
        recordKey,
        normalized.sceneId,
        normalized.ageBand,
        normalized.status,
        sampleId,
        normalized.source || null,
        normalized.model || null,
        normalized.generatedAt || null,
        normalized.humanConfirmedAt || null,
        normalized.confirmationSource || null,
        JSON.stringify({ ...normalized, updatedBy: editor }),
        createdAt,
        normalized.updatedAt,
        editor,
      );
      appendVersion({
        entityType: "record",
        entityKey: recordKey,
        action,
        status: normalized.status,
        editorName: editor,
        payload: { recordKey, record: { ...normalized, updatedBy: editor } },
      });
    });
    return { ok: true, recordKey, record: { ...normalized, updatedBy: editor } };
  }

  function deleteRecord(recordKey, { editorName = DEFAULT_EDITOR, action = "delete" } = {}) {
    const editor = normalizeEditorName(editorName);
    if (!editor) throw new Error("请先填写修改人名称");
    const existing = getRecord(recordKey);
    runTransaction(() => {
      deleteRecordStmt.run(recordKey);
      appendVersion({
        entityType: "record",
        entityKey: recordKey,
        action,
        status: existing?.status || null,
        editorName: editor,
        payload: { recordKey, deletedRecord: existing },
      });
    });
    return { ok: true, recordKey, deleted: !!existing };
  }

  function getRecord(recordKey) {
    const row = getRecordStmt.get(recordKey);
    return row ? parseJsonText(row.payload, null) : null;
  }

  function listRecords() {
    const records = {};
    for (const row of selectRecordsStmt.all()) {
      const record = parseJsonText(row.payload, null);
      if (record) records[row.record_key] = record;
    }
    return { version: 1, records };
  }

  function listVersions({ entityType, entityKey, limit = 50 }) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return selectVersionsStmt.all(entityType, entityKey, safeLimit);
  }

  function getVersion(id) {
    const row = getVersionStmt.get(Number(id));
    if (!row) return null;
    return {
      ...row,
      payload: parseJsonText(row.payload, null),
    };
  }

  function seedScenesIfEmpty() {
    if (countScenesStmt.get().count > 0) return 0;
    const scenes = readSceneSeed(scenePath);
    if (!scenes.length) return 0;
    replaceScenes(scenes, { editorName: DEFAULT_EDITOR, action: "seed" });
    return scenes.length;
  }

  function seedPregeneratedIfEmpty() {
    if (countRecordsStmt.get().count > 0) return 0;
    const records = parsePregeneratedWorkspace(pregeneratedPath);
    const entries = Object.entries(records);
    if (!entries.length) return 0;
    const changedAt = nowIso();
    runTransaction(() => {
      for (const [recordKey, originalRecord] of entries) {
        const parts = recordKeyParts(recordKey, originalRecord);
        if (!parts.ageBand || !parts.sceneId || !originalRecord?.sample) continue;
        const record = normalizeRecord(recordKey, {
          ...originalRecord,
          status: "pending_review",
          source: originalRecord.source || "ai_batch_external",
          sceneId: parts.sceneId,
          ageBand: parts.ageBand,
          updatedAt: originalRecord.updatedAt || changedAt,
          sample: {
            ...originalRecord.sample,
            authoring: {
              ...originalRecord.sample.authoring,
              review_status: originalRecord.sample.authoring?.review_status || "draft",
            },
          },
          humanConfirmedAt: originalRecord.humanConfirmedAt || null,
          confirmationSource: originalRecord.confirmationSource || null,
        });
        upsertRecordStmt.run(
          recordKey,
          record.sceneId,
          record.ageBand,
          record.status,
          record.sample?.sample_id || null,
          record.source || null,
          record.model || null,
          record.generatedAt || null,
          record.humanConfirmedAt || null,
          record.confirmationSource || null,
          JSON.stringify({ ...record, updatedBy: DEFAULT_EDITOR }),
          record.updatedAt || changedAt,
          record.updatedAt || changedAt,
          DEFAULT_EDITOR,
        );
      }
      appendVersion({
        entityType: "workspace",
        entityKey: "main",
        action: "seed",
        status: "pending_review",
        editorName: DEFAULT_EDITOR,
        payload: { count: entries.length, source: path.relative(root, pregeneratedPath) },
      });
    });
    return entries.length;
  }

  function stats() {
    const sceneCount = countScenesStmt.get().count;
    const recordCount = countRecordsStmt.get().count;
    return { sceneCount, recordCount };
  }

  seedScenesIfEmpty();
  seedPregeneratedIfEmpty();

  return {
    dbPath,
    listScenes,
    replaceScenes,
    listRecords,
    getRecord,
    upsertRecord,
    deleteRecord,
    listVersions,
    getVersion,
    stats,
  };
}
