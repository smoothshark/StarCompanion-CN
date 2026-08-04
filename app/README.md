# 极简对话编辑器

这里是产品和内容团队的主要工作入口。

页面采用白色 macOS 风格界面，视觉调整不改变 SQLite 数据结构和编辑流程。

| 文件 | 来源 | 是否手改 | 用途 |
|---|---|---|---|
| [`index.html`](index.html) | 产品工具源码 | 可以，改功能时手改 | 编辑 LLM 记忆、多轮对话，并生成和应用 LLM 修改建议 |
| [`assets/pending-review.generated.js`](assets/pending-review.generated.js) | 批量脚本生成 | 不建议 | SQLite 首次建库时使用的机器稿种子；极简页面不直接加载 |

## 打开方式

从项目根目录运行：

```bash
node scripts/dev-server.mjs
```

再打开 <http://127.0.0.1:8787/>。此方式会连接 SQLite 工作库，默认路径为
[`../workspace/authoring.sqlite`](../workspace/authoring.sqlite)。场景增删改、卡片草稿、待审状态、人工确认状态和版本记录都会落库。

多人协作部署示例：

```bash
HOST=0.0.0.0 PORT=8787 AUTHORING_DB_PATH=/srv/starcompanion/authoring.sqlite node scripts/dev-server.mjs
```

页面顶部需要填写“修改人”。保存当前卡片时，会把修改人和完整快照写入 SQLite
版本记录。页面不再提供场景管理、覆盖统计、组合筛选、批量生成或发布导出。

页面依赖本地 API 读取和保存 SQLite，不能通过 `file://` 直接编辑。

## 页面保留的功能

- 先选择母类别，再选择机制型场景、年龄和具体生活事件
- 编辑 `authoring.situation_summary`（LLM 记忆）
- 编辑 `history` 多轮对话，增加或减少两轮
- 删除当前年龄下不符合逻辑的具体案例，不影响场景和其他年龄分支
- 将当前案例标记为“已人工审核”或可逆地恢复为“AI 待审”，每次切换都写入版本记录
- 调用 SiliconFlow 生成修改建议
- SiliconFlow 请求启用 `response_format: { type: "json_object" }`，并对小模型常见的未加引号键名和尾逗号做容错
- 若小模型仍返回损坏 JSON，页面会自动发起一次只修复格式的重试，再进入预览校验
- 模型返回繁忙、限流或临时服务错误时，页面按 3 秒、8 秒退避自动重试，最多请求 3 次
- 在预览后应用建议，再显式保存到 SQLite
- 默认锁定所有 user 原话，只修改记忆和 supporter 回复
- supporter 改写采用推进式规则：识别深层担心或需要、澄清用户目的、提供具体支持或下一步，禁止仅做同义复述

## 待审数据如何更新

- SiliconFlow 生成：`node scripts/generate-a1-batch.mjs`
- Codex 批次准备、合并与审计：`node scripts/a1-codex-batch-tools.mjs`
- 可读 JSONL 同步写入：`workspace/review/pending-review.jsonl`

人工确认后的数据应单独整理到 [`data/releases/`](../data/releases/)，不要直接把本目录的机器稿当成发布集。
