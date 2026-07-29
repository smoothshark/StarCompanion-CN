# 数据资产

`data/` 只放适合版本管理、可以被产品或开发直接引用的数据。批量运行日志、检查点和临时导出统一放在 [`workspace/`](../workspace/)。

| 目录 | 数据性质 | 维护方式 |
|---|---|---|
| [`scenes/`](scenes/) | 当前场景主库，共 561 条 | 优先通过产品工具修改 |
| [`releases/`](releases/) | 人工确认后的正式对话版本 | 人审后按版本发布 |
| [`sources/mindmap/`](sources/mindmap/) | 基础 200 条事件的原始输入 | 数据维护者手工编辑 |

## 数据流

```text
sources/mindmap
      ↓ 生成基础派生结构
scenes/scene_library.json
      ↓ 批量生成
workspace + app/assets/pending-review.generated.js
      ↓ 人工审查、修改、确认
releases/approved_vX.Y.jsonl
```

正式数据与机器待审数据必须保持分离。
