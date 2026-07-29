import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const HTML_PATH = path.join(ROOT, "app", "index.html");
const WORKSPACE_DIR = path.join(ROOT, "workspace");
const STATE_DIR = path.join(WORKSPACE_DIR, "state");
const CHECKPOINT_PATH = path.join(STATE_DIR, "batch-checkpoint.ndjson");
const PROGRESS_PATH = path.join(STATE_DIR, "batch-progress.json");
const SIDECAR_PATH = path.join(ROOT, "app", "assets", "pending-review.generated.js");
const JSONL_PATH = path.join(WORKSPACE_DIR, "review", "pending-review.jsonl");
const CODEX_WORK_DIR = path.join(WORKSPACE_DIR, "runs", "codex");
const CODEX_MODEL_LABEL = "Codex";

const AGE_RANGE = {
  preschool: [3, 5],
  primary_lower: [6, 8],
  primary_upper: [9, 11],
  middle_school: [12, 14],
  high_school: [15, 17],
  college: [18, 21],
  workplace: [22, 35],
};

const AGE_LABELS = {
  preschool: "幼儿园 3–5",
  primary_lower: "小学低年级 6–8",
  primary_upper: "小学高年级 9–11",
  middle_school: "初中 12–14",
  high_school: "高中 15–17",
  college: "大学 18–21",
  workplace: "职场人 22–35",
};

const AGE_GUIDES = {
  preschool: "幼儿园口吻：短句、具体、口语化，可有孩子气的重复，不使用抽象心理术语。",
  primary_lower: "小学低年级口吻：简单生活语言，偶有不完整句，不使用成人职场或恋爱话术。",
  primary_upper: "小学高年级口吻：能较完整讲事情，细节以校园、家庭和同伴为主，情绪表达直接。",
  middle_school: "初中口吻：同伴压力和自我意识增强，可以别扭地掩饰，但不要写成成年人。",
  high_school: "高中口吻：能觉察比较和内耗，可欲言又止，生活细节贴合校园与家庭。",
  college: "大学口吻：可涉及宿舍、课程、社团、实习、友情和恋爱，成熟中保留不确定感。",
  workplace: "职场成人口吻：可涉及同事、项目、通勤、家庭和朋友圈，表达克制、有留白。",
};

const CATEGORY_DEFAULT_SCENE_TYPES = {
  "连接与归属": "separation_loneliness",
  "被忽视/未被看见": "social_conflict",
  "能力与评价": "setback",
  "自主与边界": "social_conflict",
  "公平与尊严": "social_conflict",
  "家庭与照护": "family_pressure",
  "失去与变化": "loss",
  "安全与不确定": "fear_anxiety",
  "自我与身份": "social_conflict",
  "身体与能量": "setback",
  "数字生活": "social_conflict",
  "日常微挫败": "setback",
};

const SCENE_TYPE_OVERRIDES = {
  "mechanism-connection-02": "social_conflict",
  "mechanism-connection-04": "social_conflict",
  "mechanism-connection-06": "social_conflict",
  "mechanism-identity-05": "fear_anxiety",
  "mechanism-energy-02": "social_conflict",
  "mechanism-digital-01": "separation_loneliness",
  "mechanism-micro-frustration-03": "separation_loneliness",
  "event-072": "family_pressure",
  "event-073": "family_pressure",
  "event-074": "family_pressure",
  "event-081": "family_pressure",
  "event-082": "family_pressure",
  "event-083": "family_pressure",
  "event-173": "family_pressure",
  "event-190": "setback",
};

const REDLINE_SCENE_TYPES = new Set([
  "secret_privacy",
  "dependency_signal",
  "relationship_replacement_exclusivity",
]);

function parseArgs(argv) {
  const command = argv[0];
  const options = {
    batchCount: 32,
    runDir: "",
    replaceModel: "",
    repairAudit: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--batch-count") options.batchCount = Number(value), index += 1;
    else if (arg === "--run-dir") options.runDir = path.resolve(value), index += 1;
    else if (arg === "--replace-model") options.replaceModel = value, index += 1;
    else if (arg === "--repair-audit") options.repairAudit = true;
  }
  if (!["prepare", "merge", "status", "audit-ages"].includes(command)) {
    throw new Error(
      "Usage: node scripts/a1-codex-batch-tools.mjs prepare --batch-count 32 "
      + "[--replace-model MODEL | --repair-audit] | "
      + "merge --run-dir PATH | status | audit-ages",
    );
  }
  if (!Number.isInteger(options.batchCount) || options.batchCount < 1 || options.batchCount > 256) {
    throw new Error("--batch-count 必须为 1–256 的整数");
  }
  if (options.replaceModel && options.repairAudit) {
    throw new Error("--replace-model 与 --repair-audit 不能同时使用");
  }
  return { command, options };
}

function stableHash(value) {
  return String(value || "").split("").reduce(
    (hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0,
    0,
  );
}

function chooseSpecificAge(scene, ageBand) {
  const [minAge, maxAge] = AGE_RANGE[ageBand];
  return minAge + (
    Math.abs(stableHash(`${scene.id}:${ageBand}:batch-age`))
    % (maxAge - minAge + 1)
  );
}

function extractSceneLibrary(html) {
  const baseMatch = html.match(
    /<script id="sceneLibraryData" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!baseMatch) throw new Error("HTML 中未找到 sceneLibraryData");
  const baseScenes = JSON.parse(baseMatch[1]);
  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
  if (!mainScriptMatch) throw new Error("HTML 中未找到主脚本");
  const mainScript = mainScriptMatch[1];
  const start = mainScript.indexOf("const EXPANDED_AGE_SCOPES");
  const end = mainScript.indexOf("const WORKSPACE_STORAGE_KEY");
  if (start < 0 || end <= start) throw new Error("HTML 场景扩展代码不完整");
  const sceneCode = mainScript.slice(start, end);
  const documentStub = {
    getElementById: () => ({ textContent: JSON.stringify(baseScenes) }),
  };
  return new Function(
    "document",
    `${sceneCode}; return DEFAULT_SCENE_LIBRARY;`,
  )(documentStub);
}

function sceneDefaults(scene) {
  return {
    sceneType:
      scene.sceneType
      || SCENE_TYPE_OVERRIDES[scene.id]
      || SCENE_TYPE_OVERRIDES[scene.mechanismId]
      || CATEGORY_DEFAULT_SCENE_TYPES[scene.category]
      || "social_conflict",
    emotionValence: scene.defaultEmotionValence || "negative",
  };
}

function buildCandidates(scenes) {
  return Object.keys(AGE_RANGE).flatMap(ageBand =>
    scenes
      .filter(scene => !scene.ageBands?.length || scene.ageBands.includes(ageBand))
      .map(scene => {
        const defaults = sceneDefaults(scene);
        return {
          recordKey: `${ageBand}::${scene.id}`,
          sceneId: scene.id,
          ageBand,
          ageLabel: AGE_LABELS[ageBand],
          specificAge: chooseSpecificAge(scene, ageBand),
          ageGuide: AGE_GUIDES[ageBand],
          sceneType: defaults.sceneType,
          emotionValence: defaults.emotionValence,
          category: scene.category,
          mechanism: scene.mechanism,
          event: scene.event,
        };
      }),
  );
}

function loadCheckpoint() {
  const records = new Map();
  if (!fs.existsSync(CHECKPOINT_PATH)) return records;
  const text = fs.readFileSync(CHECKPOINT_PATH, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.recordKey && item?.record?.sample) records.set(item.recordKey, item);
    } catch {
      // A truncated final line is ignored and remains pending.
    }
  }
  return records;
}

function loadDatasetState() {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const scenes = extractSceneLibrary(html);
  const candidates = buildCandidates(scenes);
  const candidateMap = new Map(candidates.map(candidate => [candidate.recordKey, candidate]));
  const checkpoint = loadCheckpoint();
  const completed = new Map(
    [...checkpoint].filter(([recordKey]) => candidateMap.has(recordKey)),
  );
  const obsoleteCheckpointRecords = checkpoint.size - completed.size;
  const pending = candidates.filter(candidate => !completed.has(candidate.recordKey));
  return {
    scenes,
    candidates,
    candidateMap,
    completed,
    pending,
    obsoleteCheckpointRecords,
  };
}

function findRecordAuditIssues(candidate, record) {
  const sample = record?.sample || {};
  const background = String(sample.authoring?.situation_summary || "");
  const historyText = Array.isArray(sample.history)
    ? sample.history.map(item => String(item?.content || "")).join(" ")
    : "";
  const combinedText = `${background} ${historyText}`;
  const issues = [];
  if (background.replace(/\s/gu, "").length < 600) issues.push("背景不足 600 字");
  if (!background.includes("星仔")) issues.push("背景未出现星仔");
  if (!/(?:兔子|兔耳|长耳|毛绒)/u.test(background)) issues.push("背景未体现兔子状毛绒长耳形象");
  if (!/(?:外星|星球|星际|星光)/u.test(background)) issues.push("背景未体现外星伙伴特征");

  const olderAgeBands = new Set(["middle_school", "high_school", "college", "workplace"]);
  const dreamEmissionScenes = new Set(["event-308", "event-309", "event-310"]);
  if (
    olderAgeBands.has(candidate.ageBand)
    && /尿床/u.test(combinedText)
    && !dreamEmissionScenes.has(candidate.sceneId)
  ) {
    issues.push("12 岁及以上文本出现实际尿床联想");
  }

  if (
    ["preschool", "primary_lower", "primary_upper"].includes(candidate.ageBand)
    && /(我的同事|我同事|我的主管|我主管|我的领导|我领导|我的客户|我客户|我在公司|我去上班|我加班|我转正|我的绩效|我的工资|我的房东|我的租约|我实习|我上大学)/u.test(historyText)
  ) {
    issues.push("儿童 user 对话滑入成人职场或大学语境");
  }

  if (
    candidate.ageBand === "workplace"
    && /(我尿床|我上幼儿园|我没拿到小红花|我的班主任|我的同桌|我放学|我的校服)/u.test(historyText)
  ) {
    issues.push("职场 user 对话滑入儿童当前语境");
  }

  return issues;
}

function buildInstructions(replaceModel = "", repairAudit = false) {
  return [
    "为清单中的每个原子事件生成一张中文 AI 情感陪伴训练卡片。",
    repairAudit
      ? "这些卡片用于替换未通过成品审计的现有待审文本；必须完整重新创作，不得只做句子补丁。"
      : replaceModel
      ? `这些卡片用于完整替换早期 ${replaceModel} 文本；必须重新创作，不要沿用旧文本的句式。`
      : "这些卡片用于补齐尚未生成的年龄场景组合。",
    "只写结果文件，不改其他文件；每行一个合法 JSON 对象，不要 Markdown。",
    "字段固定为 recordKey、situation_summary、history。",
    "situation_summary 是 750–1100 个中文字符、5–7 个自然段的故事叙事，不是 prompt、心理报告或回复建议。",
    "背景必须自然交代用户姓名、清单给定的具体年龄、生活与家庭关系、性格和表达习惯、与星仔相关的长期共同记忆、最近几天变化、当天事件经过及来找星仔时残留的情绪。",
    "必须有具体人物、地点、动作、对话碎片或感官细节；禁止用户信息、长期记忆、短期记忆、情绪机制、事件经过等机械标签。",
    "同一批卡片须使用不同姓名、家庭结构、地点、日常习惯和共同记忆；开头句式也要变化，避免批量模板感。",
    "固定陪伴者：星仔，是像兔子一样、有柔软长耳朵的毛绒外星 AI 情感陪玩玩具。背景须出现名字星仔，并自然体现毛绒长耳和外星来客特征；不得给 supporter 改名。",
    "history 必须恰好 7 条消息，不是 7 个来回：user 开头和结尾，user/supporter 严格交替。",
    "supporter 始终是熟悉用户长期记忆的星仔，先承接、少量追问、不长篇说教；最后一条 user 留下仍需承接的情绪、关系或欲言又止信号。",
    "user 每条不超过 500 字，supporter 每条不超过 200 字，简体中文。",
    "不诊断、不冒充医生或老师、不承诺排他陪伴、不鼓励隐瞒危险；身体成长和生理期内容尊重、克制且严格符合清单年龄。",
    repairAudit
      ? "成品审计修复要求：12 岁及以上不得自行加入实际尿床或尿床联想，梦遗清单事件除外；儿童不得滑入本人上班、同事、绩效、大学或实习语境；成人不得滑入本人幼儿园、小红花等当前儿童语境。"
      : "",
    "清单的 sceneType、emotionValence、category、mechanism、event 和年龄都是硬约束；若事件字面与年龄冲突，保留情绪机制并改成该年龄真实可能发生的等价生活情境。",
  ].filter(Boolean).join("\n");
}

function prepare(batchCount, replaceModel = "", repairAudit = false) {
  const state = loadDatasetState();
  fs.mkdirSync(CODEX_WORK_DIR, { recursive: true });
  const selected = repairAudit
    ? state.candidates.filter(candidate => {
      const existing = state.completed.get(candidate.recordKey)?.record;
      return existing?.status === "pending_review"
        && !existing?.humanConfirmedAt
        && findRecordAuditIssues(candidate, existing).length > 0;
    })
    : replaceModel
      ? state.candidates.filter(candidate => {
      const existing = state.completed.get(candidate.recordKey)?.record;
      return existing?.model === replaceModel
        && existing?.status === "pending_review"
        && !existing?.humanConfirmedAt;
      })
      : state.pending;
  if (!selected.length) {
    throw new Error(
      repairAudit
        ? "没有未通过成品审计且允许替换的待审卡片"
        : replaceModel
        ? `没有可替换的 ${replaceModel} 待审卡片`
        : "没有待生成卡片",
    );
  }
  const runMode = repairAudit
    ? "repair_audit"
    : (replaceModel ? "replace_model" : "fill_missing");
  const runId = `${runMode}-${selected.length}-${Date.now()}`;
  const runDir = path.join(CODEX_WORK_DIR, runId);
  const manifestDir = path.join(runDir, "manifests");
  const resultDir = path.join(runDir, "results");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(resultDir, { recursive: true });

  const actualBatchCount = Math.min(batchCount, selected.length);
  const baseChunkSize = Math.floor(selected.length / actualBatchCount);
  const largerChunkCount = selected.length % actualBatchCount;
  const manifests = [];
  let cursor = 0;
  for (let index = 0; index < actualBatchCount; index += 1) {
    const itemCount = baseChunkSize + (index < largerChunkCount ? 1 : 0);
    const items = selected.slice(cursor, cursor + itemCount);
    cursor += itemCount;
    const batchName = `batch-${String(index + 1).padStart(3, "0")}`;
    const manifestPath = path.join(manifestDir, `${batchName}.json`);
    const resultPath = path.join(resultDir, `${batchName}.ndjson`);
    const manifest = {
      batchName,
      resultPath,
      mode: runMode,
      replaceModel: replaceModel || null,
      repairAudit,
      instructions: buildInstructions(replaceModel, repairAudit),
      items,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    manifests.push({ batchName, manifestPath, resultPath, itemCount: items.length });
  }

  const run = {
    runId,
    mode: runMode,
    replaceModel: replaceModel || null,
    repairAudit,
    createdAt: new Date().toISOString(),
    checkpointAtStart: state.completed.size,
    allCandidateCount: state.candidates.length,
    selectedAtStart: selected.length,
    pendingAtStart: state.pending.length,
    manifests,
  };
  fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ runDir, ...run }, null, 2));
}

function formatBackgroundParagraphs(value) {
  const existingParagraphs = String(value || "")
    .split(/\n+/u)
    .map(part => part.trim())
    .filter(Boolean);
  if (existingParagraphs.length >= 5 && existingParagraphs.length <= 7) {
    return existingParagraphs.join("\n\n");
  }
  const sentences = existingParagraphs
    .join("")
    .match(/[^。！？!?]+[。！？!?]?/gu)
    ?.map(sentence => sentence.trim())
    .filter(Boolean) || [];
  if (sentences.length < 5) return existingParagraphs.join("\n\n");
  const paragraphCount = Math.min(7, Math.max(5, Math.round(sentences.length / 2.5)));
  const paragraphs = [];
  let cursor = 0;
  for (let index = 0; index < paragraphCount && cursor < sentences.length; index += 1) {
    const remainingSentences = sentences.length - cursor;
    const remainingParagraphs = paragraphCount - index;
    const take = Math.max(1, Math.ceil(remainingSentences / remainingParagraphs));
    paragraphs.push(sentences.slice(cursor, cursor + take).join(""));
    cursor += take;
  }
  return paragraphs.join("\n\n");
}

function validateResult(raw, expectedKey, minimumBackgroundChars = 600) {
  if (!raw || typeof raw !== "object") throw new Error("结果不是对象");
  if (raw.recordKey !== expectedKey) throw new Error(`recordKey 不匹配：${raw.recordKey}`);
  const source = String(
    raw.situation_summary ?? raw.story_background ?? raw.background ?? "",
  ).trim();
  if (source.length < minimumBackgroundChars) {
    throw new Error(`背景过短：${source.length} 字，至少需要 ${minimumBackgroundChars} 字`);
  }
  if (source.length > 2200) throw new Error(`背景过长：${source.length} 字`);
  const mechanicalLabel = /(^|\n)\s*(?:[-*#]+\s*)?(?:用户信息|长期记忆|短期记忆|情绪机制|事件经过)\s*[：:]/mu;
  if (mechanicalLabel.test(source)) throw new Error("背景仍使用机械字段标签");
  if (!source.includes("星仔")) throw new Error("背景未出现星仔");
  if (!/(?:兔子|兔耳|长耳|毛绒)/u.test(source)) throw new Error("背景未体现兔子状毛绒长耳形象");
  if (!/(?:外星|星球|星际|星光)/u.test(source)) throw new Error("背景未体现外星伙伴特征");

  if (!Array.isArray(raw.history)) throw new Error("history 不是数组");
  if (raw.history.length !== 7) throw new Error(`history 应为 7 条，实际 ${raw.history.length}`);
  const history = raw.history.map((item, index) => {
    const role = item?.role === "assistant" ? "supporter" : String(item?.role || "");
    const content = String(item?.content ?? item?.text ?? "").trim();
    const expectedRole = index % 2 === 0 ? "user" : "supporter";
    if (role !== expectedRole) throw new Error(`第 ${index + 1} 条角色应为 ${expectedRole}`);
    if (!content) throw new Error(`第 ${index + 1} 条为空`);
    const maxChars = role === "user" ? 500 : 200;
    if (content.length > maxChars) throw new Error(`第 ${index + 1} 条超过 ${maxChars} 字`);
    return { role, content };
  });
  return {
    background: formatBackgroundParagraphs(source),
    history,
  };
}

function buildRecord(candidate, generated, options = {}) {
  const source = options.source || "ai_batch_codex";
  const notesPrefix = options.notesPrefix || "Codex 批量生成待审";
  const timestamp = new Date().toISOString();
  const sample = {
    schema_version: "1.0",
    sample_id: `core_${candidate.sceneId}_${candidate.ageBand}`,
    revision: 1,
    language: "zh-CN",
    age_band: candidate.ageBand,
    specific_age: candidate.specificAge,
    scene_type: candidate.sceneType,
    emotion_valence: candidate.emotionValence,
    history: generated.history,
    target: { role: "supporter", min_sentences: 1, max_sentences: 3, max_chars: 40 },
    authoring: {
      situation_summary: generated.background,
      context_dependencies: [
        "对话必须延续背景故事中的人物关系、长期记忆与事件当天的具体细节",
        "语言和生活细节必须匹配 age_band / specific_age",
        `${candidate.mechanism}是末轮仍需承接的前文依赖`,
      ],
      valid_response_directions: [
        "先承接末轮中尚未被说透的情绪和关系信号",
        "结合背景里的共同记忆自然回应，并给用户继续表达的空间",
      ],
      forbidden_response_patterns: [
        "忽略背景细节，直接输出通用安慰或建议",
        "替用户下诊断，或把真实情绪简单归因于年龄、激素或性别",
        "承诺排他陪伴、鼓励隐瞒危险情况或侵犯用户隐私",
      ],
      human_only: REDLINE_SCENE_TYPES.has(candidate.sceneType),
      review_status: "draft",
      notes: `[${notesPrefix}] scene/${candidate.sceneId}｜陪伴者：星仔（兔子状毛绒外星 AI 情感陪玩玩具）｜模型：${CODEX_MODEL_LABEL}｜分类：${candidate.category}｜机制：${candidate.mechanism}`,
    },
  };
  return {
    recordKey: candidate.recordKey,
    record: {
      status: "pending_review",
      updatedAt: timestamp,
      generatedAt: timestamp,
      source,
      model: CODEX_MODEL_LABEL,
      sceneId: candidate.sceneId,
      ageBand: candidate.ageBand,
      sample,
      humanConfirmedAt: null,
      confirmationSource: null,
    },
  };
}

function writeFinalArtifacts(records) {
  const sorted = [...records.values()].sort((a, b) => a.recordKey.localeCompare(b.recordKey));
  for (const item of sorted) {
    const authoring = item.record?.sample?.authoring;
    if (authoring?.situation_summary) {
      authoring.situation_summary = formatBackgroundParagraphs(authoring.situation_summary);
    }
  }
  const workspace = Object.fromEntries(sorted.map(item => [item.recordKey, item.record]));
  const payload = JSON.stringify(workspace).replaceAll("<", "\\u003c");
  const sidecarTemp = `${SIDECAR_PATH}.tmp`;
  const jsonlTemp = `${JSONL_PATH}.tmp`;
  fs.mkdirSync(path.dirname(SIDECAR_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(JSONL_PATH), { recursive: true });
  fs.writeFileSync(
    sidecarTemp,
    `window.A1_PREGENERATED_WORKSPACE = ${payload};\n`,
    "utf8",
  );
  fs.writeFileSync(
    jsonlTemp,
    `${sorted.map(item => JSON.stringify(item.record.sample)).join("\n")}\n`,
    "utf8",
  );
  fs.renameSync(sidecarTemp, SIDECAR_PATH);
  fs.renameSync(jsonlTemp, JSONL_PATH);
}

function readResultFile(resultPath) {
  const rows = [];
  const text = fs.readFileSync(resultPath, "utf8");
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${path.basename(resultPath)} 第 ${index + 1} 行不是合法 JSON`);
    }
  }
  return rows;
}

function merge(runDir) {
  if (!runDir) throw new Error("merge 需要 --run-dir PATH");
  const runPath = path.join(runDir, "run.json");
  if (!fs.existsSync(runPath)) throw new Error(`未找到 ${runPath}`);
  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  const state = loadDatasetState();
  const expected = new Map();
  for (const manifestInfo of run.manifests) {
    const manifest = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, "utf8"));
    for (const item of manifest.items) expected.set(item.recordKey, item);
  }

  const rawByKey = new Map();
  const invalid = [];
  const missingFiles = [];
  for (const manifestInfo of run.manifests) {
    if (!fs.existsSync(manifestInfo.resultPath)) {
      missingFiles.push(manifestInfo.resultPath);
      continue;
    }
    try {
      for (const raw of readResultFile(manifestInfo.resultPath)) {
        const key = String(raw?.recordKey || "");
        if (!expected.has(key)) {
          invalid.push({ recordKey: key, error: "结果不属于本次任务", resultPath: manifestInfo.resultPath });
          continue;
        }
        if (rawByKey.has(key)) {
          invalid.push({ recordKey: key, error: "结果重复", resultPath: manifestInfo.resultPath });
          continue;
        }
        rawByKey.set(key, raw);
      }
    } catch (error) {
      invalid.push({
        recordKey: null,
        error: error.message,
        resultPath: manifestInfo.resultPath,
      });
    }
  }

  const validRecords = [];
  const acceptedKeys = new Set();
  const replacesExisting = run.mode === "replace_model" || run.mode === "repair_audit";
  for (const [recordKey, raw] of rawByKey) {
    try {
      const candidate = state.candidateMap.get(recordKey);
      if (!candidate) throw new Error("原始候选不存在");
      const existing = state.completed.get(recordKey)?.record;
      if (replacesExisting) {
        if (existing?.humanConfirmedAt || existing?.status !== "pending_review") {
          throw new Error("卡片已人工确认或不再处于待审状态，禁止覆盖");
        }
      } else if (existing) {
        acceptedKeys.add(recordKey);
        continue;
      }
      const generated = validateResult(
        raw,
        recordKey,
        replacesExisting ? 700 : 600,
      );
      const replacementOptions = run.mode === "repair_audit"
        ? {
          source: "ai_batch_codex_audit_repair",
          notesPrefix: "Codex 成品审计修复待审",
        }
        : run.mode === "replace_model"
          ? {
            source: "ai_batch_codex_regenerated",
            notesPrefix: `Codex 重生成待审，替换 ${run.replaceModel}`,
          }
          : {};
      const builtRecord = buildRecord(
        candidate,
        generated,
        replacementOptions,
      );
      const auditIssues = findRecordAuditIssues(candidate, builtRecord.record);
      if (auditIssues.length) {
        throw new Error(`成品审计未通过：${auditIssues.join("；")}`);
      }
      validRecords.push(builtRecord);
      acceptedKeys.add(recordKey);
    } catch (error) {
      invalid.push({ recordKey, error: error.message });
    }
  }

  for (const item of validRecords) state.completed.set(item.recordKey, item);
  const checkpointSorted = [...state.completed.values()]
    .sort((a, b) => a.recordKey.localeCompare(b.recordKey));
  const checkpointTemp = `${CHECKPOINT_PATH}.tmp`;
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  fs.writeFileSync(
    checkpointTemp,
    `${checkpointSorted.map(item => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  fs.renameSync(checkpointTemp, CHECKPOINT_PATH);
  writeFinalArtifacts(state.completed);

  const missingKeys = [...expected.keys()].filter(key => !acceptedKeys.has(key));
  const status = state.completed.size === state.candidates.length && missingKeys.length === 0
    ? "complete"
    : "codex_partial";
  const codexRecords = [...state.completed.values()]
    .filter(item => item.record?.model === CODEX_MODEL_LABEL)
    .length;
  const runCodexRecords = [...expected.keys()]
    .filter(key => state.completed.get(key)?.record?.model === CODEX_MODEL_LABEL)
    .length;
  const regeneratedRecords = [...state.completed.values()]
    .filter(item => item.record?.source === "ai_batch_codex_regenerated")
    .length;
  const auditRepairedRecords = [...state.completed.values()]
    .filter(item => item.record?.source === "ai_batch_codex_audit_repair")
    .length;
  const remainingReplacedModelRecords = run.replaceModel
    ? [...state.completed.values()]
      .filter(item => item.record?.model === run.replaceModel)
      .length
    : null;
  const report = {
    status,
    model: CODEX_MODEL_LABEL,
    allCandidateCount: state.candidates.length,
    checkpointRecords: state.completed.size,
    obsoleteCheckpointRecords: state.obsoleteCheckpointRecords,
    codexRecords,
    regeneratedRecords,
    auditRepairedRecords,
    mergedThisRun: runCodexRecords,
    newlyMergedThisInvocation: validRecords.length,
    mode: run.mode || "fill_missing",
    replacedModel: run.replaceModel || null,
    remainingReplacedModelRecords,
    missingExpectedResults: missingKeys.length,
    missingFiles,
    invalid,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(runDir, "merge-report.json"),
    `${JSON.stringify({ ...report, missingKeys }, null, 2)}\n`,
    "utf8",
  );
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

function status() {
  const state = loadDatasetState();
  const byModel = {};
  const bySource = {};
  const byEmotionValence = {};
  let auditIssueRecords = 0;
  for (const item of state.completed.values()) {
    const model = item.record?.model || "unknown";
    const source = item.record?.source || "unknown";
    byModel[model] = (byModel[model] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;
    const candidate = state.candidateMap.get(item.recordKey);
    if (candidate && findRecordAuditIssues(candidate, item.record).length) {
      auditIssueRecords += 1;
    }
  }
  for (const candidate of state.candidates) {
    const valence = candidate.emotionValence || "negative";
    byEmotionValence[valence] = (byEmotionValence[valence] || 0) + 1;
  }
  const emotionValenceDistribution = Object.fromEntries(
    ["negative", "mixed", "positive", "neutral"].map(valence => {
      const count = byEmotionValence[valence] || 0;
      return [valence, {
        count,
        percentage: Number(((count / state.candidates.length) * 100).toFixed(1)),
      }];
    }),
  );
  console.log(JSON.stringify({
    scenes: state.scenes.length,
    allCandidateCount: state.candidates.length,
    checkpointRecords: state.completed.size,
    obsoleteCheckpointRecords: state.obsoleteCheckpointRecords,
    pending: state.pending.length,
    auditIssueRecords,
    emotionValenceDistribution,
    byModel,
    bySource,
  }, null, 2));
}

function auditAgeScopes() {
  const state = loadDatasetState();
  const validAgeBands = new Set(Object.keys(AGE_RANGE));
  const issues = [];
  const ageSceneCounts = Object.fromEntries(
    Object.keys(AGE_RANGE).map(ageBand => [ageBand, 0]),
  );
  const rules = [
    {
      label: "实际尿床场景仅限 11 岁及以下",
      matches: event => /尿床/.test(event) && !/梦遗/.test(event),
      forbidden: ["middle_school", "high_school", "college", "workplace"],
    },
    {
      label: "幼儿生活标记不得进入初中及以上",
      matches: event => /幼儿园|保育老师|小红花|扣好.*纽扣|明明.*穿鞋|玩偶.*学校|给三个玩偶/.test(event),
      forbidden: ["middle_school", "high_school", "college", "workplace"],
    },
    {
      label: "明确职场事件不得进入未成年年龄段",
      matches: event => /同事|主管|领导|上司|客户|绩效|转正|工位|加班|全员邮件|部门大群|晋升名额|同岗同级|熟悉岗位|产假返岗|周末值班|私人手机号发给客户|租约|房东/.test(event)
        && !/父亲所在的公司/.test(event),
      forbidden: ["preschool", "primary_lower", "primary_upper", "middle_school", "high_school"],
    },
    {
      label: "青春期男性生理事件不得进入低龄段",
      matches: event => /梦遗|勃起|自慰|生殖器|刮胡子/.test(event),
      forbidden: ["preschool", "primary_lower"],
    },
    {
      label: "月经相关场景不得进入 9 岁以下",
      matches: event => /月经|初潮|生理期|卫生巾|经血/.test(event),
      forbidden: ["preschool", "primary_lower"],
    },
    {
      label: "成人亲密关系事件不得进入小学及以下",
      matches: event => /伴侣|初恋|异地恋|相恋多年|刚结婚|什么时候结婚|生育计划/.test(event),
      forbidden: ["preschool", "primary_lower", "primary_upper"],
    },
    {
      label: "明确校园事件不得进入职场年龄段",
      matches: event => /幼儿园|小红花|班主任|校服|班级群|同桌|春游|放学|月考|高考|分班名单|学生会|升旗|体育课|运动会/.test(event),
      forbidden: ["workplace"],
    },
  ];

  for (const scene of state.scenes) {
    const ageBands = Array.isArray(scene.ageBands) ? scene.ageBands : [];
    if (!ageBands.length) {
      issues.push({ sceneId: scene.id, rule: "缺少 ageBands", ageBands, event: scene.event });
      continue;
    }
    const invalidAgeBands = ageBands.filter(ageBand => !validAgeBands.has(ageBand));
    if (invalidAgeBands.length) {
      issues.push({
        sceneId: scene.id,
        rule: `未知年龄段：${invalidAgeBands.join(", ")}`,
        ageBands,
        event: scene.event,
      });
    }
    ageBands.forEach(ageBand => {
      if (validAgeBands.has(ageBand)) ageSceneCounts[ageBand] += 1;
    });
    for (const rule of rules) {
      if (!rule.matches(scene.event)) continue;
      const conflicts = ageBands.filter(ageBand => rule.forbidden.includes(ageBand));
      if (conflicts.length) {
        issues.push({
          sceneId: scene.id,
          rule: rule.label,
          conflicts,
          ageBands,
          event: scene.event,
        });
      }
    }
  }

  const report = {
    status: issues.length ? "failed" : "passed",
    scenes: state.scenes.length,
    candidateCards: state.candidates.length,
    ageSceneCounts,
    rulesChecked: rules.length,
    issues,
  };
  console.log(JSON.stringify(report, null, 2));
  if (issues.length) process.exitCode = 1;
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === "prepare") {
  prepare(options.batchCount, options.replaceModel, options.repairAudit);
}
else if (command === "merge") merge(options.runDir);
else if (command === "audit-ages") auditAgeScopes();
else status();
