# 正式发布数据（releases）

仅收录**人工确认后可发布**的多轮对话样本，一行一条 JSON，符合 [`schema/schema_v1.json`](../../schema/schema_v1.json)。

| 文件 | 版本 | 条数 | 说明 |
|---|---|---:|---|
| [approved_v0.1.jsonl](approved_v0.1.jsonl) | 0.1 | 3 | 首批导出；分布不代表目标配额 |

后续版本建议命名：`approved_v0.2.jsonl`、`approved_v1.0.jsonl`……

## 怎么来的

1. 用本地服务打开构造台：`node scripts/dev-server.mjs`
2. 选题 → 写多轮对话 → 人审确认
3. 导出人工已确认 JSONL，整理进本目录对应版本文件

机器草稿与待审中间文件放在 [`workspace/`](../../workspace/)（已 gitignore），不要直接当正式集发布。

开发者若只做评测对接，直接读本目录 JSONL 即可，不必打开构造台。详见根目录 [README.md](../../README.md)。
