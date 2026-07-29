# 产品审查工具

这里是产品和内容团队的主要工作入口。

| 文件 | 来源 | 是否手改 | 用途 |
|---|---|---|---|
| [`index.html`](index.html) | 产品工具源码 | 可以，改功能时手改 | 场景管理、卡片写作、待审、确认、导出和覆盖分析 |
| [`assets/pending-review.generated.js`](assets/pending-review.generated.js) | 批量脚本生成 | 不建议 | 把全部机器稿注入页面，当前卡片均为待审状态 |

## 打开方式

从项目根目录运行：

```bash
node scripts/dev-server.mjs
```

再打开 <http://127.0.0.1:8787/>。此方式会连接
[`data/scenes/scene_library.json`](../data/scenes/scene_library.json)，场景增删改可以落盘。

直接双击 [`index.html`](index.html) 也能查看页面，但修改只进入当前浏览器的
`localStorage`，不适合作为团队数据源。

## 待审数据如何更新

- SiliconFlow 生成：`node scripts/generate-a1-batch.mjs`
- Codex 批次准备、合并与审计：`node scripts/a1-codex-batch-tools.mjs`
- 可读 JSONL 同步写入：`workspace/review/pending-review.jsonl`

人工确认后的数据应单独整理到 [`data/releases/`](../data/releases/)，不要直接把本目录的机器稿当成发布集。
