# 用 JSON 配置 GatherThread

适合让 Agent 帮你安排团队分工，也适合把常用偏好带到另一台设备。配置采用 **JSON + 版本号 + JSON Schema**；VS Code 等编辑器可以根据文件顶部的 `$schema` 提示字段。网页仍会完整校验，错误会标出字段位置，不会把不认识的字段悄悄忽略。

## 从哪里开始

| 想做什么 | 入口 | 文件 |
| --- | --- | --- |
| 配置外观、输入、通知、摘要等浏览器偏好 | 设置 → 通用 → JSON 配置 | `gatherthread.preferences.json` |
| 配置团队分工、提示词、连接关系和运行预算 | 管理我的 Agent → Agent Team → JSON | `gatherthread.agent-team.json` |
| 让 AI 设计一个 Team | Agent Team → 让 AI 帮我配置 | 在新 Solo 中补充需求，再发送 |

导入偏好只填入设置表单，检查后点“保存”才生效。Team 导入先打开未保存的草稿，选择各模块的 Agent 后，再保存、测试、启用。导入文件不会启动任务。

## 浏览器偏好示例

```json
{
  "$schema": "https://gatherthread.cn/schemas/preferences.v1.schema.json",
  "version": 1,
  "kind": "gatherthread.preferences",
  "interface_mode": "desktop",
  "settings": {
    "general": { "locale": "zh-CN" },
    "appearance": { "theme": "system", "motion": "system", "highContrast": false },
    "composer": { "enterBehavior": "newline", "autoScroll": true },
    "historySummaries": { "instructions": "保留已确认的决定、待办事项和重要分歧。" }
  }
}
```

只填要修改的字段，未填写的偏好保持原值。`version`、`kind` 和 `settings` 必须填写；`$schema` 和 `interface_mode` 可省略。文件使用标准 JSON，不支持注释或尾随逗号，最大 128 KiB。

| 分组 | 可配置内容 |
| --- | --- |
| `general` | `locale`: `en` / `zh-CN` |
| `appearance` | `theme`: `system` / `light` / `dark`；`textScalePercent`: 90–125；`density`: `comfortable` / `compact`；`motion`: `system` / `reduce` / `full`；`ambientCanvas`: `off` / `subtle` / `pronounced`；`highContrast`: 布尔值 |
| `layout` | `leftRailPixels`: 210–420；`rightPanelPixels`: 260–900；`composerPixels`: 210–560 |
| `sync` | `mode`: `adaptive` / `fixed`；`contextBudgetBytes`: 8192–5242880；`visibleHistorySync`: `first-connect` / `never` |
| `composer` | `enterBehavior`: `newline` / `send_chat` / `request_agent`；`confirmAgentRequest`、`autoScroll`: 布尔值 |
| `historySummaries` | `instructions`: 1–4000 字符 |
| `notifications` | `agentCompleted`、`connectionLost`: 布尔值；系统通知仍需要浏览器授权 |
| `agents` | 浏览器默认 `activeHarness`、`enabledHarnesses` 和 `customCodexModels`；不会替换已有项目绑定的具体设备和模型 |

`agents` 的 harness 值为 `codex`、`deepseek-harness`、`claude-code`、`cloud`；默认 Agent 必须包含在启用列表内。模型名称只是偏好，是否可运行仍取决于连接设备实际提供的模型。

这些偏好只用于当前浏览器。密码、API Key、设备凭据、账号管理、共享授权、GitHub 授权以及会话自动上传开关使用各自的界面，不放进可分享的配置文件。服务端部署配置见 [服务器说明](../apps/server/README.md)。

## 让 AI 配置 Team

点击“让 AI 帮我配置”会新建一个私有 Solo，并填好 `/gatherthread-config` 和“我的团队需求：”。补充你的目标、希望的分工及验收标准，选择一个可用 Agent 后发送。页面不会自动发送，也不会替你切换模型。

这是 GatherThread 内置配置技能。发送时会附带版本化格式与示例；新版 Codex/Claude 插件也提供同名 skill，以及只读的 `collaboration_get_configuration_schema`、`collaboration_validate_configuration` 工具。未安装新版插件的 Agent 仍可根据附带示例生成配置。

Agent 回复中的有效 Team JSON 会显示“预览 Team 配置”。点击后可编辑、选择各模块的 Agent，再走正常的保存与测试流程。现有 Team 会作为参考附带给 Agent；超过 6000 字符的配置会保留在编辑器并提示使用 JSON 编辑或下载，给需求和格式说明留出空间。也可以从 Team 列表点击“让 AI 帮我配置”，从需求设计一个新 Team。

新建 Solo 在未提交任何消息时，切换会话或项目会自动清理；尚在发送时需先等待结果。已发送过内容的 Solo、其他设备已写入的会话、Multi 都会保留。断网导致无法确认清理时，会保留会话并提示。已关闭整个网页的空会话可能仍在列表中，可手动删除。

Team 字段、预设和示例详见 [Agent Team 配置](AGENT_TEAM_CONFIGURATION.md)。JSON Schema 的结构提示不能代替服务端对图结构、权限和运行目标的校验。

## 给 Agent 或编辑器的文件

- [偏好 Schema](configuration/preferences.v1.schema.json)
- [Team Schema](configuration/agent-team.v1.schema.json)
- [开发 Team 示例](configuration/agent-team.development.json)
- [科研 Team 示例](configuration/agent-team.research.json)

Schema 来自 `packages/protocol` 的校验定义。发布网站同时提供 `/schemas/preferences.v1.schema.json` 和 `/schemas/agent-team.v1.schema.json`；导入不会跟随配置文件中的任意网址获取或执行内容。
