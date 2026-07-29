import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const templatePath = path.join(
  root,
  "scripts",
  "templates",
  "dialogue-authoring.template.html",
);
const mindMapPath = path.join(
  root,
  "workspace",
  "derived",
  "A1_基础情绪与生活事件_200条_思维导图.json",
);
const outputPath = path.join(root, "app", "index.html");

const template = fs.readFileSync(templatePath, "utf8");
const mindMap = JSON.parse(fs.readFileSync(mindMapPath, "utf8"));
const nodeById = new Map(mindMap.nodes.map((node) => [node.id, node]));

function stripMatrixLevelLabel(value) {
  return String(value || "")
    .trim()
    .replace(/^(?:A\d+(?:-\d+)?)\.\s*[^｜>/-]*?（\d+\s*条）\s*[｜>/-]?\s*/u, "")
    .replace(/^(?:A\d+(?:-\d+)?)\.\s*/u, "")
    .replace(/（\d+\s*条）$/u, "")
    .replace(/（\d+）$/u, "")
    .trim();
}

const scenes = mindMap.nodes
  .filter((node) => node.id.startsWith("event-"))
  .map((node) => {
    const mechanismNode = nodeById.get(node.parentId);
    const categoryNode = nodeById.get(mechanismNode?.parentId);
    if (!mechanismNode || !categoryNode) {
      throw new Error(`事件 ${node.id} 缺少分类链路`);
    }
    const separator = node.text.indexOf("｜");
    if (separator < 1) {
      throw new Error(`事件 ${node.id} 未使用“年龄｜事件”格式`);
    }
    return {
      id: node.id,
      event: stripMatrixLevelLabel(node.text.slice(separator + 1)),
      mechanismId: mechanismNode.id,
      mechanism: stripMatrixLevelLabel(mechanismNode.text),
      categoryId: categoryNode.id,
      category: stripMatrixLevelLabel(categoryNode.text),
      color: node.color,
    };
  });

if (!scenes.length) {
  throw new Error("未找到任何场景叶子节点");
}

const payload = JSON.stringify(scenes).replaceAll("<", "\\u003c");
if (!template.includes("__SCENE_LIBRARY_JSON__")) {
  throw new Error("HTML 模板缺少场景数据占位符");
}

const output = template.replace("__SCENE_LIBRARY_JSON__", payload);
fs.writeFileSync(outputPath, output, "utf8");

console.log(
  JSON.stringify(
    {
      outputPath,
      embeddedScenes: scenes.length,
      bytes: Buffer.byteLength(output),
    },
    null,
    2,
  ),
);
