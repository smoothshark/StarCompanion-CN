import fs from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const SOURCE_FILES = [
  "data/sources/mindmap/events-core.json",
  "data/sources/mindmap/events-boundary.json",
  "data/sources/mindmap/events-remaining.json",
];
const OUTPUT_FILE = "workspace/derived/A1_基础情绪与生活事件_200条_思维导图.json";

const categorySpecs = [
  { name: "连接与归属", slug: "connection", quota: 24, color: "cyan" },
  { name: "被忽视/未被看见", slug: "unseen", quota: 24, color: "violet" },
  { name: "能力与评价", slug: "ability", quota: 22, color: "lime" },
  { name: "自主与边界", slug: "autonomy", quota: 18, color: "cyan" },
  { name: "公平与尊严", slug: "fairness", quota: 14, color: "violet" },
  { name: "家庭与照护", slug: "family", quota: 20, color: "lime" },
  { name: "失去与变化", slug: "loss", quota: 18, color: "cyan" },
  { name: "安全与不确定", slug: "uncertainty", quota: 20, color: "violet" },
  { name: "自我与身份", slug: "identity", quota: 14, color: "lime" },
  { name: "身体与能量", slug: "energy", quota: 10, color: "cyan" },
  { name: "数字生活", slug: "digital", quota: 8, color: "violet" },
  { name: "日常微挫败", slug: "micro-frustration", quota: 8, color: "lime" },
];

const ageOrder = ["幼儿园", "小低", "小高", "初中", "高中", "大学", "职场人"];
const expectedAgeCounts = {
  幼儿园: 20,
  小低: 20,
  小高: 24,
  初中: 26,
  高中: 24,
  大学: 30,
  职场人: 56,
};

/** 源数据细粒度 mechanism → 导图合并后的 mechanism 名称 */
const mechanismAliases = {
  自主与边界: {
    选择被替代: "选择权被替代",
    人生选择被控制: "选择权被替代",
    拒绝不被尊重: "拒绝与身体边界",
    身体边界不被尊重: "拒绝与身体边界",
    独处需求不被尊重: "独处与参与边界",
    被强迫参与: "独处与参与边界",
    时间边界被侵占: "时间与工作边界",
    物品边界被越过: "物品与隐私边界",
    隐私边界被越过: "物品与隐私边界",
    居住边界被越过: "居住空间边界",
  },
  公平与尊严: {
    程序公正缺失: "规则与程序不公",
    规则执行不一: "规则与程序不公",
  },
  家庭与照护: {
    家庭冲突: "家庭冲突与站队",
    被卷入家庭冲突: "家庭冲突与站队",
    家庭期待施压: "高期待与条件式认可",
    条件式认可: "高期待与条件式认可",
    比较式评价: "高期待与条件式认可",
    家庭经济压力: "家庭经济与供养压力",
    经济供养压力: "家庭经济与供养压力",
    过度承担家庭责任: "照护责任集中",
  },
  失去与变化: {
    居住环境改变: "熟悉环境消失与迁移",
    日常场所消失: "熟悉环境消失与迁移",
  },
  安全与不确定: {
    去向不确定: "结果与去向等待",
    结果等待: "结果与去向等待",
    家人安全担忧: "重要他人安全担忧",
    照护者短暂失联: "重要他人安全担忧",
    家庭经济不确定: "经济与工作不稳定",
    工作不稳定: "经济与工作不稳定",
  },
  自我与身份: {
    人生选择被污名: "人生选择与角色污名",
    角色身份窄化: "人生选择与角色污名",
    口音与地域差异: "文化与家庭背景差异",
    家庭背景差异: "文化与家庭背景差异",
    归属身份困惑: "能力归属与方向迷茫",
    能力身份动摇: "能力归属与方向迷茫",
    自我方向迷茫: "能力归属与方向迷茫",
  },
  身体与能量: {
    急性疼痛: "疼痛疾病与低能量",
    慢性不适: "疼痛疾病与低能量",
    疾病低能量: "疼痛疾病与低能量",
    生理期不适: "身体变化与生理期",
    社交耗竭: "社交与职业耗竭",
    职业倦怠: "社交与职业耗竭",
  },
  数字生活: {
    社交数据比较: "网络比较与攻击",
    网络言语攻击: "网络比较与攻击",
    私密内容外传: "内容外传与公开羞辱",
    群聊公开羞辱: "内容外传与公开羞辱",
    线上回应落空: "线上关系落差",
    线上线下关系落差: "线上关系落差",
  },
  日常微挫败: {
    小期待落空: "计划与小期待落空",
    计划被打乱: "计划与小期待落空",
    心意未被接住: "心意与连接落空",
    连接期待落空: "心意与连接落空",
    日常小意外: "日常疏漏与小意外",
    日常疏漏: "日常疏漏与小意外",
  },
};

const CENTER = { x: 6000, y: 6000 };
const CATEGORY_RADIUS = 1300;
const MECHANISM_RADIUS = 1500;
const EVENT_RADIUS = 2000;

function normalizeMechanism(category, mechanism) {
  return mechanismAliases[category]?.[mechanism] ?? mechanism;
}

function loadEvents() {
  const events = [];
  for (const relativePath of SOURCE_FILES) {
    const absolutePath = path.join(ROOT_DIR, relativePath);
    const payload = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    if (!Array.isArray(payload)) {
      throw new Error(`${relativePath} 必须是数组`);
    }
    for (const item of payload) {
      events.push({
        category: item.category,
        mechanism: normalizeMechanism(item.category, item.mechanism),
        age: item.age,
        event: String(item.event).replace(/。$/u, ""),
        sourceFile: relativePath,
      });
    }
  }
  return events;
}

function validateEvents(events) {
  const errors = [];
  const categoryCounts = Object.fromEntries(
    categorySpecs.map((spec) => [spec.name, 0]),
  );
  const ageCounts = Object.fromEntries(ageOrder.map((age) => [age, 0]));

  for (const event of events) {
    if (!event.category || !event.mechanism || !event.age || !event.event) {
      errors.push(`事件字段不完整: ${JSON.stringify(event)}`);
      continue;
    }
    if (!(event.category in categoryCounts)) {
      errors.push(`未知分类: ${event.category}`);
    } else {
      categoryCounts[event.category] += 1;
    }
    if (!(event.age in ageCounts)) {
      errors.push(`未知年龄层: ${event.age}`);
    } else {
      ageCounts[event.age] += 1;
    }
  }

  for (const spec of categorySpecs) {
    if (categoryCounts[spec.name] !== spec.quota) {
      errors.push(
        `分类「${spec.name}」配额应为 ${spec.quota}，实际 ${categoryCounts[spec.name]}`,
      );
    }
  }
  for (const age of ageOrder) {
    if (ageCounts[age] !== expectedAgeCounts[age]) {
      errors.push(
        `年龄层「${age}」配额应为 ${expectedAgeCounts[age]}，实际 ${ageCounts[age]}`,
      );
    }
  }
  if (events.length !== 200) {
    errors.push(`事件总数应为 200，实际 ${events.length}`);
  }
  if (errors.length) {
    throw new Error(`思维导图源数据校验失败:\n- ${errors.join("\n- ")}`);
  }
}

function polar(cx, cy, radius, angleRad) {
  return {
    x: Math.round(cx + radius * Math.sin(angleRad)),
    y: Math.round(cy - radius * Math.cos(angleRad)),
  };
}

function buildMindMap(events) {
  const nodes = [
    {
      id: "root",
      text: "A1. 基础情绪与生活事件（200 条）",
      parentId: null,
      x: CENTER.x,
      y: CENTER.y,
      color: "lime",
    },
  ];

  let eventIndex = 1;

  for (const [catIndex, spec] of categorySpecs.entries()) {
    const categoryAngle = (catIndex / categorySpecs.length) * Math.PI * 2;
    const categoryPos = polar(CENTER.x, CENTER.y, CATEGORY_RADIUS, categoryAngle);
    const categoryId = `category-${spec.slug}`;
    nodes.push({
      id: categoryId,
      text: `${spec.name}（${spec.quota}）`,
      parentId: "root",
      x: categoryPos.x,
      y: categoryPos.y,
      color: spec.color,
    });

    const categoryEvents = events.filter((e) => e.category === spec.name);
    const mechanismOrder = [];
    const byMechanism = new Map();
    for (const item of categoryEvents) {
      if (!byMechanism.has(item.mechanism)) {
        byMechanism.set(item.mechanism, []);
        mechanismOrder.push(item.mechanism);
      }
      byMechanism.get(item.mechanism).push(item);
    }

    for (const [mechIndex, mechanismName] of mechanismOrder.entries()) {
      const mechItems = byMechanism.get(mechanismName);
      const spread = Math.min(0.7, 0.12 * mechanismOrder.length);
      const mechAngle =
        categoryAngle +
        (mechIndex - (mechanismOrder.length - 1) / 2) *
          ((spread * 2) / Math.max(mechanismOrder.length - 1, 1));
      const mechPos = polar(CENTER.x, CENTER.y, MECHANISM_RADIUS, mechAngle);
      const mechanismId = `mechanism-${spec.slug}-${String(mechIndex + 1).padStart(2, "0")}`;
      nodes.push({
        id: mechanismId,
        text: mechanismName,
        parentId: categoryId,
        x: mechPos.x,
        y: mechPos.y,
        color: spec.color,
      });

      const sortedItems = [...mechItems].sort(
        (a, b) => ageOrder.indexOf(a.age) - ageOrder.indexOf(b.age),
      );

      for (const [itemIndex, item] of sortedItems.entries()) {
        const itemSpread = Math.min(0.35, 0.08 * sortedItems.length);
        const itemAngle =
          mechAngle +
          (itemIndex - (sortedItems.length - 1) / 2) *
            ((itemSpread * 2) / Math.max(sortedItems.length - 1, 1));
        const itemPos = polar(CENTER.x, CENTER.y, EVENT_RADIUS, itemAngle);
        nodes.push({
          id: `event-${String(eventIndex).padStart(3, "0")}`,
          text: `${item.age}｜${item.event}`,
          parentId: mechanismId,
          x: itemPos.x,
          y: itemPos.y,
          color: spec.color,
        });
        eventIndex += 1;
      }
    }
  }

  return {
    name: "A1 基础情绪与生活事件（200 条）",
    nodes,
  };
}

function main() {
  const events = loadEvents();
  validateEvents(events);
  const mindMap = buildMindMap(events);
  const outputPath = path.join(ROOT_DIR, OUTPUT_FILE);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(mindMap, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        outputPath,
        events: events.length,
        nodes: mindMap.nodes.length,
      },
      null,
      2,
    ),
  );
}

main();
