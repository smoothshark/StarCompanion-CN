#!/usr/bin/env node
/**
 * Repair cold supporter turns while preserving user turns and authoring.
 *
 * Workflow:
 *   node scripts/repair-supporter-warmth.mjs prepare --batch-count 200
 *   node scripts/repair-supporter-warmth.mjs run --run-dir workspace/runs/supporter-warmth/<run> --concurrency 200
 *   node scripts/repair-supporter-warmth.mjs merge --run-dir workspace/runs/supporter-warmth/<run>
 *   node scripts/repair-supporter-warmth.mjs audit
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createSqliteStore } from "./lib/sqlite-store.mjs";

const ROOT = process.cwd();
const DEFAULT_DB = path.join(ROOT, "workspace", "authoring.sqlite");
const DEFAULT_RUN_ROOT = path.join(ROOT, "workspace", "runs", "supporter-warmth");
const SCENE_PATH = path.join(ROOT, "data", "scenes", "scene_library.json");
const PREGENERATED_PATH = path.join(ROOT, "app", "assets", "pending-review.generated.js");
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_EDITOR = "Codex supporter warmth repair";

const AGE_ORDER = ["preschool", "primary_lower", "primary_upper", "middle_school", "high_school", "college", "workplace"];
const AGE_GUIDE = {
  preschool: "幼儿园：短句、具体、带一点安抚动作；不要成人分析。",
  primary_lower: "小学低年级：简单因果，先接身体和物件，再给很小的陪伴。",
  primary_upper: "小学高年级：能说委屈和害怕，但仍要具体、不讲大道理。",
  middle_school: "初中：敏感、怕被说矫情；少说教，多承认张力。",
  high_school: "高中：压力和比较强；温度要克制，不鸡汤。",
  college: "大学：独立和依恋并存；避免咨询腔，保留具体关系细节。",
  workplace: "职场：现实压力、边界和责任感；温暖但不幼态。",
};

const WARM_REGEX = /我听见|我听着|我看见|我跟着|我在|星仔|先别急|先陪|陪你|陪着|我记得|不用急|不用马上|可以先|我们先|在这|耳朵|守着|抱着|一起|靠一会|慢一点|停一下/u;
const EMOTION_REGEX = /难过|难受|委屈|害怕|怕|心疼|疼|酸|紧|闷|慌|失落|生气|气|舍不得|孤单|不安|羞|丢脸|累|着急|撑不住/u;
const COLD_REGEX = /这说明|这构成|显示出|你面对的是|抽象的|不是.*而是|可以同时存在|不必.*证明|你现在把/u;
const FORBIDDEN_HISTORY_REGEX = /authoring|context_dependencies|valid_response|forbidden_response|参考答案|差例|高分回复|模型应该|可接受方向|禁写/u;

function parseArgs(argv) {
  const command = argv[0];
  const options = {
    dbPath: DEFAULT_DB,
    runDir: "",
    batchCount: 200,
    concurrency: 200,
    limit: 0,
    model: DEFAULT_MODEL,
    reasoningEffort: "high",
    editorName: DEFAULT_EDITOR,
    onlyCold: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--db") options.dbPath = path.resolve(value), index += 1;
    else if (arg === "--run-dir") options.runDir = path.resolve(value), index += 1;
    else if (arg === "--batch-count") options.batchCount = Number(value), index += 1;
    else if (arg === "--concurrency") options.concurrency = Number(value), index += 1;
    else if (arg === "--limit") options.limit = Number(value), index += 1;
    else if (arg === "--model") options.model = value, index += 1;
    else if (arg === "--reasoning-effort") options.reasoningEffort = value, index += 1;
    else if (arg === "--editor-name") options.editorName = value, index += 1;
    else if (arg === "--only-cold") options.onlyCold = true;
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }
  if (!["prepare", "run", "merge", "status", "audit"].includes(command)) {
    printHelp();
    throw new Error("缺少合法命令");
  }
  if (!Number.isInteger(options.batchCount) || options.batchCount < 1 || options.batchCount > 512) {
    throw new Error("--batch-count 必须为 1-512 的整数");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 200) {
    throw new Error("--concurrency 必须为 1-200 的整数");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error("--limit 必须为非负整数");
  return { command, options };
}

function printHelp() {
  console.log([
    "Usage:",
    "  node scripts/repair-supporter-warmth.mjs prepare [--batch-count 200] [--only-cold] [--limit N]",
    "  node scripts/repair-supporter-warmth.mjs run --run-dir PATH [--concurrency 200]",
    "  node scripts/repair-supporter-warmth.mjs merge --run-dir PATH",
    "  node scripts/repair-supporter-warmth.mjs status --run-dir PATH",
    "  node scripts/repair-supporter-warmth.mjs audit",
  ].join("\n"));
}

function nowIso() {
  return new Date().toISOString();
}

function charLength(value) {
  return [...String(value || "")].length;
}

function safeJsonText(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function parseJsonLine(line, filePath, lineNumber) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${filePath} 第 ${lineNumber} 行不是合法 JSON`);
  }
}

function normalizeNdjsonText(text) {
  if (text.includes("\n")) return text;
  if (!/\}\s*\\n\s*\{/u.test(text)) return text;
  return text.replace(/\}\s*\\n\s*\{/gu, "}\n{");
}

function getStore(dbPath) {
  return createSqliteStore({
    dbPath,
    root: ROOT,
    scenePath: SCENE_PATH,
    pregeneratedPath: PREGENERATED_PATH,
  });
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map(turn => ({ role: String(turn?.role || "").trim(), content: String(turn?.content || "").trim() }));
}

function ageIndex(ageBand) {
  const index = AGE_ORDER.indexOf(ageBand);
  return index >= 0 ? index : 999;
}

function supporterLooksCold(content) {
  const text = String(content || "");
  if (charLength(text) < 24) return true;
  if (COLD_REGEX.test(text) && !WARM_REGEX.test(text) && !EMOTION_REGEX.test(text)) return true;
  return !WARM_REGEX.test(text) && !EMOTION_REGEX.test(text);
}

function recordColdScore(history) {
  const supporters = history.filter(turn => turn.role === "supporter");
  return supporters.filter(turn => supporterLooksCold(turn.content)).length;
}

function loadItems(dbPath, { onlyCold = false } = {}) {
  const store = getStore(dbPath);
  const records = store.listRecords().records;
  const scenes = store.listScenes().scenes;
  const sceneById = new Map(scenes.map(scene => [scene.id, scene]));
  return Object.entries(records)
    .map(([recordKey, record]) => {
      const sample = record?.sample || {};
      const history = normalizeHistory(sample.history);
      if (!history.length) return null;
      const sceneId = record.sceneId || recordKey.split("::")[1];
      const scene = sceneById.get(sceneId) || {};
      const item = {
        recordKey,
        sceneId,
        sampleId: sample.sample_id || "",
        ageBand: record.ageBand || sample.age_band || recordKey.split("::")[0],
        specificAge: sample.specific_age,
        ageGuide: AGE_GUIDE[record.ageBand || sample.age_band] || "",
        sceneType: sample.scene_type || "",
        emotionValence: sample.emotion_valence || "",
        event: scene.event || "",
        category: scene.category || "",
        mechanism: scene.mechanism || "",
        situationSummary: String(sample.authoring?.situation_summary || "").trim(),
        authoringNotes: String(sample.authoring?.notes || "").slice(-1200),
        history,
        coldSupporterTurns: history
          .map((turn, index) => turn.role === "supporter" && supporterLooksCold(turn.content) ? index + 1 : null)
          .filter(Boolean),
      };
      return item;
    })
    .filter(Boolean)
    .filter(item => !onlyCold || item.coldSupporterTurns.length)
    .sort((a, b) => (
      ageIndex(a.ageBand) - ageIndex(b.ageBand)
      || String(a.sceneType).localeCompare(String(b.sceneType))
      || String(a.sceneId).localeCompare(String(b.sceneId))
      || String(a.recordKey).localeCompare(String(b.recordKey))
    ));
}

function chunkItems(items, batchCount) {
  const actualBatchCount = Math.min(batchCount, items.length);
  const baseChunkSize = Math.floor(items.length / actualBatchCount);
  const largerChunkCount = items.length % actualBatchCount;
  const chunks = [];
  let cursor = 0;
  for (let index = 0; index < actualBatchCount; index += 1) {
    const itemCount = baseChunkSize + (index < largerChunkCount ? 1 : 0);
    chunks.push(items.slice(cursor, cursor + itemCount));
    cursor += itemCount;
  }
  return chunks;
}

function buildInstructions() {
  return [
    "任务：修复 history 里 supporter 过冷的问题。你不是重写整题，只改 supporter 轮。",
    "必须逐条保留所有 user 内容，尤其最后一轮 user 完全不能改。",
    "必须保留 role 顺序、轮数、scene_type、事件、题型和 authoring 语义；不要改 sample_id，也不要输出 authoring。",
    "supporter 不是标准答案，也不是标注员。它要像星仔在陪用户说话：有在场感、有一点情绪温度、贴具体细节。",
    "每个 supporter 要做到：1) 回指用户刚说的一个具体细节；2) 点到一种感受或身体信号；3) 有一句陪伴者在场感，例如“我听见了”“星仔先陪你停一下”“我在这儿”“不用马上证明”。",
    "同一条 history 里的 supporter 不要每轮都用同一个开头或同一句“星仔听见了/我在这儿”；在场感要自然变化。",
    "温度不能变成空暖：不要写“抱抱你”“你很棒”“一切都会好的”“我永远陪你”。",
    "不要写冷静评审腔：避免连续使用“这说明”“这构成”“你面对的是”“不是X而是Y”“可以同时存在”。",
    "不要抢答末轮：supporter 可以铺垫，但不能提前给出最后用户之后的标准答案。",
    "低龄要更像哄小孩但不糊弄：短、软、具体，有物件和身体感。高中以上要克制温暖，少鸡汤。",
    "输出每项一行 JSON，不要 Markdown、解释、标题或代码围栏。",
    "每行字段只能是 recordKey 和 history。history 必须是完整数组，user 轮内容必须与 manifest 完全一致，supporter 每轮不超过 200 字。",
  ].join("\n");
}

function prepare(options) {
  let items = loadItems(options.dbPath, { onlyCold: options.onlyCold });
  if (options.limit) items = items.slice(0, options.limit);
  if (!items.length) throw new Error("没有可修复的记录");
  const runId = `supporter-warmth-${items.length}-${Date.now()}`;
  const runDir = path.join(DEFAULT_RUN_ROOT, runId);
  const manifestDir = path.join(runDir, "manifests");
  const resultDir = path.join(runDir, "results");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(resultDir, { recursive: true });
  const chunks = chunkItems(items, options.batchCount);
  const manifests = chunks.map((chunk, index) => {
    const batchName = `batch-${String(index + 1).padStart(3, "0")}`;
    const manifestPath = path.join(manifestDir, `${batchName}.json`);
    const resultPath = path.join(resultDir, `${batchName}.ndjson`);
    fs.writeFileSync(manifestPath, `${safeJsonText({ batchName, resultPath, instructions: buildInstructions(), items: chunk })}\n`, "utf8");
    return { batchName, manifestPath, resultPath, itemCount: chunk.length };
  });
  const run = {
    runId,
    mode: "supporter_warmth_repair",
    createdAt: nowIso(),
    dbPath: options.dbPath,
    selectedAtStart: items.length,
    batchCount: manifests.length,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    onlyCold: options.onlyCold,
    coldRecordsAtStart: items.filter(item => item.coldSupporterTurns.length).length,
    manifests,
  };
  fs.writeFileSync(path.join(runDir, "run.json"), `${safeJsonText(run)}\n`, "utf8");
  console.log(JSON.stringify({ runDir, ...run }, null, 2));
}

function validateResult(raw, expectedItem) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("结果不是对象");
  if (raw.recordKey !== expectedItem.recordKey) throw new Error(`recordKey 不匹配：${raw.recordKey}`);
  const history = normalizeHistory(raw.history);
  if (history.length !== expectedItem.history.length) throw new Error("history 轮数改变");
  let warmCount = 0;
  let supportCount = 0;
  for (let index = 0; index < history.length; index += 1) {
    const actual = history[index];
    const expected = expectedItem.history[index];
    if (actual.role !== expected.role) throw new Error(`第 ${index + 1} 轮 role 改变`);
    if (!actual.content) throw new Error(`第 ${index + 1} 轮内容为空`);
    if (FORBIDDEN_HISTORY_REGEX.test(actual.content)) throw new Error(`第 ${index + 1} 轮包含评审/答案提示词`);
    if (expected.role === "user" && actual.content !== expected.content) throw new Error(`第 ${index + 1} 轮 user 被改动`);
    if (expected.role === "supporter") {
      supportCount += 1;
      const length = charLength(actual.content);
      if (length > 200) throw new Error(`第 ${index + 1} 轮 supporter 超过 200 字`);
      if (length < 18) throw new Error(`第 ${index + 1} 轮 supporter 过短`);
      if (WARM_REGEX.test(actual.content) || EMOTION_REGEX.test(actual.content)) warmCount += 1;
      if (COLD_REGEX.test(actual.content) && !WARM_REGEX.test(actual.content) && !EMOTION_REGEX.test(actual.content)) {
        throw new Error(`第 ${index + 1} 轮 supporter 仍像冷静旁白`);
      }
    }
  }
  if (supportCount && warmCount < Math.max(2, supportCount - 1)) {
    throw new Error(`supporter 温度不足：${warmCount}/${supportCount}`);
  }
  return history;
}

function readResultRows(resultPath) {
  const rows = [];
  if (!fs.existsSync(resultPath)) return rows;
  const text = normalizeNdjsonText(fs.readFileSync(resultPath, "utf8"));
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    rows.push(parseJsonLine(line, resultPath, index + 1));
  }
  return rows;
}

function resultLooksComplete(manifest) {
  try {
    const expectedByKey = new Map(manifest.items.map(item => [item.recordKey, item]));
    const rows = readResultRows(manifest.resultPath);
    if (rows.length !== manifest.items.length) return false;
    const seen = new Set();
    for (const row of rows) {
      const expected = expectedByKey.get(row.recordKey);
      if (!expected || seen.has(row.recordKey)) return false;
      validateResult(row, expected);
      seen.add(row.recordKey);
    }
    return seen.size === expectedByKey.size;
  } catch {
    return false;
  }
}

function buildCodexPrompt(manifestInfo) {
  return [
    `你负责 supporter 温度修复批次 ${manifestInfo.batchName}。`,
    `只允许读取 ${manifestInfo.manifestPath}。`,
    `只允许创建或修改 ${manifestInfo.resultPath}，不要改其他文件。`,
    "完整读取 manifest，严格遵守 instructions。",
    "只改 supporter 轮：user 轮必须逐字复制，最后一句 user 必须逐字复制。",
    "把冷静、评审、咨询报告式的 supporter 改成有温度、贴细节、像星仔在场的陪伴。",
    "注意不要把温度模板化：同一条记录里不要反复使用同一个“星仔听见了/我在这儿”句式。",
    "不要输出 authoring，不要输出解释，不要 Markdown。",
    "每个结果一行 JSON，字段只能是 recordKey、history。",
    "写完后自检：JSON 可解析；recordKey 集合一致；所有 user 内容与 manifest 逐字一致；supporter 不超过 200 字；supporter 有具体细节和在场感。",
  ].join("\n");
}

function runCodex(manifestInfo, options, logDir) {
  return new Promise(resolve => {
    const logPath = path.join(logDir, `${manifestInfo.batchName}.log`);
    const logFd = fs.openSync(logPath, "a");
    fs.rmSync(manifestInfo.resultPath, { force: true });
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-C",
      ROOT,
      "-m",
      options.model,
      "-c",
      `model_reasoning_effort="${options.reasoningEffort}"`,
      buildCodexPrompt(manifestInfo),
    ];
    const child = spawn("codex", args, { cwd: ROOT, stdio: ["ignore", logFd, logFd] });
    child.on("error", error => {
      fs.closeSync(logFd);
      resolve({ manifestInfo, exitCode: -1, error: error.message, logPath });
    });
    child.on("exit", (exitCode, signal) => {
      fs.closeSync(logFd);
      let complete = false;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, "utf8"));
        complete = resultLooksComplete(manifest);
      } catch {
        complete = false;
      }
      resolve({ manifestInfo, exitCode: exitCode ?? -1, signal, complete, logPath });
    });
  });
}

async function run(options) {
  if (!options.runDir) throw new Error("run 需要 --run-dir PATH");
  const runPath = path.join(options.runDir, "run.json");
  if (!fs.existsSync(runPath)) throw new Error(`未找到 ${runPath}`);
  const runInfo = JSON.parse(fs.readFileSync(runPath, "utf8"));
  const logDir = path.join(options.runDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const pending = runInfo.manifests.filter(manifestInfo => {
    const manifest = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, "utf8"));
    return !resultLooksComplete(manifest);
  });
  console.log(`Codex CLI supporter 温度修复待处理 ${pending.length}/${runInfo.manifests.length} 批，最高并发 ${options.concurrency}`);
  if (!pending.length) return;
  let cursor = 0;
  let completed = 0;
  let failed = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      const manifestInfo = pending[index];
      const result = await runCodex(manifestInfo, options, logDir);
      completed += 1;
      if (result.exitCode !== 0 || !result.complete) {
        failed += 1;
        console.error(`[${completed}/${pending.length}] ${manifestInfo.batchName} 未完成 (exit=${result.exitCode}, complete=${Boolean(result.complete)})，日志 ${result.logPath}`);
      } else {
        console.log(`[${completed}/${pending.length}] ${manifestInfo.batchName} 完成，失败批次 ${failed}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, () => worker()));
  console.log(`Codex CLI supporter 温度修复结束：检查 ${completed}，失败 ${failed}。`);
  if (failed) process.exitCode = 2;
}

function backupSqlite(dbPath, runDir) {
  const backupDir = path.join(runDir, "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `authoring-before-supporter-warmth-${Date.now()}.sqlite`);
  const db = new DatabaseSync(dbPath);
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  db.close();
  return backupPath;
}

function collectValidResults(runInfo) {
  const resultByKey = new Map();
  const invalid = [];
  const expectedByKey = new Map();
  for (const manifestInfo of runInfo.manifests) {
    const manifest = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, "utf8"));
    for (const item of manifest.items) expectedByKey.set(item.recordKey, item);
    let rows = [];
    try {
      rows = readResultRows(manifestInfo.resultPath);
    } catch (error) {
      invalid.push({ recordKey: null, error: error.message, resultPath: manifestInfo.resultPath });
      continue;
    }
    for (const row of rows) {
      try {
        const expected = expectedByKey.get(row.recordKey);
        if (!expected) throw new Error("recordKey 不属于 manifest");
        if (resultByKey.has(row.recordKey)) throw new Error("recordKey 重复");
        resultByKey.set(row.recordKey, validateResult(row, expected));
      } catch (error) {
        invalid.push({ recordKey: row?.recordKey || null, error: error.message, resultPath: manifestInfo.resultPath });
      }
    }
  }
  const invalidKeys = new Set(invalid.map(item => item.recordKey).filter(Boolean));
  const missing = [...expectedByKey.keys()].filter(key => !resultByKey.has(key) && !invalidKeys.has(key));
  return { resultByKey, invalid, missing };
}

function merge(options) {
  if (!options.runDir) throw new Error("merge 需要 --run-dir PATH");
  const runPath = path.join(options.runDir, "run.json");
  if (!fs.existsSync(runPath)) throw new Error(`未找到 ${runPath}`);
  const runInfo = JSON.parse(fs.readFileSync(runPath, "utf8"));
  const { resultByKey, invalid, missing } = collectValidResults(runInfo);
  if (invalid.length || missing.length) {
    const reportPath = path.join(options.runDir, "merge-blocked.json");
    fs.writeFileSync(reportPath, `${JSON.stringify({ invalid, missing }, null, 2)}\n`, "utf8");
    throw new Error(`结果尚不完整或有无效项：invalid=${invalid.length}, missing=${missing.length}，详见 ${reportPath}`);
  }
  const store = getStore(options.dbPath);
  const records = store.listRecords().records;
  const backupPath = backupSqlite(options.dbPath, options.runDir);
  const changedAt = nowIso();
  let updated = 0;
  for (const [recordKey, history] of resultByKey) {
    const record = records[recordKey];
    if (!record?.sample?.authoring) throw new Error(`SQLite 中找不到可更新记录：${recordKey}`);
    const nextRecord = structuredClone(record);
    nextRecord.status = "pending_review";
    nextRecord.humanConfirmedAt = null;
    nextRecord.confirmationSource = null;
    nextRecord.updatedAt = changedAt;
    nextRecord.sample.revision = (Number(nextRecord.sample.revision) || 1) + 1;
    nextRecord.sample.history = history;
    nextRecord.sample.authoring = {
      ...nextRecord.sample.authoring,
      review_status: "draft",
      notes: [
        nextRecord.sample.authoring.notes || "",
        `[supporter温度修复] ${changedAt}｜只修复 supporter 冷感，user 轮与 authoring 评测规则保持不变`,
      ].filter(Boolean).join("\n"),
    };
    store.upsertRecord(recordKey, nextRecord, { editorName: options.editorName, action: "repair_supporter_warmth" });
    updated += 1;
  }
  console.log(JSON.stringify({ updated, backupPath }, null, 2));
}

function audit(options) {
  const items = loadItems(options.dbPath, { onlyCold: false });
  let totalSupport = 0;
  let short = 0;
  let coldish = 0;
  let clinical = 0;
  const examples = [];
  for (const item of items) {
    for (const [index, turn] of item.history.entries()) {
      if (turn.role !== "supporter") continue;
      totalSupport += 1;
      if (charLength(turn.content) < 24) short += 1;
      if (supporterLooksCold(turn.content)) {
        coldish += 1;
        if (examples.length < 20) examples.push({ recordKey: item.recordKey, turn: index + 1, content: turn.content });
      }
      if (COLD_REGEX.test(turn.content) && !WARM_REGEX.test(turn.content) && !EMOTION_REGEX.test(turn.content)) clinical += 1;
    }
  }
  console.log(JSON.stringify({
    records: items.length,
    totalSupport,
    short,
    coldish,
    clinical,
    coldRate: totalSupport ? Number((coldish / totalSupport).toFixed(4)) : 0,
    examples,
  }, null, 2));
}

function status(options) {
  if (!options.runDir) throw new Error("status 需要 --run-dir PATH");
  const runPath = path.join(options.runDir, "run.json");
  if (!fs.existsSync(runPath)) throw new Error(`未找到 ${runPath}`);
  const runInfo = JSON.parse(fs.readFileSync(runPath, "utf8"));
  let complete = 0;
  let rows = 0;
  let invalidResultFiles = 0;
  for (const manifestInfo of runInfo.manifests) {
    const manifest = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, "utf8"));
    if (resultLooksComplete(manifest)) complete += 1;
    try {
      rows += readResultRows(manifestInfo.resultPath).length;
    } catch {
      invalidResultFiles += 1;
    }
  }
  console.log(JSON.stringify({
    runDir: options.runDir,
    manifests: runInfo.manifests.length,
    completeManifests: complete,
    resultRows: rows,
    invalidResultFiles,
    expectedRows: runInfo.selectedAtStart,
    onlyCold: runInfo.onlyCold,
  }, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "prepare") prepare(options);
  else if (command === "run") await run(options);
  else if (command === "merge") merge(options);
  else if (command === "status") status(options);
  else if (command === "audit") audit(options);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
