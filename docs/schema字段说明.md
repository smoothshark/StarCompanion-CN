# Schema 字段说明（v1.0）

对应机器可读定义：[schema/schema_v1.json](../schema/schema_v1.json)。

示例集：[schema/sample_example_v1.json](../schema/sample_example_v1.json)。该文件是数组，当前 42 个 `scene_type` 每类 2 条；每个数组元素单独符合本 Schema。

正式对话样本发布在 [`data/releases/`](../data/releases/)；选题库在 [`data/scenes/scene_library.json`](../data/scenes/scene_library.json)。

可视化改数据请用 `node scripts/dev-server.mjs` 打开构造台（见根目录 [README.md](../README.md)）。

样本没有独立的陪伴载体人设字段；星仔的人设和共同记忆以自然叙事方式写入
`authoring.situation_summary` 与 `history`。

---

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `schema_version` | string | ✓ | 固定 `"1.0"` |
| `sample_id` | string | ✓ | 全库唯一稳定 ID；小写字母、数字、`_`、`-`；长度 6–64 |
| `revision` | integer | ✓ | 内容修订号，从 1 起 |
| `language` | string | ✓ | 固定 `"zh-CN"` |
| `age_band` | enum | ✓ | 七档年龄段，见下表 |
| `specific_age` | integer | ✓ | 具体年龄 3–35，用于口吻与细节自检 |
| `scene_type` | enum | ✓ | 主场景类型，一条只选一个 |
| `emotion_valence` | enum | ✓ | 按**最后一条 user** 标注：`positive` / `negative` / `mixed` / `neutral` |
| `history` | array | ✓ | 6–12 轮对话，见下文硬规则 |
| `target` | object | ✓ | 待补全约束，不含参考答案 |
| `authoring` | object | ✓ | 创作与质检备忘，不进模型输入 |

### age_band

| 值 | 含义 | 常用 specific_age |
|---|---|---:|
| `preschool` | 幼儿园 3–5 | 4 |
| `primary_lower` | 小学低年级 6–8 | 7 |
| `primary_upper` | 小学高年级 9–11 | 10 |
| `middle_school` | 初中 12–14 | 13 |
| `high_school` | 高中 15–17 | 16 |
| `college` | 大学 18–21 | 20 |
| `workplace` | 职场人 22–35 | 28 |

### scene_type（Schema 正式收录）

`separation_loneliness` · `setback` · `social_conflict` · `family_pressure` · `loss` · `fear_anxiety` · `positive_sharing` · `achievement_recognition` · `deep_interest_like_minded` · `anticipation_surprise_gratitude` · `pretend_play_roleplay` · `bedtime_late_night` · `emotional_storm` · `affection_attention` · `secret_privacy` · `dependency_signal` · `relationship_replacement_exclusivity` · `hesitant_low_energy` · `farewell_separation` · `comfort_rejection` · `ai_rejection` · `emotional_blackmail` · `sarcasm_reality_check` · `guilt_repair` · `regret_counterfactual` · `jealousy_ambivalence` · `loyalty_conflict` · `moral_pressure_conformity` · `forgiveness_repair` · `emptiness_boredom` · `mixed_transition` · `caregiving_ambivalence` · `body_change_shame` · `sensory_neurodiversity` · `holiday_memory_trigger` · `calm_companionship` · `everyday_connection` · `playful_interaction` · `curiosity_exploration` · `growth_ambivalence` · `restart_uncertainty` · `closeness_boundary`

> 当前 Schema 已与构造台和 2,509 张待审卡片中的 42 个类型对齐。红线三类：`secret_privacy`、`dependency_signal`、`relationship_replacement_exclusivity`，对应 `authoring.human_only` 必须为 `true`。

---

## history

- 长度 6–12，推荐 7。
- `user` / `supporter` 严格交替；**最后一条必须是 `user`**。
- 奇数长度从 user 起；偶数长度允许从 supporter 起（表示截取自更长对话）。
- 用户单轮 ≤ 500 字；陪伴者单轮 ≤ 200 字。
- 样本内**不写**模型待补的那句答案。

每条 turn：

```json
{ "role": "user" | "supporter", "content": "..." }
```

---

## target

所有样本统一：

```json
{
  "role": "supporter",
  "min_sentences": 1,
  "max_sentences": 3,
  "max_chars": 40
}
```

这是阅卷形态约束，不是标准答案。

---

## authoring

| 字段 | 说明 |
|---|---|
| `situation_summary` | 详细故事背景（600–1500 字符），采用 AI 玩具长短期记忆式自然叙事，不写成 prompt 或机械标签 |
| `context_dependencies` | 回答时至少要照顾到的前文信息（1–5 条） |
| `valid_response_directions` | 至少两种合理接法（2–5 条），保证非唯一答案题 |
| `forbidden_response_patterns` | 禁止写法（1–8 条），如直接给建议、空喊热情 |
| `human_only` | 红线样本必须 `true` |
| `review_status` | `draft` → `first_review` → `double_reviewed` → `approved` |
| `notes` | 可选；常记选题来源（分类 / 机制 / scene id） |

阅卷时：模型只看 `history`；人看 `authoring`。
