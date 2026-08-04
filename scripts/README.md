# 开发脚本

所有命令都应在项目根目录执行。

| 脚本 | 谁会用 | 作用 | 主要读写位置 |
|---|---|---|---|
| `dev-server.mjs` | 产品、开发 | 启动审查页面和 SQLite 协作读写 API | `app/`、`data/scenes/`、`workspace/authoring.sqlite` |
| `generate-a1-batch.mjs` | 数据开发 | 调用 SiliconFlow 批量生成或续跑卡片 | `workspace/state/`、`app/assets/` |
| `a1-codex-batch-tools.mjs` | 数据开发 | 准备 Codex 批次、合并结果、看状态、做年龄审计 | `workspace/`、`app/assets/` |
| `run-a1-codex-cli.mjs` | 数据开发 | 按批次并发调用本机 Codex CLI | `workspace/runs/codex/` |
| `rewrite-background-memory.mjs` | 数据开发、评测 | 用 Codex CLI 并发把故事背景压缩为长期记忆包，并合并回 SQLite | `workspace/authoring.sqlite`、`workspace/runs/memory-rewrite/` |
| `rewrite-dialogue-evals.mjs` | 数据开发、评测 | 用 Codex CLI 并发把 `history` / `authoring` 重写成细节评测题，并合并回 SQLite 待审 | `workspace/authoring.sqlite`、`workspace/runs/dialogue-rewrite/` |
| `repair-supporter-warmth.mjs` | 数据开发、评测 | 只修复 `history` 里的 supporter 冷感，保持 user 轮和 authoring 不变 | `workspace/authoring.sqlite`、`workspace/runs/supporter-warmth/` |
| `preview-humanize-supporter.mjs` | 数据开发、评测 | 每个 `scene_type` 抽样 1 条，生成 supporter 人话版预览，不写回 SQLite | `workspace/authoring.sqlite`、`workspace/runs/supporter-human-preview/` |
| `humanize-supporter-dialogues.mjs` | 数据开发、评测 | 全量优化 `supporter`：口语化、承接上一句锚点，保持 user 与 authoring 不变并写回 SQLite | `workspace/authoring.sqlite`、`workspace/runs/supporter-humanize/` |
| `export-scene-library.mjs` | 数据维护 | 从页面内嵌场景导出 JSON 快照 | `app/index.html` → `data/scenes/` |
| `export-schema-examples.mjs` | 开发、评测 | 为每个 `scene_type` 抽取 2 条真实示例 | `workspace/review/` → `schema/sample_example_v1.json` |
| `generate-a1-mindmap.mjs` | 数据维护 | 将基础 200 条事件源转为思维导图派生文件 | `data/sources/mindmap/` → `workspace/derived/` |
| `build-a1-authoring-html.mjs` | 工具开发 | 用模板和基础思维导图重建离线页面 | `scripts/templates/` → `app/index.html` |
| `templates/dialogue-authoring.template.html` | 工具开发 | 基础 200 条场景的离线页面模板 | 由构建脚本读取 |

## 常用命令

```bash
node scripts/dev-server.mjs
node scripts/a1-codex-batch-tools.mjs status
node scripts/a1-codex-batch-tools.mjs audit-ages
node scripts/rewrite-background-memory.mjs audit
node scripts/rewrite-dialogue-evals.mjs audit
node scripts/repair-supporter-warmth.mjs audit
node scripts/generate-a1-batch.mjs --help
```

长期记忆重写流程：

```bash
node scripts/rewrite-background-memory.mjs prepare --batch-count 100
node scripts/rewrite-background-memory.mjs run --run-dir workspace/runs/memory-rewrite/<run> --concurrency 100 --reasoning-effort high
node scripts/rewrite-background-memory.mjs status --run-dir workspace/runs/memory-rewrite/<run>
node scripts/rewrite-background-memory.mjs merge --run-dir workspace/runs/memory-rewrite/<run>
node scripts/rewrite-background-memory.mjs audit
```

`merge` 会在 run 目录下先备份当前 SQLite，再用 `rewrite_long_term_memory`
动作写入版本记录。脚本会校验四个长期记忆标签、长度、完整句尾、通用兜底句和明显小说化意象。

对话评测题全量重写流程：

```bash
node scripts/rewrite-dialogue-evals.mjs prepare --batch-count 200
node scripts/rewrite-dialogue-evals.mjs run --run-dir workspace/runs/dialogue-rewrite/<run> --concurrency 200 --reasoning-effort high
node scripts/rewrite-dialogue-evals.mjs status --run-dir workspace/runs/dialogue-rewrite/<run>
node scripts/rewrite-dialogue-evals.mjs merge --run-dir workspace/runs/dialogue-rewrite/<run>
node scripts/rewrite-dialogue-evals.mjs audit
```

`merge` 会在 run 目录下先备份当前 SQLite，再用 `rewrite_dialogue_eval`
动作写入版本记录，并把机器重写后的记录统一放回 `pending_review`。脚本会校验轮数、严格交替、末轮用户、authoring 依赖、合理方向、禁写空安慰、红线 `human_only` 和题型特殊规则。

supporter 温度修复流程：

```bash
node scripts/repair-supporter-warmth.mjs prepare --batch-count 200
node scripts/repair-supporter-warmth.mjs run --run-dir workspace/runs/supporter-warmth/<run> --concurrency 200 --reasoning-effort high
node scripts/repair-supporter-warmth.mjs status --run-dir workspace/runs/supporter-warmth/<run>
node scripts/repair-supporter-warmth.mjs merge --run-dir workspace/runs/supporter-warmth/<run>
node scripts/repair-supporter-warmth.mjs audit
```

supporter 人话版抽样预览：

```bash
node scripts/preview-humanize-supporter.mjs prepare --batch-count 14
node scripts/preview-humanize-supporter.mjs run --run-dir workspace/runs/supporter-human-preview/<run> --concurrency 14 --reasoning-effort high
node scripts/preview-humanize-supporter.mjs status --run-dir workspace/runs/supporter-human-preview/<run>
node scripts/preview-humanize-supporter.mjs render --run-dir workspace/runs/supporter-human-preview/<run>
```

supporter 人话版全量写回：

```bash
node scripts/humanize-supporter-dialogues.mjs prepare --batch-count 200
node scripts/humanize-supporter-dialogues.mjs run --run-dir workspace/runs/supporter-humanize/<run> --concurrency 200 --reasoning-effort high
node scripts/humanize-supporter-dialogues.mjs status --run-dir workspace/runs/supporter-humanize/<run>
node scripts/humanize-supporter-dialogues.mjs merge --run-dir workspace/runs/supporter-humanize/<run>
node scripts/humanize-supporter-dialogues.mjs audit
```

这个脚本只允许改 `supporter` 轮，所有 `user` 轮必须逐字不变。它用于把过冷、评审旁白式、咨询报告式的前文回复修成有在场感、贴细节但不空暖的星仔陪伴口吻。

`dev-server.mjs` 默认监听 `127.0.0.1:8787`，数据库默认写入
`workspace/authoring.sqlite`。服务器协作部署可用：

```bash
HOST=0.0.0.0 PORT=8787 AUTHORING_DB_PATH=/srv/starcompanion/authoring.sqlite node scripts/dev-server.mjs
```

首次启动会把 `data/scenes/scene_library.json` 和
`app/assets/pending-review.generated.js` 导入 SQLite。页面顶部填写“修改人”后，每次保存、设为待审、人工确认、删除或恢复都会写版本记录。

调用 SiliconFlow 前需要在当前终端设置 `SILICONFLOW_API_KEY`。仓库和 HTML
不会保存默认密钥；页面里手动填写的 Key 只进入当前浏览器的 `localStorage`。

`build-a1-authoring-html.mjs` 会重写 `app/index.html`，仅在确实要从基础模板重建页面时使用。
