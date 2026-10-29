# Agent Team JSON 配置

从输入区旁的 **管理我的 Agent → Agent Team** 打开团队设置，可以选择预设、导入 JSON，或点击 **让 AI 帮我配置**。AI 配置会打开一个新的 Solo 会话并准备提示词；补充需求后再自行发送。

JSON 文件与可视化画布编辑的是同一份团队定义。导入只创建未保存的草稿，编辑 JSON 只修改当前草稿。完成后依次 **选择各模块的 Agent → 保存 → 测试 → 启用**，再从输入区选择这个 Team。文件不会导入启用状态、运行记录、测试结果或授权。

## 从预设开始

提供开发与审查、科研与验证、界面设计与实现、调研与报告、故障诊断与修复五种预设。每种包含一个协调角色和两个协作角色，职责、提示词和双向协作连接已填好；Agent 和模型留空，由你选择。角色名称不代表额外工具或权限，实际能力取决于所选 Agent。

可以改写角色、提示词、连线和调用上限。**重置为预设** 会恢复模板的这些内容，保留对应模块已经选定的 Agent；新增模块会移除。切换到另一预设时会清空 Agent 选择，并先要求确认。预设不绑定模型、不自动启用，也不代替成员的共享授权。

## 打开、编辑与下载

- **导入 JSON**：打开文件或粘贴 JSON，检查后点击“应用到草稿”，创建一个新的 Team 草稿。
- **编辑 JSON**：查看并编辑当前画布的配置；应用后回到画布，仍需保存。修改已启用 Team 时沿用已有停用、重测流程。
- **下载 JSON**：下载编辑区中校验通过的配置，适合交给本地 Agent 修改、放进版本管理，或保留为模板。
- **让 AI 帮我配置**：在团队列表从需求开始；在编辑器中会保留当前配置作为参考，等你发送时一并附上。AI 返回的配置仍需预览、应用、保存和测试。

JSON 的 `$schema` 指向 [编辑器补全用 Schema](https://gatherthread.cn/schemas/agent-team.v1.schema.json)。支持 JSON Schema 的编辑器可以检查字段与提供补全；图结构和文件大小仍由 GatherThread 再次校验。离线时可下载 [仓库内 Schema](configuration/agent-team.v1.schema.json)，将 `$schema` 设为该文件路径只用于本地编辑，导入前恢复示例中的地址或移除 `$schema`。

完整示例：[开发与审查](configuration/agent-team.development.json)、[科研与验证](configuration/agent-team.research.json)。两份示例都未绑定任何 Agent。

## 格式

```json
{
  "$schema": "https://gatherthread.cn/schemas/agent-team.v1.schema.json",
  "version": 1,
  "kind": "gatherthread.agent-team",
  "draft": {
    "name": "开发小队",
    "team_prompt": "先确认目标，按实际证据报告结果。",
    "entry_node_id": "lead",
    "nodes": [
      {
        "id": "lead",
        "label": "协调员",
        "role": "拆解需求并汇总结果。",
        "prompt": "完成后说明实际修改与检查结果。",
        "x": 48,
        "y": 100,
        "target": null
      }
    ],
    "edges": []
  },
  "max_calls": 12,
  "max_duration_minutes": 30
}
```

| 字段 | 填写方式 |
| --- | --- |
| `version` / `kind` | 固定为 `1` / `gatherthread.agent-team`，用于识别格式。 |
| `draft.name` | Team 名称，1–120 个字符。 |
| `draft.team_prompt` | 全队共同指令，最多 2,000 个字符。 |
| `draft.entry_node_id` | 起始模块的 `id`；空草稿省略。 |
| `draft.nodes` | 最多 16 个模块。每个需要唯一 `id`、名称 `label`、身份 `role`、画布坐标 `x`/`y` 和 `target`。 |
| 模块的 `role` / `prompt` | 职责身份最多 1,000 个字符；可选补充提示词最多 2,000 个字符。 |
| 模块的 `target` | 未选择 Agent 时填 `null`；已有明确选择时可以保留导出的完整路由。 |
| `draft.edges` | 最多 32 条连线；每条包含唯一 `id`、`source`、`target` 和 `direction`。方向是 `one_way` 或 `bidirectional`。 |
| `max_calls` | 一次任务最多调用 1–48 次。 |
| `max_duration_minutes` | 一次任务最多运行 1–120 分钟。 |

连线的起点、终点以及起始模块必须存在，不能连接自身或重复同一方向。模块和连线 ID 只能包含英文字母、数字、`.`、`_`、`:`、`-`，最长 128 字符。空模块列表可保存为草稿，但运行前需要补齐可用模块及连接。

文件使用 UTF-8 标准 JSON，可含 UTF-8 BOM；不支持注释、尾逗号或未知字段。整个文件最多 128 KiB，团队定义本身最多 64 KiB。拼错字段、超出限制或不支持的版本会明确拒绝，原草稿保留。

## Agent 选择与可移植性

最省心的共享方式是把所有 `target` 设为 `null`，导入后在画布逐一选择 Agent。需要复用精确选择时，从界面下载已有配置即可：

- `local` 路由包含确切的 `runtime_id`、`harness`、`provider`、`model` 和可选 `reasoning_effort`。
- `shared` 路由包含 `share_id`、`share_revision` 以及确切的 harness、模型与推理强度。
- `cloud` 路由包含 `profile_id`、`provider`、`model`，以及适用的代码访问选择和个人 API 配置版本。

这些是选择标识，不是凭据。换账号、换设备、共享授权变更或模型下线后，原选择可能不可用，需要重新选择。系统不会悄悄改用另一个设备或模型。**不要在文件或提示词中填写密码、设备 Token、API Key、Cookie 等秘密**；配置文件也没有这些字段。公开分享前还应检查角色提示词是否包含私有项目信息。

可用的精确字段以 [Schema](configuration/agent-team.v1.schema.json) 为准。任务权限与共享边界遵循 [产品规范](PRODUCT_SPEC.md)、[安全说明](SECURITY.md) 和 [接口契约](INTERFACE_CONTRACTS.md)，导入配置不改变它们。

## English quick start

Open **Agent teams**, then choose a preset or **Import JSON**. Bind an exact Agent and model to each module, **Save → Test → Enable**. **Edit JSON** changes the current unsaved draft; **Import JSON** creates a new unsaved draft. Neither action executes a task or grants access. **Let AI configure it** prepares an unsent Solo chat; describe your team requirements and send it yourself.

Use `version: 1`, `kind: "gatherthread.agent-team"`, `draft`, `max_calls` and `max_duration_minutes`. Presets deliberately use `target: null`. Exported exact routes may be retained, but unavailable routes must be selected again. Configuration files never contain authentication fields, saved revisions, test receipts or enablement state. Use the linked schema and complete examples above; standard UTF-8 JSON is limited to 128 KiB, and the draft to 64 KiB.
