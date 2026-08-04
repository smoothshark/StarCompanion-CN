#!/usr/bin/env node
/**
 * Rewrite existing situation_summary values into compact long-term memory packs.
 *
 * Workflow:
 *   node scripts/rewrite-background-memory.mjs prepare --batch-count 100
 *   node scripts/rewrite-background-memory.mjs run --run-dir workspace/runs/memory-rewrite/<run>
 *   node scripts/rewrite-background-memory.mjs merge --run-dir workspace/runs/memory-rewrite/<run>
 *   node scripts/rewrite-background-memory.mjs audit
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createSqliteStore } from "./lib/sqlite-store.mjs";

const ROOT = process.cwd();
const DEFAULT_DB = path.join(ROOT, "workspace", "authoring.sqlite");
const DEFAULT_RUN_ROOT = path.join(ROOT, "workspace", "runs", "memory-rewrite");
const SCENE_PATH = path.join(ROOT, "data", "scenes", "scene_library.json");
const PREGENERATED_PATH = path.join(ROOT, "app", "assets", "pending-review.generated.js");
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_EDITOR = "Codex memory rewrite";
const MEMORY_LABELS = ["【用户画像】", "【星仔记忆】", "【当前触发】", "【承接要点】"];
const GENERIC_SUMMARY_PATTERNS = [
  /用户通常克制负责，习惯独自承担，不易直接求助/u,
  /长期承接用户的委屈、害怕和未说出口的话/u,
  /长期承接用户/u,
  /保留当前情绪、关系变化与未说完/u,
  /用户同时有开心、在意或舍不得等复杂感受/u,
  /这份感受仍未完全说透/u,
  /当前仍牵动后续/u,
  /记住用户此刻仍在向星仔表达/u,
  /接住用户当下的害怕、委屈、失落或无助/u,
  /先接住[他她]未说完的情绪，再围绕这件具体小事继续倾听/u,
];

function parseArgs(argv) {
  const command = argv[0];
  const options = {
    dbPath: DEFAULT_DB,
    runDir: "",
    batchCount: 100,
    concurrency: 100,
    limit: 0,
    model: DEFAULT_MODEL,
    reasoningEffort: "low",
    editorName: DEFAULT_EDITOR,
    minChars: 260,
    maxChars: 420,
    targetMin: 300,
    targetMax: 400,
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
    else if (arg === "--min-chars") options.minChars = Number(value), index += 1;
    else if (arg === "--max-chars") options.maxChars = Number(value), index += 1;
    else if (arg === "--target-min") options.targetMin = Number(value), index += 1;
    else if (arg === "--target-max") options.targetMax = Number(value), index += 1;
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
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 100) {
    throw new Error("--concurrency 必须为 1-100 的整数");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error("--limit 必须为非负整数");
  }
  if (!Number.isInteger(options.minChars) || !Number.isInteger(options.maxChars) || options.minChars >= options.maxChars) {
    throw new Error("--min-chars / --max-chars 范围无效");
  }
  return { command, options };
}

function printHelp() {
  console.log([
    "Usage:",
    "  node scripts/rewrite-background-memory.mjs prepare [--batch-count 100] [--limit N]",
    "  node scripts/rewrite-background-memory.mjs run --run-dir PATH [--concurrency 100]",
    "  node scripts/rewrite-background-memory.mjs merge --run-dir PATH",
    "  node scripts/rewrite-background-memory.mjs status --run-dir PATH",
    "  node scripts/rewrite-background-memory.mjs audit",
  ].join("\n"));
}

function charLength(value) {
  return [...String(value || "")].length;
}

function normalizeForCompare(value) {
  return String(value || "").replace(/\s+/gu, "").replace(/[，。；：、,.!?！？"'“”‘’]/gu, "");
}

function countOccurrences(value, search) {
  return String(value || "").split(search).length - 1;
}

function extractMemorySections(summary) {
  const sections = {};
  const indices = MEMORY_LABELS.map(label => summary.indexOf(label));
  for (let index = 0; index < MEMORY_LABELS.length; index += 1) {
    const start = indices[index];
    const end = index + 1 < MEMORY_LABELS.length ? indices[index + 1] : summary.length;
    sections[MEMORY_LABELS[index]] = start >= 0 && end > start
      ? summary.slice(start + MEMORY_LABELS[index].length, end).trim()
      : "";
  }
  return { indices, sections };
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

function safeJsonText(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function getStore(dbPath) {
  return createSqliteStore({
    dbPath,
    root: ROOT,
    scenePath: SCENE_PATH,
    pregeneratedPath: PREGENERATED_PATH,
  });
}

function compactHistory(sample) {
  const history = Array.isArray(sample?.history) ? sample.history : [];
  const firstUser = history.find(turn => turn?.role === "user")?.content || "";
  const lastUser = [...history].reverse().find(turn => turn?.role === "user")?.content || "";
  return {
    firstUser: String(firstUser).slice(0, 220),
    lastUser: String(lastUser).slice(0, 220),
  };
}

function loadItems(dbPath) {
  const store = getStore(dbPath);
  const records = store.listRecords().records;
  return Object.entries(records)
    .map(([recordKey, record]) => {
      const sample = record?.sample || {};
      const summary = String(sample.authoring?.situation_summary || "").trim();
      if (!summary) return null;
      return {
        recordKey,
        sceneId: record.sceneId || recordKey.split("::")[1],
        ageBand: record.ageBand || sample.age_band,
        status: record.status,
        source: record.source || "",
        model: record.model || "",
        sampleId: sample.sample_id || "",
        specificAge: sample.specific_age,
        sceneType: sample.scene_type,
        emotionValence: sample.emotion_valence,
        notes: sample.authoring?.notes || "",
        contextDependencies: sample.authoring?.context_dependencies || [],
        ...compactHistory(sample),
        existingSituationSummary: summary,
        existingChars: charLength(summary),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.recordKey.localeCompare(b.recordKey));
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

function buildInstructions(options) {
  return [
    "任务：把已有 situation_summary 从小说化背景故事，改写成评测 pipeline 可直接喂给模型的长期记忆包。",
    `长度目标：尽量 ${options.targetMin}-${options.targetMax} 个中文字符；必须在 ${options.minChars}-${options.maxChars} 字之间。超过 ${options.targetMax} 字时继续删除铺陈细节，不要扩写。`,
    "只基于 existingSituationSummary 和少量 history 信号压缩，不新增重大人物、地点、关系或事件，不改用户年龄、星仔身份和原事件核心。",
    "输出必须像 AI 玩具/LLM 的可检索长期记忆，不像小说、散文、剧情梗概或提示词。",
    "推荐格式为一个单段字符串，包含四个紧凑标签：【用户画像】【星仔记忆】【当前触发】【承接要点】；不要在标签之间换段。",
    "【用户画像】保留姓名/年龄/生活阶段/关键关系/表达习惯。",
    "【星仔记忆】保留星仔作为像兔子一样、有柔软长耳朵的毛绒外星 AI 情感陪玩玩具，以及 1-2 个和本事件相关的长期共同记忆。",
    "【当前触发】保留最近变化和本次事件中影响后续对话的事实。",
    "【承接要点】保留用户此刻没说透的情绪、误解风险、对话必须接住的具体信号。",
    "四个标签后都必须有具体内容，尤其【星仔记忆】不能空；禁止只机械截取原文或重复同一句兜底话。",
    "四个标签必须各出现一次且顺序固定，每段至少 24 字，整条结尾必须完整，不要以逗号、顿号、冒号或分号收尾。",
    "整条必须以句号、问号或感叹号收尾；接近字数上限时先删细节，不要截断半句话。",
    "【星仔记忆】必须包含一个具体共同经历或约定，不能只写星仔身份。",
    "禁止使用“用户通常克制负责”“长期承接用户”“保留当前情绪”“记住用户此刻”“接住用户当下的害怕”等通用兜底句。",
    "不要把【用户画像】原封不动复制到【星仔记忆】；每个标签都要写该标签自己的信息。",
    "删除或大幅压缩环境铺陈、天气灯光、动作慢镜头、结尾意象、心理分析和作者式旁白。",
    "避免“窗外/灯光/夜色/雨声/地铁/厨房/卧室/客厅/手指/摩挲/轻轻/忽然 + 像/仿佛”这类小说化意象。",
    "不要写成“应该回复/模型需要/请……”的任务说明；不要诊断；不要提前解决问题；不要改写 history。",
    "每个结果一行 JSON，字段只能是 recordKey 和 situation_summary。",
  ].join("\n");
}

function prepare(options) {
  let items = loadItems(options.dbPath);
  if (options.limit) items = items.slice(0, options.limit);
  if (!items.length) throw new Error("没有可重写的 situation_summary");

  const runId = `memory-rewrite-${items.length}-${Date.now()}`;
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
    const manifest = {
      batchName,
      resultPath,
      instructions: buildInstructions(options),
      lengthPolicy: {
        targetMin: options.targetMin,
        targetMax: options.targetMax,
        minChars: options.minChars,
        maxChars: options.maxChars,
      },
      items: chunk,
    };
    fs.writeFileSync(manifestPath, `${safeJsonText(manifest)}\n`, "utf8");
    return { batchName, manifestPath, resultPath, itemCount: chunk.length };
  });

  const run = {
    runId,
    mode: "memory_rewrite",
    createdAt: new Date().toISOString(),
    dbPath: options.dbPath,
    selectedAtStart: items.length,
    batchCount: manifests.length,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    lengthPolicy: {
      targetMin: options.targetMin,
      targetMax: options.targetMax,
      minChars: options.minChars,
      maxChars: options.maxChars,
    },
    manifests,
  };
  fs.writeFileSync(path.join(runDir, "run.json"), `${safeJsonText(run)}\n`, "utf8");
  console.log(JSON.stringify({ runDir, ...run }, null, 2));
}

function validateSummary(raw, expectedKey, policy) {
  if (!raw || typeof raw !== "object") throw new Error("结果不是对象");
  if (raw.recordKey !== expectedKey) throw new Error(`recordKey 不匹配：${raw.recordKey}`);
  const summary = String(raw.situation_summary || "").trim();
  const length = charLength(summary);
  if (length < policy.minChars) throw new Error(`记忆过短：${length}`);
  if (length > policy.maxChars) throw new Error(`记忆过长：${length}`);
  if (!summary.includes("星仔")) throw new Error("未出现星仔");
  if (!/(?:长期记忆|星仔记忆|共同记忆|记得)/u.test(summary)) throw new Error("缺少记忆表述");
  if (!/(?:当前触发|本次事件|这次|最近|今天|当天)/u.test(summary)) throw new Error("缺少当前触发");
  const { indices, sections } = extractMemorySections(summary);
  for (const label of MEMORY_LABELS) {
    if (countOccurrences(summary, label) !== 1) throw new Error(`标签缺失或重复：${label}`);
  }
  if (indices.some(index => index < 0) || indices.some((index, position) => position > 0 && index < indices[position - 1])) {
    throw new Error("长期记忆标签顺序错误");
  }
  for (const [label, section] of Object.entries(sections)) {
    if (charLength(section) < 24) throw new Error(`标签内容过薄：${label}`);
  }
  const profilePrefix = normalizeForCompare(sections["【用户画像】"]).slice(0, 34);
  const memoryPrefix = normalizeForCompare(sections["【星仔记忆】"]).slice(0, 34);
  if (profilePrefix && memoryPrefix && profilePrefix === memoryPrefix) {
    throw new Error("用户画像和星仔记忆机械重复");
  }
  if (!/(?:记得|曾|陪|一起|共同|约定|第一次|长期|听过|送|抱|藏|玩|讲|画|贴|放)/u.test(sections["【星仔记忆】"])) {
    throw new Error("星仔记忆缺少共同经历");
  }
  if (/[，；：、]$/u.test(summary.trim())) throw new Error("结尾像被截断");
  if (!/[。！？.!?]$/u.test(summary.trim())) throw new Error("结尾缺少完整标点");
  for (const pattern of GENERIC_SUMMARY_PATTERNS) {
    if (pattern.test(summary)) throw new Error("仍有通用兜底句");
  }
  if (/(?:窗外|灯光|夜色|雨声|地铁|厨房|卧室|客厅|手指|摩挲|轻轻|忽然).{0,12}(?:像(?!兔子)|仿佛)/u.test(summary)) {
    throw new Error("仍有明显小说化意象");
  }
  if (/(?:请模型|应该回复|需要回复|任务是|prompt)/iu.test(summary)) {
    throw new Error("像提示词或任务说明");
  }
  return summary.replace(/\s+/gu, " ");
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
    const rows = readResultRows(manifest.resultPath);
    if (rows.length !== manifest.items.length) return false;
    const expected = new Set(manifest.items.map(item => item.recordKey));
    const seen = new Set();
    for (const row of rows) {
      const summary = validateSummary(row, row.recordKey, manifest.lengthPolicy);
      if (!expected.has(row.recordKey) || seen.has(row.recordKey)) return false;
      if (!summary) return false;
      seen.add(row.recordKey);
    }
    return seen.size === expected.size;
  } catch {
    return false;
  }
}

function buildCodexPrompt(manifestInfo) {
  return [
    `你负责 A1 数据集长期记忆重写批次 ${manifestInfo.batchName}。`,
    `只允许读取 ${manifestInfo.manifestPath}。`,
    `只允许创建或修改 ${manifestInfo.resultPath}，不要改其他文件。`,
    "完整读取 manifest，严格遵守 instructions。",
    "为 items 中每一项输出一行合法 JSON，不要 Markdown、解释、标题或代码围栏。",
    "每行字段只能是 recordKey、situation_summary，必须覆盖全部条目且不重复。",
    "situation_summary 必须基于 existingSituationSummary 压缩，目标 300-400 字，超过 400 字就删细节；使用单段文字，可含【用户画像】【星仔记忆】【当前触发】【承接要点】四个短标签。",
    "保留长期记忆事实和当前触发，删掉小说化环境描写和结尾意象。",
    "四个标签都要有具体内容，【星仔记忆】不能为空；不要机械截取，不要复制整段原故事。",
    "四个标签必须各出现一次且顺序固定，每段至少 24 字，整条结尾必须完整，不要以逗号、顿号、冒号或分号收尾。",
    "整条必须以句号、问号或感叹号收尾；接近字数上限时先删细节，不要截断半句话。",
    "【星仔记忆】必须包含一个具体共同经历或约定，不能只写星仔身份。",
    "不要使用“用户通常克制负责”“长期承接用户”“保留当前情绪”“记住用户此刻”“接住用户当下的害怕”等通用兜底句。",
    "结果文件必须用真实换行分隔每条 JSON，不能写入字面量 \\n。",
    "写完后运行 Node 校验：每行可 JSON.parse；recordKey 集合与 manifest 完全一致；",
    "每条 situation_summary 在 manifest.lengthPolicy.minChars 和 maxChars 之间，含星仔、记忆表述、当前触发。",
    "校验失败必须修正后再结束。最终只报告结果文件路径、条数和校验结论。",
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
    const child = spawn("codex", args, {
      cwd: ROOT,
      stdio: ["ignore", logFd, logFd],
    });
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
      resolve({
        manifestInfo,
        exitCode: exitCode ?? -1,
        signal,
        complete,
        logPath,
      });
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
  console.log(
    `Codex CLI 记忆重写待处理 ${pending.length}/${runInfo.manifests.length} 批，`
    + `最高并发 ${options.concurrency}，模型 ${options.model}`,
  );
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
        console.error(
          `[${completed}/${pending.length}] ${manifestInfo.batchName} 未完成 `
          + `(exit=${result.exitCode}, complete=${Boolean(result.complete)})，日志 ${result.logPath}`,
        );
      } else {
        console.log(`[${completed}/${pending.length}] ${manifestInfo.batchName} 完成，失败批次 ${failed}`);
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, pending.length) },
      () => worker(),
    ),
  );
  console.log(`Codex CLI 记忆重写结束：检查 ${completed}，失败 ${failed}。`);
  if (failed) process.exitCode = 2;
}

function backupSqlite(dbPath, runDir) {
  const backupDir = path.join(runDir, "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `authoring-before-memory-rewrite-${Date.now()}.sqlite`);
  const db = new DatabaseSync(dbPath);
  const escaped = backupPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  db.close();
  return backupPath;
}

function collectValidResults(runInfo) {
  const resultByKey = new Map();
  const invalid = [];
  const manifestByKey = new Map();
  for (const manifestInfo of runInfo.manifests) {
    const manifest = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, "utf8"));
    for (const item of manifest.items) manifestByKey.set(item.recordKey, manifest);
    let rows = [];
    try {
      rows = readResultRows(manifestInfo.resultPath);
    } catch (error) {
      invalid.push({ recordKey: null, error: error.message, resultPath: manifestInfo.resultPath });
      continue;
    }
    for (const row of rows) {
      try {
        if (!manifest.items.some(item => item.recordKey === row.recordKey)) {
          throw new Error("recordKey 不属于该 manifest");
        }
        if (resultByKey.has(row.recordKey)) throw new Error("recordKey 重复");
        const summary = validateSummary(row, row.recordKey, manifest.lengthPolicy);
        resultByKey.set(row.recordKey, summary);
      } catch (error) {
        invalid.push({ recordKey: row?.recordKey || null, error: error.message, resultPath: manifestInfo.resultPath });
      }
    }
  }
  const expectedKeys = new Set([...manifestByKey.keys()]);
  const missing = [...expectedKeys].filter(recordKey => !resultByKey.has(recordKey));
  return { resultByKey, invalid, missing };
}

function merge(options) {
  if (!options.runDir) throw new Error("merge 需要 --run-dir PATH");
  const runPath = path.join(options.runDir, "run.json");
  if (!fs.existsSync(runPath)) throw new Error(`未找到 ${runPath}`);
  const runInfo = JSON.parse(fs.readFileSync(runPath, "utf8"));
  const { resultByKey, invalid, missing } = collectValidResults(runInfo);
  if (invalid.length || missing.length) {
    const report = { invalid, missing };
    const reportPath = path.join(options.runDir, "merge-blocked.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    throw new Error(`结果尚不完整或有无效项：invalid=${invalid.length}, missing=${missing.length}，详见 ${reportPath}`);
  }

  const store = getStore(options.dbPath);
  const records = store.listRecords().records;
  const backupPath = backupSqlite(options.dbPath, options.runDir);
  let updated = 0;
  for (const [recordKey, summary] of resultByKey) {
    const record = records[recordKey];
    if (!record?.sample?.authoring) throw new Error(`SQLite 中找不到可更新记录：${recordKey}`);
    const nextRecord = structuredClone(record);
    nextRecord.sample.authoring.situation_summary = summary;
    nextRecord.sample.authoring.notes = [
      nextRecord.sample.authoring.notes || "",
      `[长期记忆重写] ${new Date().toISOString()}｜基于原背景压缩为 300-400 字记忆包`,
    ].filter(Boolean).join("\n");
    nextRecord.updatedAt = new Date().toISOString();
    store.upsertRecord(recordKey, nextRecord, {
      editorName: options.editorName,
      action: "rewrite_long_term_memory",
    });
    updated += 1;
  }
  console.log(JSON.stringify({ updated, backupPath }, null, 2));
}

function audit(options) {
  const items = loadItems(options.dbPath);
  const lengths = items.map(item => item.existingChars).sort((a, b) => a - b);
  const pct = p => lengths[Math.min(lengths.length - 1, Math.floor((lengths.length - 1) * p))] || 0;
  const memoryLike = items.filter(item =>
    /【用户画像】/u.test(item.existingSituationSummary)
    && /【星仔记忆】/u.test(item.existingSituationSummary)
    && /【当前触发】/u.test(item.existingSituationSummary)
    && /【承接要点】/u.test(item.existingSituationSummary)
  ).length;
  const strictValid = items.filter(item => {
    try {
      validateSummary(
        { recordKey: item.recordKey, situation_summary: item.existingSituationSummary },
        item.recordKey,
        { minChars: options.minChars, maxChars: options.maxChars },
      );
      return true;
    } catch {
      return false;
    }
  }).length;
  const inTarget = items.filter(item => item.existingChars >= options.targetMin && item.existingChars <= options.targetMax).length;
  console.log(JSON.stringify({
    total: items.length,
    memoryLike,
    strictValid,
    inTarget,
    length: {
      p50: pct(0.5),
      p75: pct(0.75),
      p90: pct(0.9),
      max: lengths.at(-1) || 0,
    },
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
  }, null, 2));
}

const { command, options } = parseArgs(process.argv.slice(2));
try {
  if (command === "prepare") prepare(options);
  else if (command === "run") await run(options);
  else if (command === "merge") merge(options);
  else if (command === "status") status(options);
  else if (command === "audit") audit(options);
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
