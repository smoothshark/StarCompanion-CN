#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewJsonlPath = path.join(
  root,
  "workspace",
  "review",
  "pending-review.jsonl",
);
const sidecarPath = path.join(
  root,
  "app",
  "assets",
  "pending-review.generated.js",
);
const outputPath = path.join(root, "schema", "sample_example_v1.json");
const examplesPerSceneType = 2;

const ageOrder = [
  "preschool",
  "primary_lower",
  "primary_upper",
  "middle_school",
  "high_school",
  "college",
  "workplace",
];

function loadRecords() {
  if (fs.existsSync(reviewJsonlPath)) {
    return fs.readFileSync(reviewJsonlPath, "utf8")
      .split("\n")
      .filter(line => line.trim())
      .map((line, index) => ({
        recordKey: `jsonl-${index}`,
        sceneId: "",
        sample: JSON.parse(line),
      }));
  }

  const source = fs.readFileSync(sidecarPath, "utf8").trim();
  const prefix = "window.A1_PREGENERATED_WORKSPACE = ";
  if (!source.startsWith(prefix) || !source.endsWith(";")) {
    throw new Error("pending-review.generated.js 格式无效");
  }
  const workspace = JSON.parse(source.slice(prefix.length, -1));
  return Object.entries(workspace).map(([recordKey, record]) => ({
    recordKey,
    sceneId: record.sceneId || "",
    sample: record.sample,
  }));
}

function sceneIdOf(record) {
  if (record.sceneId) return record.sceneId;
  const match = String(record.sample?.sample_id || "").match(/event-\d+/u);
  return match?.[0] || record.sample?.sample_id || record.recordKey;
}

function chooseExamples(records) {
  const first = records
    .slice()
    .sort((left, right) => (
      ageOrder.indexOf(left.sample.age_band) - ageOrder.indexOf(right.sample.age_band)
      || left.sample.sample_id.localeCompare(right.sample.sample_id)
    ))[0];
  if (!first || examplesPerSceneType === 1) return first ? [first] : [];

  const firstAge = ageOrder.indexOf(first.sample.age_band);
  const firstSceneId = sceneIdOf(first);
  const remaining = records
    .filter(record => record !== first)
    .sort((left, right) => {
      const leftDifferentScene = sceneIdOf(left) !== firstSceneId ? 1 : 0;
      const rightDifferentScene = sceneIdOf(right) !== firstSceneId ? 1 : 0;
      const leftDifferentValence =
        left.sample.emotion_valence !== first.sample.emotion_valence ? 1 : 0;
      const rightDifferentValence =
        right.sample.emotion_valence !== first.sample.emotion_valence ? 1 : 0;
      const leftAgeDistance =
        Math.abs(ageOrder.indexOf(left.sample.age_band) - firstAge);
      const rightAgeDistance =
        Math.abs(ageOrder.indexOf(right.sample.age_band) - firstAge);
      return (
        rightDifferentScene - leftDifferentScene
        || rightDifferentValence - leftDifferentValence
        || rightAgeDistance - leftAgeDistance
        || left.sample.sample_id.localeCompare(right.sample.sample_id)
      );
    });
  return [first, ...remaining.slice(0, examplesPerSceneType - 1)];
}

function main() {
  const records = loadRecords();
  const bySceneType = new Map();
  for (const record of records) {
    const sceneType = record.sample?.scene_type;
    if (!sceneType) continue;
    if (!bySceneType.has(sceneType)) bySceneType.set(sceneType, []);
    bySceneType.get(sceneType).push(record);
  }

  const selected = [...bySceneType]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, sceneRecords]) => chooseExamples(sceneRecords))
    .map(record => record.sample);

  fs.writeFileSync(outputPath, `${JSON.stringify(selected, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        outputPath,
        sourceRecords: records.length,
        sceneTypes: bySceneType.size,
        examplesPerSceneType,
        examples: selected.length,
      },
      null,
      2,
    ),
  );
}

main();
