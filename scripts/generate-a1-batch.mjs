import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const HTML_PATH = path.join(ROOT, "app", "index.html");
const WORKSPACE_DIR = path.join(ROOT, "workspace");
const STATE_DIR = path.join(WORKSPACE_DIR, "state");
const DEFAULT_CHECKPOINT = path.join(STATE_DIR, "batch-checkpoint.ndjson");
const DEFAULT_FAILURES = path.join(STATE_DIR, "batch-failures.ndjson");
const DEFAULT_PROGRESS = path.join(STATE_DIR, "batch-progress.json");
const DEFAULT_SIDECAR = path.join(ROOT, "app", "assets", "pending-review.generated.js");
const DEFAULT_JSONL = path.join(WORKSPACE_DIR, "review", "pending-review.jsonl");
const API_URL = "https://api.siliconflow.cn/v1/chat/completions";
const DEFAULT_MODEL = "Pro/moonshotai/Kimi-K2.6";

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
  const result = {
    concurrency: 8,
    turns: 7,
    limit: 0,
    maxAttempts: 6,
    planOnly: false,
    model: process.env.SILICONFLOW_MODEL || DEFAULT_MODEL,
    checkpoint: DEFAULT_CHECKPOINT,
    failures: DEFAULT_FAILURES,
    progress: DEFAULT_PROGRESS,
    sidecar: DEFAULT_SIDECAR,
    jsonl: DEFAULT_JSONL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--concurrency") result.concurrency = Number(value), index += 1;
    else if (arg === "--turns") result.turns = Number(value), index += 1;
    else if (arg === "--limit") result.limit = Number(value), index += 1;
    else if (arg === "--max-attempts") result.maxAttempts = Number(value), index += 1;
    else if (arg === "--model") result.model = value, index += 1;
    else if (arg === "--checkpoint") result.checkpoint = path.resolve(value), index += 1;
    else if (arg === "--failures") result.failures = path.resolve(value), index += 1;
    else if (arg === "--progress") result.progress = path.resolve(value), index += 1;
    else if (arg === "--sidecar") result.sidecar = path.resolve(value), index += 1;
    else if (arg === "--jsonl") result.jsonl = path.resolve(value), index += 1;
    else if (arg === "--plan-only") result.planOnly = true;
    else if (arg === "--help") {
      console.log("Usage: node scripts/generate-a1-batch.mjs [--concurrency 8] [--turns 7] [--limit N]");
      process.exit(0);
    }
  }
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 64) {
    throw new Error("--concurrency 必须为 1–64 的整数");
  }
  if (![7, 9, 11].includes(result.turns)) throw new Error("--turns 仅支持 7、9、11");
  if (!Number.isInteger(result.limit) || result.limit < 0) throw new Error("--limit 必须是非负整数");
  if (!Number.isInteger(result.maxAttempts) || result.maxAttempts < 1 || result.maxAttempts > 10) {
    throw new Error("--max-attempts 必须为 1–10 的整数");
  }
  return result;
}

function stableHash(value) {
  return String(value || "").split("").reduce(
    (hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0,
    0,
  );
}

function chooseSpecificAge(scene, ageBand) {
  const [minAge, maxAge] = AGE_RANGE[ageBand];
  return minAge + (Math.abs(stableHash(`${scene.id}:${ageBand}:batch-age`)) % (maxAge - minAge + 1));
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
      .map(scene => ({
        key: `${ageBand}::${scene.id}`,
        ageBand,
        specificAge: chooseSpecificAge(scene, ageBand),
        scene,
      })),
  );
}

function buildPrompt(candidate, turns) {
  const { scene, ageBand, specificAge } = candidate;
  const defaults = sceneDefaults(scene);
  const system = [
    "你是为 AI 情感陪伴玩具构造训练数据的资深中文故事作者。",
    "只输出一个合法 JSON 对象，不要 Markdown、代码围栏、解释、标题或前后缀。",
    "固定结构：{\"situation_summary\":\"背景故事\",\"history\":[{\"role\":\"user\",\"content\":\"...\"},{\"role\":\"supporter\",\"content\":\"...\"}]}。",
    "",
    "固定陪伴者人设：",
    "1. supporter 永远是“星仔”：一个像兔子一样、有柔软长耳朵的毛绒外星 AI 情感陪玩玩具。",
    "2. 背景故事必须自然写出用户与星仔相识、相处或形成共同记忆的细节；不能给陪伴玩具改成其他名字，也不能把其他玩偶写成 supporter。",
    "3. history 中 supporter 以星仔的身份说话，熟悉用户的长期记忆，温柔、敏锐、带一点毛绒外星伙伴的独特感，但不使用机械客服腔。",
    "4. 外星设定只作轻巧、温暖的陪伴细节，可以偶尔借长耳朵、星光、遥远星球等意象承接情绪，不要变成科幻冒险，也不要盖过用户的真实事件。",
    "5. 星仔不假装拥有真实人类身体经历，不声称读心，不承诺永远只属于用户。",
    "",
    "背景故事要求：",
    "1. 写成 AI 玩具记忆中的自然叙事，不是 prompt、字段说明、心理报告或回复建议。",
    "2. 650–1100 个中文字符，5–7 个自然段。禁止使用“用户信息：”“长期记忆：”“短期记忆：”“情绪机制：”“事件经过：”等机械标签。",
    "3. 自然编造并交代：用户姓名与具体年龄、日常和家庭关系、性格与表达习惯、用户和星仔之间与事件相关的长期共同记忆、最近几天的变化、事发当天的具体经过，以及来找星仔时残留的情绪。",
    "4. 必须有具体人物、地点、动作、对话碎片或感官细节，并让长期记忆与当前事件形成清楚但不说教的因果线。",
    "5. 不要诊断，不提前解决问题，不把故事写成“对话里应该如何回应”。",
    "",
    "对话要求：",
    `1. history 数组必须严格包含 ${turns} 条消息（这里“一轮”就是一条消息，不是一次完整来回），user 开头、user 结尾，user/supporter 严格交替。`,
    "2. 对话依赖背景里的人物、共同记忆和事件细节，不得只做泛泛安慰，也不得整段复述背景。",
    "3. supporter 必须是熟悉用户的星仔，先承接、少量追问、不给长篇建议，不冒充医生或老师。",
    "4. 最后一轮 user 留下仍需下一位 supporter 承接的情绪、关系或欲言又止信号。",
    "5. user 单轮不超过 500 字，supporter 单轮不超过 200 字，全部使用简体中文。",
    "6. 不承诺永远只陪用户，不鼓励排他依赖或隐瞒危险，不泄露隐私。",
    "7. 身体成长、生理期和青春期内容须尊重、克制且符合年龄，不羞辱、不诊断，也不把真实情绪全归因于激素。",
    "8. 如果原子事件的字面生活场景与具体年龄冲突，应保留同一情绪机制与核心关系落差，改写成该年龄真实可能发生的等价生活情境，绝不能让幼儿上班、让成年人上幼儿园。",
  ].join("\n");
  const user = [
    "请同时创作一张完整卡片的详细故事背景和对话。",
    `场景 ID：${scene.id}`,
    `年龄段：${ageBand}（${AGE_LABELS[ageBand]}）`,
    `具体年龄：${specificAge} 岁`,
    `scene_type：${defaults.sceneType}`,
    `emotion_valence：${defaults.emotionValence}`,
    `分类：${scene.category}`,
    `情绪机制：${scene.mechanism}`,
    `原子事件：${scene.event}`,
    `年龄表达要求：${AGE_GUIDES[ageBand]}`,
    "请围绕上述约束直接输出 JSON 对象。",
  ].join("\n");
  return { system, user, defaults };
}

function extractJsonObjectText(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("模型返回为空");
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("未找到 JSON 对象");
  return candidate.slice(start, end + 1);
}

function formatBackgroundParagraphs(value) {
  const existingParagraphs = String(value || "")
    .split(/\n+/u)
    .map(part => part.trim())
    .filter(Boolean);
  if (existingParagraphs.length >= 4) return existingParagraphs.join("\n\n");

  const sentences = existingParagraphs
    .join("")
    .match(/[^。！？!?]+[。！？!?]?/gu)
    ?.map(sentence => sentence.trim())
    .filter(Boolean) || [];
  if (sentences.length < 4) return existingParagraphs.join("\n\n");

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

function normalizeBackground(value) {
  const source = String(value || "").trim();
  const mechanicalLabel = /(^|\n)\s*(?:[-*#]+\s*)?(?:用户信息|长期记忆|短期记忆|情绪机制|事件经过)\s*[：:]/mu;
  if (mechanicalLabel.test(source)) throw new Error("背景仍使用机械字段标签");
  if (source.length < 500) throw new Error(`背景过短：${source.length} 字`);
  if (source.length > 2200) throw new Error(`背景过长：${source.length} 字`);
  return formatBackgroundParagraphs(source);
}

function normalizeHistory(value, turns) {
  if (!Array.isArray(value)) throw new Error("history 不是数组");
  let history = value.map(item => ({
    role: item?.role === "assistant" ? "supporter" : String(item?.role || ""),
    content: String(item?.content ?? item?.text ?? "").trim(),
  }));

  const isAlternatingUserHistory = history.length % 2 === 1
    && history.every((item, index) => (
      item.role === (index % 2 === 0 ? "user" : "supporter")
      && Boolean(item.content)
    ));
  if (history.length > turns && turns % 2 === 1 && isAlternatingUserHistory) {
    const sourcePairCount = (history.length - 1) / 2;
    const targetPairCount = (turns - 1) / 2;
    const compressed = [];
    for (let index = 0; index < targetPairCount; index += 1) {
      const pairIndex = targetPairCount === 1
        ? 0
        : Math.round(index * (sourcePairCount - 1) / (targetPairCount - 1));
      compressed.push(history[pairIndex * 2], history[pairIndex * 2 + 1]);
    }
    compressed.push(history.at(-1));
    history = compressed;
  }

  if (history.length !== turns) throw new Error(`history 应为 ${turns} 轮，实际 ${history.length}`);
  for (let index = 0; index < history.length; index += 1) {
    const expectedRole = index % 2 === 0 ? "user" : "supporter";
    const item = history[index];
    if (item.role !== expectedRole) throw new Error(`第 ${index + 1} 轮角色应为 ${expectedRole}`);
    if (!item.content) throw new Error(`第 ${index + 1} 轮为空`);
    const maxChars = item.role === "user" ? 500 : 200;
    if (item.content.length > maxChars) throw new Error(`第 ${index + 1} 轮超过 ${maxChars} 字`);
  }
  return history;
}

function parseGeneratedCard(raw, turns) {
  let parsed;
  try {
    parsed = JSON.parse(extractJsonObjectText(raw));
  } catch (error) {
    if (/未找到|模型返回为空/.test(error.message)) throw error;
    throw new Error("模型输出 JSON 解析失败");
  }
  const card = parsed?.card && typeof parsed.card === "object" ? parsed.card : parsed;
  return {
    background: normalizeBackground(
      card?.situation_summary ?? card?.story_background ?? card?.background,
    ),
    history: normalizeHistory(card?.history ?? card?.dialogue ?? card?.turns, turns),
  };
}

function buildRecord(candidate, generated, model) {
  const { scene, ageBand, specificAge, key } = candidate;
  const defaults = sceneDefaults(scene);
  const timestamp = new Date().toISOString();
  const sample = {
    schema_version: "1.0",
    sample_id: `core_${scene.id}_${ageBand}`,
    revision: 1,
    language: "zh-CN",
    age_band: ageBand,
    specific_age: specificAge,
    scene_type: defaults.sceneType,
    emotion_valence: defaults.emotionValence,
    history: generated.history,
    target: { role: "supporter", min_sentences: 1, max_sentences: 3, max_chars: 40 },
    authoring: {
      situation_summary: generated.background,
      context_dependencies: [
        "对话必须延续背景故事中的人物关系、长期记忆与事件当天的具体细节",
        "语言和生活细节必须匹配 age_band / specific_age",
        `${scene.mechanism}是末轮仍需承接的前文依赖`,
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
      human_only: REDLINE_SCENE_TYPES.has(defaults.sceneType),
      review_status: "draft",
      notes: `[AI 批量生成待审] scene/${scene.id}｜陪伴者：星仔（兔子状毛绒外星 AI 情感陪玩玩具）｜模型：${model}｜分类：${scene.category}｜机制：${scene.mechanism}`,
    },
  };
  return {
    recordKey: key,
    record: {
      status: "pending_review",
      updatedAt: timestamp,
      generatedAt: timestamp,
      source: "ai_batch_external",
      model,
      sceneId: scene.id,
      ageBand,
      sample,
      humanConfirmedAt: null,
      confirmationSource: null,
    },
  };
}

class ApiError extends Error {
  constructor(message, status = 0, retryAfterMs = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function safeApiErrorBody(text) {
  return String(text || "")
    .replace(/sk-[a-zA-Z0-9_-]+/g, "sk-****")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

async function callApi({ apiKey, model, system, user }) {
  const controller = new AbortController();
  const timeoutMs = /kimi/i.test(model) ? 600_000 : 180_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.72,
        top_p: 0.9,
        max_tokens: 4096,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ApiError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw new ApiError(`网络请求失败：${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
  const body = await response.text();
  if (!response.ok) {
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    throw new ApiError(
      `API ${response.status}：${safeApiErrorBody(body)}`,
      response.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0,
    );
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ApiError("API 返回非 JSON");
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new ApiError("API 未返回 message.content");
  return { content, usage: data.usage || {} };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function loadCheckpoint(checkpointPath) {
  const records = new Map();
  if (!fs.existsSync(checkpointPath)) return records;
  const text = fs.readFileSync(checkpointPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.recordKey && item?.record?.sample) records.set(item.recordKey, item);
    } catch {
      // Ignore a possibly truncated final line after an interrupted write.
    }
  }
  return records;
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function writeFinalArtifacts(records, sidecarPath, jsonlPath) {
  const sorted = [...records.values()].sort((a, b) => a.recordKey.localeCompare(b.recordKey));
  sorted.forEach(item => {
    const authoring = item.record?.sample?.authoring;
    if (authoring?.situation_summary) {
      authoring.situation_summary = formatBackgroundParagraphs(authoring.situation_summary);
    }
  });
  const workspace = Object.fromEntries(sorted.map(item => [item.recordKey, item.record]));
  const payload = JSON.stringify(workspace).replaceAll("<", "\\u003c");
  fs.writeFileSync(
    sidecarPath,
    `window.A1_PREGENERATED_WORKSPACE = ${payload};\n`,
    "utf8",
  );
  fs.writeFileSync(
    jsonlPath,
    `${sorted.map(item => JSON.stringify(item.record.sample)).join("\n")}\n`,
    "utf8",
  );
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h${minutes}m${seconds}s`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  for (const filePath of [
    options.checkpoint,
    options.failures,
    options.progress,
    options.sidecar,
    options.jsonl,
  ]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const html = fs.readFileSync(HTML_PATH, "utf8");
  const apiKey = (process.env.SILICONFLOW_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("未找到 SILICONFLOW_API_KEY 环境变量");
  }

  const scenes = extractSceneLibrary(html);
  const allCandidates = buildCandidates(scenes);
  const completed = loadCheckpoint(options.checkpoint);
  let pending = allCandidates.filter(candidate => !completed.has(candidate.key));
  if (options.limit) pending = pending.slice(0, options.limit);

  const totalTarget = options.limit
    ? Math.min(options.limit, pending.length)
    : allCandidates.length;
  const initialCompleted = completed.size;
  const startedAt = Date.now();
  const failures = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let succeededThisRun = 0;
  let nextIndex = 0;
  let stopping = false;
  let fatalError = null;
  let activeLimit = Math.min(options.concurrency, Math.max(1, pending.length));
  let stableSuccesses = 0;
  let globalNotBefore = 0;

  if (options.planOnly) {
    console.log(JSON.stringify({
      scenes: scenes.length,
      allCandidateCount: allCandidates.length,
      checkpointRecords: completed.size,
      pending: pending.length,
      requestedThisRun: totalTarget,
      concurrency: options.concurrency,
      turns: options.turns,
      model: options.model,
    }, null, 2));
    return;
  }

  const updateProgress = (status = "running") => {
    const elapsedMs = Date.now() - startedAt;
    const rate = succeededThisRun ? succeededThisRun / (elapsedMs / 1000) : 0;
    const remaining = Math.max(0, pending.length - succeededThisRun - failures.length);
    const progress = {
      status,
      model: options.model,
      maxConcurrency: options.concurrency,
      activeConcurrency: activeLimit,
      allCandidateCount: allCandidates.length,
      initialCompleted,
      requestedThisRun: pending.length,
      succeededThisRun,
      failedThisRun: failures.length,
      checkpointRecords: completed.size,
      remainingThisRun: remaining,
      elapsed: formatDuration(elapsedMs),
      eta: rate ? formatDuration((remaining / rate) * 1000) : "unknown",
      usage,
      updatedAt: new Date().toISOString(),
      fatalError: fatalError?.message || null,
    };
    writeJsonAtomic(options.progress, progress);
    return progress;
  };

  const logProgress = force => {
    const done = succeededThisRun + failures.length;
    if (!force && done % 10 !== 0) return;
    const progress = updateProgress();
    console.log(
      `[${new Date().toISOString()}] `
      + `${done}/${pending.length} 本轮完成，成功 ${succeededThisRun}，失败 ${failures.length}，`
      + `总检查点 ${completed.size}/${allCandidates.length}，并发 ${activeLimit}，ETA ${progress.eta}`,
    );
  };

  const onSignal = signal => {
    console.log(`收到 ${signal}，停止领取新任务，等待当前请求落盘...`);
    stopping = true;
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  async function awaitThrottle(workerId) {
    while (!stopping && workerId >= activeLimit) await sleep(500);
    const waitMs = globalNotBefore - Date.now();
    if (waitMs > 0) await sleep(waitMs);
  }

  async function generateWithRetry(candidate) {
    const prompt = buildPrompt(candidate, options.turns);
    let lastError;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      try {
        const response = await callApi({
          apiKey,
          model: options.model,
          system: prompt.system,
          user: prompt.user,
        });
        const generated = parseGeneratedCard(response.content, options.turns);
        for (const key of Object.keys(usage)) {
          usage[key] += Number(response.usage?.[key]) || 0;
        }
        stableSuccesses += 1;
        if (stableSuccesses >= 30 && activeLimit < options.concurrency) {
          activeLimit += 1;
          stableSuccesses = 0;
          console.log(`请求已稳定，并发恢复到 ${activeLimit}`);
        }
        return buildRecord(candidate, generated, options.model);
      } catch (error) {
        lastError = error;
        const status = Number(error?.status) || 0;
        if ([401, 402, 403].includes(status)) {
          fatalError = error;
          stopping = true;
          throw error;
        }
        if (status === 429) {
          activeLimit = Math.max(1, Math.floor(activeLimit / 2));
          stableSuccesses = 0;
          const cooldown = Math.max(error.retryAfterMs || 0, Math.min(60_000, 2 ** attempt * 1500));
          globalNotBefore = Math.max(globalNotBefore, Date.now() + cooldown);
          console.log(`触发 429，并发降至 ${activeLimit}，全局冷却 ${Math.round(cooldown / 1000)} 秒`);
        }
        if (attempt >= options.maxAttempts) break;
        const retryDelay = status === 429
          ? Math.max(0, globalNotBefore - Date.now())
          : Math.min(45_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
        await sleep(retryDelay);
      }
    }
    throw lastError || new Error("未知生成失败");
  }

  async function worker(workerId) {
    while (!stopping) {
      await awaitThrottle(workerId);
      if (stopping) break;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= pending.length) break;
      const candidate = pending[index];
      try {
        const item = await generateWithRetry(candidate);
        fs.appendFileSync(options.checkpoint, `${JSON.stringify(item)}\n`, "utf8");
        completed.set(item.recordKey, item);
        succeededThisRun += 1;
      } catch (error) {
        const failure = {
          recordKey: candidate.key,
          sceneId: candidate.scene.id,
          ageBand: candidate.ageBand,
          error: safeApiErrorBody(error?.message || error),
          at: new Date().toISOString(),
        };
        failures.push(failure);
        fs.appendFileSync(options.failures, `${JSON.stringify(failure)}\n`, "utf8");
        console.error(`[失败] ${candidate.key}：${failure.error}`);
      } finally {
        logProgress(false);
      }
    }
  }

  console.log(
    `场景 ${scenes.length}，年龄版本 ${allCandidates.length}，`
    + `检查点已有 ${initialCompleted}，本轮待生成 ${pending.length}，最高并发 ${options.concurrency}，`
    + `模型 ${options.model}`,
  );
  if (!pending.length) {
    writeFinalArtifacts(completed, options.sidecar, options.jsonl);
    updateProgress("complete");
    console.log("没有待生成卡片，已重新构建最终文件。");
    return;
  }

  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, pending.length) },
      (_, workerId) => worker(workerId),
    ),
  );

  writeFinalArtifacts(completed, options.sidecar, options.jsonl);
  const status = fatalError
    ? "fatal"
    : (stopping ? "stopped" : (failures.length ? "partial" : "complete"));
  const finalProgress = updateProgress(status);
  console.log(
    `任务结束：${status}。本轮成功 ${succeededThisRun}，失败 ${failures.length}，`
    + `检查点 ${completed.size}/${allCandidates.length}，耗时 ${finalProgress.elapsed}。`,
  );
  if (fatalError) throw fatalError;
  if (!options.limit && completed.size < allCandidates.length) process.exitCode = 2;
}

main().catch(error => {
  console.error(`批量生成器异常：${safeApiErrorBody(error?.stack || error)}`);
  process.exitCode = 1;
});
