import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const ROOT = process.cwd();

function parseArgs(argv) {
  const options = {
    runDir: "",
    concurrency: 8,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    limit: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--run-dir") options.runDir = path.resolve(value), index += 1;
    else if (arg === "--concurrency") options.concurrency = Number(value), index += 1;
    else if (arg === "--model") options.model = value, index += 1;
    else if (arg === "--reasoning-effort") options.reasoningEffort = value, index += 1;
    else if (arg === "--limit") options.limit = Number(value), index += 1;
  }
  if (!options.runDir) throw new Error("--run-dir 必填");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 48) {
    throw new Error("--concurrency 必须为 1–48 的整数");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error("--limit 必须为非负整数");
  }
  return options;
}

function resultLooksComplete(manifest) {
  if (!fs.existsSync(manifest.resultPath)) return false;
  try {
    const rows = fs.readFileSync(manifest.resultPath, "utf8")
      .split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
    const expectedKeys = new Set(manifest.items.map(item => item.recordKey));
    return rows.length === manifest.items.length
      && rows.every(row => (
        expectedKeys.has(row.recordKey)
        && typeof row.situation_summary === "string"
        && Array.isArray(row.history)
        && row.history.length === 7
      ))
      && new Set(rows.map(row => row.recordKey)).size === expectedKeys.size;
  } catch {
    return false;
  }
}

function buildPrompt(manifestInfo) {
  return [
    `你负责 A1 数据集 Codex 生成批次 ${manifestInfo.batchName}。`,
    `只允许读取 ${manifestInfo.manifestPath}。`,
    `只允许创建或修改 ${manifestInfo.resultPath}，不要改其他文件。`,
    "完整读取 manifest，严格遵守其中 instructions，为 items 中每一项生成一行合法 JSON。",
    "顶层字段只能是 recordKey、situation_summary、history，必须覆盖全部条目且不重复。",
    "背景目标 780–1100 个中文字符，绝不能少于 700 字；必须有 5–7 个自然段，在 JSON 字符串中用 \\n\\n。",
    "固定陪伴者为星仔：像兔子一样、有柔软长耳朵的毛绒外星 AI 情感陪玩玩具。",
    "每张背景都要自然写出星仔形象、与用户的长期共同记忆、最近变化和事件当天细节。",
    "history 恰好 7 条消息，按 user/supporter 严格交替，以 user 开头和结尾。",
    "内容具体、自然、符合具体年龄；不得写机械标签，不得把 supporter 改成其他名字。",
    "使用 apply_patch 写结果文件。",
    "写完后运行 Node 校验：每行可 JSON.parse；记录数和 recordKey 集合与 manifest 完全一致；",
    "每个 situation_summary 至少 700 字且含星仔、兔子或长耳或毛绒、外星或星球或星光；",
    "每个 history 恰好 7 条并严格交替。校验失败必须修正后再结束。",
    "最终只报告结果文件路径、条数和校验结论。",
  ].join("\n");
}

function runCodex(manifestInfo, options, logDir) {
  return new Promise(resolve => {
    const logPath = path.join(logDir, `${manifestInfo.batchName}.log`);
    const logFd = fs.openSync(logPath, "a");
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
      buildPrompt(manifestInfo),
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
      resolve({
        manifestInfo,
        exitCode: exitCode ?? -1,
        signal,
        complete: resultLooksComplete(
          JSON.parse(fs.readFileSync(manifestInfo.manifestPath, "utf8")),
        ),
        logPath,
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runPath = path.join(options.runDir, "run.json");
  if (!fs.existsSync(runPath)) throw new Error(`未找到 ${runPath}`);
  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  const logDir = path.join(options.runDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  let pending = run.manifests.filter(manifestInfo => {
    const manifest = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, "utf8"));
    return !resultLooksComplete(manifest);
  });
  if (options.limit) pending = pending.slice(0, options.limit);
  console.log(
    `Codex CLI 待生成 ${pending.length}/${run.manifests.length} 批，`
    + `最高并发 ${options.concurrency}，模型 ${options.model}，推理 ${options.reasoningEffort}`,
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
        console.log(
          `[${completed}/${pending.length}] ${manifestInfo.batchName} 完成，`
          + `失败批次 ${failed}`,
        );
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, pending.length) },
      () => worker(),
    ),
  );
  console.log(`Codex CLI 批次结束：完成检查 ${completed}，失败 ${failed}。`);
  if (failed) process.exitCode = 2;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
