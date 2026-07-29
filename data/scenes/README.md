# 选题库（scenes）

| 文件 | 说明 |
|---|---|
| [scene_library.json](scene_library.json) | 当前默认选题库，共 **561** 条；每条含 `ageBands` 硬锁 |

这是对外发布的选题数据源，也是可视化构造台在「已连接仓库 JSON」模式下的读写目标。候选生成与待审只展开每条事件自己的 `ageBands`，不是场景 × 七档年龄的笛卡尔积。

## 字段

| 字段 | 说明 |
|---|---|
| `id` | 事件 ID，如 `event-001` |
| `event` | 原子生活事件描述 |
| `category` / `categoryId` | 生活大类 |
| `mechanism` / `mechanismId` | 机制（考点名） |
| `color` | 导图/UI 用 |
| `ageBands` | 适用年龄段（扩展/平衡层常见；基础层可能缺省，由工具按年龄锁过滤） |
| `sceneType` | 主场景类型（扩展/平衡层常见） |
| `defaultEmotionValence` | 选题默认情绪极性；定稿对话时以末轮 user 为准重标 |

## 如何更新（推荐）

用本地服务打开构造台，增删改会直接写回本文件：

```bash
node scripts/dev-server.mjs
# 打开终端提示的地址，页眉显示「已连接仓库 JSON」
```

## 备选

```bash
# 无服务时：从 HTML 内嵌默认库导出快照
node scripts/export-scene-library.mjs
```

> 直接双击打开 HTML（`file://`）时，改动只进浏览器 localStorage，**不会**写回本文件。

基础 200 条的可编辑源在 [`../sources/mindmap/`](../sources/mindmap/)，经
[`scripts/generate-a1-mindmap.mjs`](../../scripts/generate-a1-mindmap.mjs) 与
[`scripts/build-a1-authoring-html.mjs`](../../scripts/build-a1-authoring-html.mjs)
嵌入工具作离线兜底。
