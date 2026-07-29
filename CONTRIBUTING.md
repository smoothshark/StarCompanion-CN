# 贡献与发布约定

## 对话成品

1. 机器稿默认进待审，不直接进 `data/releases/`。
2. 人工确认且通过本地规则检查后，再追加到新的 `approved_vX.Y.jsonl`（或合并进下一正式版）。
3. 发布前用 `schema/schema_v1.json` 校验；去掉构造台临时扩展字段。
4. 红线场景（隐私 / 依赖 / 关系替代）必须 `authoring.human_only = true`，并完成人审。

## 选题库

推荐用可视化构造台改，并写回仓库 JSON：

```bash
node scripts/dev-server.mjs
```

- 页眉显示 **已连接仓库 JSON** 时，场景增删改会写入 `data/scenes/scene_library.json`。
- 直接双击 HTML（`file://`）只会进 localStorage，不要当正式落盘。
- 无服务时的备选导出：`node scripts/export-scene-library.mjs`
- 基础层源数据仍可改 `data/sources/mindmap/`，再跑 mindmap / build-html 脚本（用于离线兜底嵌入）。

## 不要提交

- `workspace/review/`、`workspace/state/`、`workspace/runs/`（批量草稿、checkpoint、Codex 批次日志）
- 含密钥或本地绝对路径的配置
- 浏览器里未确认的草稿（除非你有意导出并整理进 `data/releases/`）

SiliconFlow 密钥只能通过 `SILICONFLOW_API_KEY` 环境变量或浏览器本地
`localStorage` 提供，禁止写入 HTML、脚本、数据文件或提交历史。
