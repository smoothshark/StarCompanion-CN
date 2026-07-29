# 本地工作区

这里存放批量生成过程中的可恢复状态和大体积中间产物。除本说明外，内容默认不纳入版本库。

| 目录 | 当前内容 | 能否删除 |
|---|---|---|
| `review/` | 全部待审卡片的 JSONL 导出 | 可由检查点重建，但产品审查前建议保留 |
| `state/` | checkpoint、失败记录和进度 | 续跑依赖，不要在任务未结束时删除 |
| `runs/codex/` | Codex manifest、结果、日志和合并报告 | 完成并验收后可以归档 |
| `derived/` | 从基础事件源生成的思维导图等派生文件 | 可以重新生成 |

## 当前关键文件

| 文件 | 作用 |
|---|---|
| `review/pending-review.jsonl` | 方便数据分析的待审卡片，一行一条 |
| `state/batch-checkpoint.ndjson` | 2,509 张卡片的主恢复检查点 |
| `state/batch-progress.json` | 最近一次批量任务汇总 |
| `state/batch-failures.ndjson` | SiliconFlow 调用失败记录 |

页面实际加载的是 [`../app/assets/pending-review.generated.js`](../app/assets/pending-review.generated.js)。合并脚本会同时刷新页面数据和 `review/pending-review.jsonl`。

九次 Codex 历史运行的用途和结果见 [`RUNS.md`](RUNS.md)。
