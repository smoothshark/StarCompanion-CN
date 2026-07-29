# 开发脚本

所有命令都应在项目根目录执行。

| 脚本 | 谁会用 | 作用 | 主要读写位置 |
|---|---|---|---|
| `dev-server.mjs` | 产品、开发 | 启动审查页面和场景库读写 API | `app/`、`data/scenes/` |
| `generate-a1-batch.mjs` | 数据开发 | 调用 SiliconFlow 批量生成或续跑卡片 | `workspace/state/`、`app/assets/` |
| `a1-codex-batch-tools.mjs` | 数据开发 | 准备 Codex 批次、合并结果、看状态、做年龄审计 | `workspace/`、`app/assets/` |
| `run-a1-codex-cli.mjs` | 数据开发 | 按批次并发调用本机 Codex CLI | `workspace/runs/codex/` |
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
node scripts/generate-a1-batch.mjs --help
```

调用 SiliconFlow 前需要在当前终端设置 `SILICONFLOW_API_KEY`。仓库和 HTML
不会保存默认密钥；页面里手动填写的 Key 只进入当前浏览器的 `localStorage`。

`build-a1-authoring-html.mjs` 会重写 `app/index.html`，仅在确实要从基础模板重建页面时使用。
