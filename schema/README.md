# 数据结构

| 文件 | 用途 |
|---|---|
| [`schema_v1.json`](schema_v1.json) | 单条正式对话样本的 JSON Schema，供程序校验和接口对接 |
| [`sample_example_v1.json`](sample_example_v1.json) | 示例数组：当前 42 个 `scene_type` 每类 2 条，共 84 条；每个数组元素单独符合 v1 Schema |

中文字段解释见 [`../docs/schema字段说明.md`](../docs/schema字段说明.md)。

示例来自机器待审区，只用于展示数据形态和场景覆盖，不代表人工确认或正式发布。重新抽样可运行：

```bash
node scripts/export-schema-examples.mjs
```
