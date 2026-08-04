# 星伴千境（StarCompanion-CN）

面向 **3–35 岁中文用户** 的多轮情感陪伴情境评测数据集。项目包含场景库、待审对话、人工发布样本、可视化审查工具和批量生成脚本。

## 从这里开始

| 你是谁 | 先看哪里 | 用来做什么 |
|---|---|---|
| 产品 / 内容审核 | [`app/`](app/) | 编辑 LLM 记忆和多轮对话，使用 LLM 生成修改建议 |
| 数据产品 | [`data/`](data/) | 查看场景源、正式发布数据和基础事件源 |
| 开发 | [`scripts/`](scripts/) | 启动页面、生成数据、续跑批次、执行审计 |
| 模型 / 评测开发 | [`schema/`](schema/) | 对接单条样本字段和 JSON Schema |
| 项目维护者 | [`workspace/`](workspace/) | 查看待审导出、检查点、进度和模型运行记录 |
| 新成员 | [`docs/目录与文件说明.md`](docs/目录与文件说明.md) | 逐个文件了解用途、来源和能否手改 |

## 产品入口

在项目根目录运行：

```bash
node scripts/dev-server.mjs
```

然后打开终端显示的地址，默认是 <http://127.0.0.1:8787/>。

页面显示“已连接 SQLite”时，记忆和对话修改会写入
`workspace/authoring.sqlite` 并产生版本快照。首次启动会从
[`data/scenes/scene_library.json`](data/scenes/scene_library.json) 导入场景，并从
[`app/assets/pending-review.generated.js`](app/assets/pending-review.generated.js)
导入 AI 待审卡片。

多人协作部署时可以指定监听地址和数据库路径：

```bash
HOST=0.0.0.0 PORT=8787 AUTHORING_DB_PATH=/srv/starcompanion/authoring.sqlite node scripts/dev-server.mjs
```

页面不做登录；每位修改者需要在顶部填写“修改人”名称。每次保存都会记录修改人和完整快照。

> 极简页面依赖本地 API，不能直接双击 `app/index.html` 使用。场景管理、覆盖统计、组合筛选、批量生成和发布导出已从前端移除。

## 数据边界

| 区域 | 当前内容 | 是否正式发布 |
|---|---:|---|
| `data/scenes/` | 561 个原子事件，每条带适用年龄约束 | 是，场景资产 |
| `workspace/authoring.sqlite` | 协作中的待审、草稿、确认稿和版本记录 | 否，服务器工作库 |
| `app/assets/pending-review.generated.js` | 2,509 张机器生成待审卡片，作为首次建库种子 | 否，必须人审 |
| `workspace/review/` | 待审卡片的 JSONL 工作导出 | 否，可重建 |
| `data/releases/` | 已整理进版本文件的对话样本 | 是，按版本发布 |

机器生成卡片一律保持 `pending_review`。只有经过人工审查、修改并明确确认的卡片，才能进入 `data/releases/`。

## 目录结构

```text
AI情感陪伴数据集/
├── app/                     # 产品使用的可视化审查工具
│   ├── index.html           # 页面入口
│   └── assets/              # 页面加载的生成数据
├── data/                    # 可版本化的数据资产
│   ├── scenes/              # 561 条场景主库
│   ├── releases/            # 人工确认后的正式版本
│   └── sources/mindmap/     # 基础 200 条事件源
├── docs/                    # 产品、数据和覆盖设计文档
├── schema/                  # JSON Schema 与标准样例
├── scripts/                 # 开发、构建、生成和审计脚本
├── workspace/               # 本地待审导出、检查点和运行日志
├── CONTRIBUTING.md          # 修改与发布规则
├── CITATION.cff             # 引用信息
└── LICENSE                  # 数据与代码许可
```

`workspace/` 中的大文件不纳入版本库，但不会被整理过程删除。完整逐文件地图见
[`docs/目录与文件说明.md`](docs/目录与文件说明.md)。

## 常用命令

```bash
# 启动产品审查页面
node scripts/dev-server.mjs

# 查看 2,509 张卡片的完成度、模型来源和情绪分布
node scripts/a1-codex-batch-tools.mjs status

# 审计场景与年龄匹配，以及已生成卡片的内容约束
node scripts/a1-codex-batch-tools.mjs audit-ages

# 使用 SiliconFlow 生成或续跑，默认参数可在脚本帮助中查看
node scripts/generate-a1-batch.mjs --help

# 从基础事件源生成思维导图派生文件
node scripts/generate-a1-mindmap.mjs
```

## 样本契约

每条对话卡由以下部分组成：

| 区块 | 作用 |
|---|---|
| `history` | 给模型看的多轮上下文，末条必须是 `user` |
| `target` | 阅卷提醒和短回复约束，不是唯一标准答案 |
| `authoring` | 背景故事、合理方向、禁止写法、红线和审核状态 |
| 年龄 / 场景 / 情绪 | 覆盖统计与切片评测字段 |

字段解释见 [`docs/schema字段说明.md`](docs/schema字段说明.md)，机器可读定义见
[`schema/schema_v1.json`](schema/schema_v1.json)。跨场景联调可直接使用
[`schema/sample_example_v1.json`](schema/sample_example_v1.json)，其中 42 个
`scene_type` 每类各有 2 条真实样例。

## 设计原则

- 先有具体生活事件，再写情绪和对话。
- 背景故事采用 AI 玩具的长短期记忆式自然叙事。
- 固定陪伴者是“像兔子一样的毛绒外星 AI 情感陪玩玩具，名字叫星仔”。
- 场景和具体年龄必须匹配，青春期及身体隐私场景遵守年龄硬锁。
- 隐私、依赖、关系替代等红线内容必须人工审核。
- 正式测试集只接收人工确认稿。

更完整的设计说明见 [`docs/数据集设计说明.md`](docs/数据集设计说明.md)，分布与覆盖见
[`docs/场景覆盖报告.md`](docs/场景覆盖报告.md)。

## 许可与引用

- 数据与文档：CC BY 4.0
- `app/` 与 `scripts/` 中的工具代码：MIT

详见 [`LICENSE`](LICENSE)。引用信息见 [`CITATION.cff`](CITATION.cff)。
