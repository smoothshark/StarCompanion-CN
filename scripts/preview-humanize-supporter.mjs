#!/usr/bin/env node
/**
 * Build a non-destructive preview for the next supporter style:
 * conversational, shorter, less literary, still detail-aware.
 *
 *   node scripts/preview-humanize-supporter.mjs prepare
 *   node scripts/preview-humanize-supporter.mjs run --run-dir workspace/runs/supporter-human-preview/<run>
 *   node scripts/preview-humanize-supporter.mjs status --run-dir workspace/runs/supporter-human-preview/<run>
 *   node scripts/preview-humanize-supporter.mjs render --run-dir workspace/runs/supporter-human-preview/<run>
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createSqliteStore } from "./lib/sqlite-store.mjs";

const ROOT = process.cwd();
const DEFAULT_DB = path.join(ROOT, "workspace", "authoring.sqlite");
const DEFAULT_RUN_ROOT = path.join(ROOT, "workspace", "runs", "supporter-human-preview");
const SCENE_PATH = path.join(ROOT, "data", "scenes", "scene_library.json");
const PREGENERATED_PATH = path.join(ROOT, "app", "assets", "pending-review.generated.js");
const DEFAULT_MODEL = "gpt-5.6-luna";

const AGE_ORDER = [
  "preschool",
  "primary_lower",
  "primary_upper",
  "middle_school",
  "high_school",
  "college",
  "workplace",
];

const AGE_GUIDE = {
  preschool: "幼儿园：15-45 字，像跟小孩说话，具体、简单，不讲大道理。",
  primary_lower: "小学低年级：15-45 字，口语、具体，可接住一个物件或动作。",
  primary_upper: "小学高年级：25-60 字，能说委屈和害怕，但不要成人腔。",
  middle_school: "初中：25-60 字，敏感、怕丢脸，少说教。",
  high_school: "高中：30-75 字，压力强，克制、像熟人接话。",
  college: "大学：30-75 字，别咨询腔，保留具体关系和选择压力。",
  workplace: "职场：30-75 字，现实、边界清楚，少文案感。",
};

const HUMAN_STYLE_INSTRUCTIONS = [
  "你在做 supporter 人话版预览，不是重写整条评测题。",
  "只改 history 里的 supporter 轮；所有 user 轮必须逐字复制，最后 user 也必须逐字复制。",
  "不要改 role、轮数、顺序，不要输出 authoring。",
  "supporter 要像真实陪伴者在聊天：口语、短一点、松一点。",
  "最重要：每轮 supporter 必须先承接上一轮 user 刚说的话，从上一句里拿 1 个具体锚点再回应。",
  "具体锚点可以是人名、物件、原话、动作、地点、时间、身体感觉；例如酒杯、果汁、‘扫兴’、手心热、小星星。",
  "不要只承接整条背景或总体主题；不要跳过上一句去做抽象总结。",
  "每轮 supporter 只做一件事：接一个具体细节，或命名一个感受，或轻轻点一下关系张力。",
  "不要写漂亮文案、金句、作文腔、评测旁白、心理咨询摘要。",
  "避免过度修辞：不要写“拒绝像被围住”“身体替你记住”“把害怕和委屈放在一起”“继续烫着手心”。",
  "避免模板化表态：少写“我站在你这边听着”“这条边界很清楚”“这不是 X 而是 Y”。",
  "星仔存在感要轻：每条 history 最多自然提到 1-2 次星仔，不要每轮都写星仔动作。",
  "保留评测功能：前文仍要接住具体细节，但不要把 supporter 写成标准答案提示。",
  "年龄贴合 item.ageGuide；成年人别幼态，低龄别成熟。",
  "输出 NDJSON，每行一个对象，字段只能是 recordKey、history。",
].join("\n");

const FORBIDDEN_HISTORY_REGEX = /authoring|context_dependencies|valid_response|forbidden_response|参考答案|差例|高分回复|模型应该|可接受方向|禁写/u;
const LITERARY_REGEX = /拒绝像被围住|身体替你记住|把.*放在一起|继续烫着手心|酒杯.*围住|耳朵朝.*偏|星仔把耳朵朝|星仔.*偏着|这条边界.*清楚|我站在你这边听着/u;
const CLINICAL_REGEX = /这说明|这构成|显示出|你面对的是|核心是|关键是|你的任务是|需要处理的是/u;
const STOP_ANCHORS = new Set([
  "我", "你", "他", "她", "它", "我们", "你们", "他们", "她们",
  "今天", "明天", "现在", "刚才", "晚上", "时候", "一下", "一直",
  "还是", "已经", "其实", "就是", "不是", "因为", "所以", "如果",
  "觉得", "知道", "可能", "真的", "有点", "好像", "这样", "那个",
  "这个", "还有", "然后", "但是", "可是", "可以", "不能", "不会",
  "没有", "自己", "什么", "怎么", "是不是", "怎么办", "没事",
]);

function parseArgs(argv) {
  const command = argv[0];
  const options = {
    dbPath: DEFAULT_DB,
    runDir: "",
    batchCount: 14,
    concurrency: 14,
    model: DEFAULT_MODEL,
    reasoningEffort: "high",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--db") options.dbPath = path.resolve(value), index += 1;
    else if (arg === "--run-dir") options.runDir = path.resolve(value), index += 1;
    else if (arg === "--batch-count") options.batchCount = Number(value), index += 1;
    else if (arg === "--concurrency") options.concurrency = Number(value), index += 1;
    else if (arg === "--model") options.model = value, index += 1;
    else if (arg === "--reasoning-effort") options.reasoningEffort = value, index += 1;
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }
  if (!["prepare", "run", "status", "render"].includes(command)) {
    printHelp();
    throw new Error("缺少合法命令");
  }
  if (!Number.isInteger(options.batchCount) || options.batchCount < 1 || options.batchCount > 100) {
    throw new Error("--batch-count 必须为 1-100 的整数");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 100) {
    throw new Error("--concurrency 必须为 1-100 的整数");
  }
  return { command, options };
}

function printHelp() {
  console.log([
    "Usage:",
    "  node scripts/preview-humanize-supporter.mjs prepare [--batch-count 14]",
    "  node scripts/preview-humanize-supporter.mjs run --run-dir PATH [--concurrency 14]",
    "  node scripts/preview-humanize-supporter.mjs status --run-dir PATH",
    "  node scripts/preview-humanize-supporter.mjs render --run-dir PATH",
  ].join("\n"));
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonText(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function charLength(value) {
  return [...String(value || "")].length;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map(turn => ({
    role: String(turn?.role || "").trim(),
    content: String(turn?.content || "").trim(),
  }));
}

function cleanAnchorText(value) {
  return String(value || "")
    .replace(/[，。！？、；：,.!?;:()[\]{}<>《》「」『』“”‘’"'`~…—\-\s]/gu, "");
}

function extractQuotedAnchors(text) {
  const anchors = [];
  const pattern = /[“‘"']([^“”‘’"'\n]{1,16})[”’"']/gu;
  let match = pattern.exec(text);
  while (match) {
    const value = cleanAnchorText(match[1]);
    if (value && !STOP_ANCHORS.has(value)) anchors.push(value);
    match = pattern.exec(text);
  }
  return anchors;
}

function extractAnchorCandidates(text) {
  const source = String(text || "");
  const anchors = new Set(extractQuotedAnchors(source));
  const chunks = source
    .replace(/[，。！？、；：,.!?;:()[\]{}<>《》「」『』“”‘’"'`~…—\-\s]/gu, " ")
    .split(/\s+/u)
    .map(chunk => cleanAnchorText(chunk))
    .filter(Boolean);
  for (const chunk of chunks) {
    if (/^[A-Za-z0-9_]{2,}$/u.test(chunk)) anchors.add(chunk);
    const chars = [...chunk];
    if (chars.length >= 2 && chars.length <= 8 && !STOP_ANCHORS.has(chunk)) anchors.add(chunk);
    for (let length = Math.min(6, chars.length); length >= 2; length -= 1) {
      for (let start = 0; start + length <= chars.length; start += 1) {
        const candidate = chars.slice(start, start + length).join("");
        if (STOP_ANCHORS.has(candidate)) continue;
        if (/^[我你他她它的了呢啊吧吗呀和也都就很更又再还在是有不没会想说到去来给把被让才]/u.test(candidate) && length <= 2) continue;
        anchors.add(candidate);
      }
    }
  }
  return [...anchors].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function findImmediateAnchors(previousUser, supporter) {
  const normalizedSupporter = cleanAnchorText(supporter);
  return extractAnchorCandidates(previousUser)
    .filter(anchor => anchor.length >= 2 && normalizedSupporter.includes(anchor))
    .slice(0, 5);
}

function ageIndex(ageBand) {
  const index = AGE_ORDER.indexOf(ageBand);
  return index >= 0 ? index : 999;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function getStore(dbPath) {
  return createSqliteStore({
    dbPath,
    root: ROOT,
    scenePath: SCENE_PATH,
    pregeneratedPath: PREGENERATED_PATH,
  });
}

function loadSamples(dbPath) {
  const store = getStore(dbPath);
  const records = store.listRecords().records;
  const scenes = store.listScenes().scenes;
  const sceneById = new Map(scenes.map(scene => [scene.id, scene]));
  const bySceneType = new Map();

  for (const [recordKey, record] of Object.entries(records)) {
    const sample = record?.sample || {};
    const history = normalizeHistory(sample.history);
    if (!history.length) continue;
    const sceneType = sample.scene_type || "UNKNOWN";
    const sceneId = record.sceneId || recordKey.split("::")[1];
    const scene = sceneById.get(sceneId) || {};
    const ageBand = record.ageBand || sample.age_band || recordKey.split("::")[0];
    const item = {
      recordKey,
      sceneType,
      ageBand,
      ageGuide: AGE_GUIDE[ageBand] || "",
      sceneId,
      sampleId: sample.sample_id || "",
      evalType: sample.authoring?.eval_type || sample.authoring?.notes?.match(/题型[:：]([^｜\n]+)/u)?.[1] || "",
      event: scene.event || "",
      category: scene.category || "",
      mechanism: scene.mechanism || "",
      situationSummary: String(sample.authoring?.situation_summary || "").trim(),
      history,
      score: stableHash(`${sceneType} ${recordKey}`),
    };
    if (sceneType === "social_conflict" && recordKey === "workplace::event-076") {
      item.score = -1;
    }
    const list = bySceneType.get(sceneType) || [];
    list.push(item);
    bySceneType.set(sceneType, list);
  }

  return [...bySceneType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, list]) => list.sort((a, b) => (
      a.score - b.score
      || ageIndex(a.ageBand) - ageIndex(b.ageBand)
      || a.recordKey.localeCompare(b.recordKey)
    ))[0]);
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

function prepare(options) {
  const items = loadSamples(options.dbPath);
  const runId = `supporter-human-preview-${items.length}-${Date.now()}`;
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
    fs.writeFileSync(manifestPath, `${safeJsonText({
      batchName,
      resultPath,
      instructions: HUMAN_STYLE_INSTRUCTIONS,
      items: chunk,
    })}\n`, "utf8");
    return { batchName, manifestPath, resultPath, itemCount: chunk.length };
  });

  const run = {
    runId,
    mode: "supporter_human_style_preview",
    createdAt: nowIso(),
    dbPath: options.dbPath,
    selectedAtStart: items.length,
    batchCount: manifests.length,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    sceneTypes: items.map(item => item.sceneType),
    manifests,
  };
  fs.writeFileSync(path.join(runDir, "run.json"), `${safeJsonText(run)}\n`, "utf8");
  console.log(JSON.stringify({ runDir, ...run }, null, 2));
}

function maxSupporterLength(ageBand) {
  if (ageBand === "preschool" || ageBand === "primary_lower") return 65;
  if (ageBand === "primary_upper" || ageBand === "middle_school") return 80;
  return 95;
}

function validateResult(raw, expectedItem) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("结果不是对象");
  if (raw.recordKey !== expectedItem.recordKey) throw new Error(`recordKey 不匹配：${raw.recordKey}`);
  let history = normalizeHistory(raw.history);
  if (
    history.length === expectedItem.history.length + 1
    && expectedItem.history.at(-1)?.role === "user"
    && history.at(-1)?.role === "supporter"
  ) {
    history = history.slice(0, -1);
  }
  if (history.length !== expectedItem.history.length) throw new Error("history 轮数改变");
  let starMentions = 0;
  for (let index = 0; index < history.length; index += 1) {
    const actual = history[index];
    const expected = expectedItem.history[index];
    if (actual.role !== expected.role) throw new Error(`第 ${index + 1} 轮 role 改变`);
    if (!actual.content) throw new Error(`第 ${index + 1} 轮内容为空`);
    if (FORBIDDEN_HISTORY_REGEX.test(actual.content)) throw new Error(`第 ${index + 1} 轮包含评审/答案提示词`);
    if (expected.role === "user" && actual.content !== expected.content) throw new Error(`第 ${index + 1} 轮 user 被改动`);
    if (expected.role === "supporter") {
      const length = charLength(actual.content);
      const max = maxSupporterLength(expectedItem.ageBand);
      if (length > max) throw new Error(`第 ${index + 1} 轮 supporter 超过 ${max} 字`);
      if (length < 8) throw new Error(`第 ${index + 1} 轮 supporter 过短`);
      if (LITERARY_REGEX.test(actual.content)) throw new Error(`第 ${index + 1} 轮仍有文案腔`);
      if (CLINICAL_REGEX.test(actual.content)) throw new Error(`第 ${index + 1} 轮仍像评测旁白`);
      const previousUser = expectedItem.history[index - 1];
      if (previousUser?.role === "user" && !findImmediateAnchors(previousUser.content, actual.content).length) {
        throw new Error(`第 ${index + 1} 轮 supporter 未承接上一句 user`);
      }
      if (/星仔/u.test(actual.content)) starMentions += 1;
    }
  }
  if (starMentions > 2) throw new Error(`星仔出现过多：${starMentions}`);
  return history;
}

function normalizeNdjsonText(text) {
  if (text.includes("\n")) return text;
  if (!/\}\s*\\n\s*\{/u.test(text)) return text;
  return text.replace(/\}\s*\\n\s*\{/gu, "}\n{");
}

function parseJsonLine(line, filePath, lineNumber) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${filePath} 第 ${lineNumber} 行不是合法 JSON`);
  }
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
    `你负责 supporter 人话版预览批次 ${manifestInfo.batchName}。`,
    `只允许读取 ${manifestInfo.manifestPath}。`,
    `只允许创建或修改 ${manifestInfo.resultPath}，不要改其他文件。`,
    "完整读取 manifest，严格遵守 instructions。",
    "只改 supporter 轮；user 轮必须逐字复制。",
    "不要输出解释、Markdown 或 authoring。",
    "每个结果一行 JSON，字段只能是 recordKey、history。",
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
  const runInfo = JSON.parse(fs.readFileSync(path.join(options.runDir, "run.json"), "utf8"));
  const logDir = path.join(options.runDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const pending = runInfo.manifests.filter(manifestInfo => {
    const manifest = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, "utf8"));
    return !resultLooksComplete(manifest);
  });
  console.log(`Codex CLI supporter 人话版预览待处理 ${pending.length}/${runInfo.manifests.length} 批，最高并发 ${options.concurrency}`);
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
  console.log(`Codex CLI supporter 人话版预览结束：检查 ${completed}，失败 ${failed}。`);
  if (failed) process.exitCode = 2;
}

function collectResults(runInfo) {
  const resultByKey = new Map();
  const expectedByKey = new Map();
  const invalid = [];
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
  return { resultByKey, expectedByKey, invalid, missing };
}

function status(options) {
  if (!options.runDir) throw new Error("status 需要 --run-dir PATH");
  const runInfo = JSON.parse(fs.readFileSync(path.join(options.runDir, "run.json"), "utf8"));
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
  const collected = collectResults(runInfo);
  console.log(JSON.stringify({
    runDir: options.runDir,
    manifests: runInfo.manifests.length,
    completeManifests: complete,
    resultRows: rows,
    invalidResultFiles,
    invalid: collected.invalid.length,
    missing: collected.missing.length,
    expectedRows: runInfo.selectedAtStart,
  }, null, 2));
}

function renderTurnList(history) {
  return history
    .map((turn, index) => `${index + 1}. **${turn.role}**：${turn.content}`)
    .join("\n");
}

function render(options) {
  if (!options.runDir) throw new Error("render 需要 --run-dir PATH");
  const runInfo = JSON.parse(fs.readFileSync(path.join(options.runDir, "run.json"), "utf8"));
  const { resultByKey, expectedByKey, invalid, missing } = collectResults(runInfo);
  if (invalid.length || missing.length) {
    const reportPath = path.join(options.runDir, "render-blocked.json");
    fs.writeFileSync(reportPath, `${JSON.stringify({ invalid, missing }, null, 2)}\n`, "utf8");
    throw new Error(`结果尚不完整或有无效项：invalid=${invalid.length}, missing=${missing.length}，详见 ${reportPath}`);
  }
  const items = [...expectedByKey.values()].sort((a, b) => a.sceneType.localeCompare(b.sceneType));
  const lines = [
    "# supporter 人话版抽样预览",
    "",
    `生成时间：${nowIso()}`,
    `抽样范围：${items.length} 个 scene_type，每类 1 条。`,
    "",
    "说明：本文件是预览稿，只改写 `supporter` 轮；所有 `user` 轮逐字保留，未写回 SQLite。",
    "",
  ];
  for (const item of items) {
    const nextHistory = resultByKey.get(item.recordKey);
    lines.push(`## ${item.sceneType}`);
    lines.push("");
    lines.push(`- recordKey：\`${item.recordKey}\``);
    lines.push(`- 年龄：\`${item.ageBand}\``);
    if (item.event) lines.push(`- 原子事件：${item.event}`);
    if (item.category || item.mechanism) lines.push(`- 分类：${[item.category, item.mechanism].filter(Boolean).join(" / ")}`);
    lines.push("");
    lines.push("### 原 supporter");
    lines.push("");
    for (const [index, turn] of item.history.entries()) {
      if (turn.role === "supporter") lines.push(`- 第 ${index + 1} 轮：${turn.content}`);
    }
    lines.push("");
    lines.push("### 人话版 history");
    lines.push("");
    lines.push(renderTurnList(nextHistory));
    lines.push("");
  }
  const previewPath = path.join(options.runDir, "preview.md");
  fs.writeFileSync(previewPath, `${lines.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ previewPath, items: items.length }, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "prepare") prepare(options);
  else if (command === "run") await run(options);
  else if (command === "status") status(options);
  else if (command === "render") render(options);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
