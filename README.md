# SukiTab

[![VS Code](https://img.shields.io/badge/VS%20Code-1.102.0+-blue.svg)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)](https://www.typescriptlang.org/)

VS Code 扩展，使用你自己的 OpenAI 兼容 API 端点（BYOK — Bring Your Own Key）提供 AI 代码补全。

支持所有兼容 OpenAI FIM（Fill-in-the-Middle）接口的服务商：DeepSeek、OpenAI、Qwen、硅基流动等。

> **本项目基于 [Cometix Tab](https://github.com/Cometix-Org/cometix-tab-copilot-exp) 修改而来，遵循 AGPL-3.0 协议。**
> 原项目由 Haleclipse / Cometix-Org 开发，原始代码版权归原作者所有。
> 本 fork 移除了对 Cursor 后端 API 的依赖，改为 BYOK（Bring Your Own Key）模式，使用 OpenAI 兼容的 FIM 接口进行代码补全。

## 功能特性

- **实时代码补全**：基于上下文的内联建议，输入时自动触发
- **流式响应**：SSE 实时接收建议文本，无需等待完整响应
- **双 API 路由**：支持 `/v1/completions`（prompt+suffix）和 `/v1/chat/completions`（FIM 模板）两种接口
- **多 Provider 管理**：配置文件中可定义多个服务商，随时切换
- **热重载**：修改配置文件后自动生效，无需重启
- **智能上下文**：自动包含最近查看的文件、LSP 建议、诊断错误作为上下文
- **智能触发**：防抖、冷却、编辑追踪、LSP 事件触发

## 快速开始

### 1. 安装扩展

```bash
git clone https://github.com/Okysu/suki-tab.git
cd suki-tab
pnpm install
pnpm run compile
```

在 VS Code 中按 F5 启动调试，或打包为 VSIX：

```bash
pnpm run package
code --install-extension suki-tab-0.1.0.vsix
```

### 2. 创建配置文件

默认情况下，扩展会优先读取工作区中的 `.vscode/byok-config.json`；如果不存在，则回退到全局配置文件。下面是配置内容示例：

```json
{
  "providers": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/beta",
      "apiKey": "sk-your-api-key-here",
      "apiType": "completions",
      "model": "deepseek-chat",
      "temperature": 0.2,
      "maxTokens": 4096,
      "contextLength": 8192,
      "stopTokens": ["\n\n"],
      "fimTemplate": null,
      "customPrompt": null
    }
  ],
  "activeProvider": "deepseek",
  "features": {
    "enabled": true,
    "enableInlineSuggestions": true,
    "enablePrediction": true,
    "enableDiagnosticsHints": true,
    "enableAdditionalFilesContext": true,
    "triggerInComments": true,
    "excludedLanguages": []
  },
  "debug": {
    "enabled": false,
    "logStream": false,
    "logPayloads": false
  }
}
```

也可以通过命令面板执行 `SukiTab: Create Default Config` 自动生成。

### 3. 使用

正常编写代码，灰色虚拟文本即为 AI 建议，按 `Tab` 接受。

## 配置说明

### Provider 配置

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Provider 显示名称（用于切换时的标识） |
| `baseUrl` | string | API 基础 URL，如 `https://api.deepseek.com/beta` |
| `apiKey` | string | API 密钥 |
| `apiType` | `"completions"` \| `"chat"` | 接口路由类型 |
| `model` | string | 模型名称 |
| `temperature` | number | 采样温度（0.0–2.0） |
| `maxTokens` | number | 最大生成 token 数 |
| `contextLength` | number | 上下文窗口大小（控制发送多少 prefix/suffix） |
| `stopTokens` | string[] | 停止生成的标记 |
| `fimTemplate` | string \| null | Chat 模式的 FIM 模板，支持 `{prefix}`、`{suffix}`、`{language}`、`{filename}` 占位符 |
| `customPrompt` | string \| null | 自定义系统提示词，null 使用内置默认 |

### apiType 详解

- **`completions`**：使用 `/v1/completions` 接口，发送 `prompt` + `suffix` 参数（原生 FIM）
- **`chat`**：使用 `/v1/chat/completions` 接口，通过 `fimTemplate` 将 prefix/suffix 组装为消息

### 多 Provider 示例

```json
{
  "providers": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/beta",
      "apiKey": "sk-xxx",
      "apiType": "completions",
      "model": "deepseek-chat",
      "temperature": 0.2,
      "maxTokens": 4096,
      "contextLength": 8192,
      "stopTokens": ["\n\n"],
      "fimTemplate": null,
      "customPrompt": null
    },
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-xxx",
      "apiType": "chat",
      "model": "gpt-4o-mini",
      "temperature": 0.2,
      "maxTokens": 2048,
      "contextLength": 4096,
      "stopTokens": ["\n\n\n"],
      "fimTemplate": "<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>",
      "customPrompt": null
    }
  ],
  "activeProvider": "deepseek"
}
```

### 功能开关

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `features.enabled` | `true` | 总开关 |
| `features.enableInlineSuggestions` | `true` | 启用内联代码建议 |
| `features.enablePrediction` | `true` | 启用预测装饰 |
| `features.enableDiagnosticsHints` | `true` | 将诊断错误作为上下文 |
| `features.enableAdditionalFilesContext` | `true` | 将最近查看的文件作为上下文 |
| `features.triggerInComments` | `true` | 在注释中触发建议 |
| `features.excludedLanguages` | `[]` | 禁用建议的语言 ID 列表 |

### VS Code 设置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `sukiTab.configFilePath` | `"(auto-detected)"` | 配置文件路径（支持自动检测、相对工作区根目录或绝对路径） |
| `sukiTab.enabled` | `true` | 总开关（VS Code 设置级别） |

`sukiTab.configFilePath` 的解析优先级如下：

1. **自定义路径**：`sukiTab.configFilePath` 设置值（覆盖所有默认行为）
2. **项目级路径**：工作区内存在 `.vscode/byok-config.json` 时优先使用
3. **全局默认路径**：`%APPDATA%/Code/User/globalStorage/Okysu.suki-tab/byok-config.json`

### 键盘快捷键

| 快捷键 | 说明 |
|--------|------|
| `` Alt+\ ``（Windows/Linux）/ `` Option+\ ``（Mac） | 手动触发补全 |
| `Tab` | 接受建议 |

## 命令

| 命令 | 说明 |
|------|------|
| `SukiTab: Accept Inline Suggestion` | 接受当前建议 |
| `SukiTab: Select AI Provider` | 切换 Provider |
| `SukiTab: Select Model` | 切换当前 Provider 的模型 |
| `SukiTab: Test Connection` | 测试当前 Provider 连接 |
| `SukiTab: Open Config File` | 打开配置文件 |
| `SukiTab: Create Default Config` | 创建默认配置文件 |
| `SukiTab: Toggle Enabled` | 开启/关闭补全 |
| `SukiTab: Snooze Completions` | 暂停补全一段时间 |
| `SukiTab: Cancel Snooze` | 取消暂停 |
| `SukiTab: Reset Statistics` | 重置会话统计 |
| `SukiTab: Show Logs` | 显示输出日志 |
| `SukiTab: Enable Proposed API` | 启用 VS Code Proposed API |

## Proposed API

本扩展使用 VS Code Proposed API (`inlineCompletionsAdditions`) 提供完整功能。首次启动时会自动检测并提示启用。

## 项目结构

```
src/
├── api/          # OpenAI 兼容客户端、SSE 解析
├── commands/     # VS Code 命令（Provider、Model 管理）
├── container/    # 依赖注入容器
├── context/      # 类型定义、接口契约、请求构建
├── controllers/  # 预测控制器
├── providers/    # InlineCompletionProvider
├── services/     # 核心服务（ConfigManager、状态机、触发器等）
├── ui/           # 状态栏、菜单面板
├── utils/        # 工具函数
└── extension.ts  # 扩展入口
```

## 开发

```bash
pnpm install       # 安装依赖
pnpm run compile   # 编译（类型检查 + lint + esbuild）
pnpm run watch     # 监视模式
pnpm run package   # 生产构建
pnpm run check-types  # 仅类型检查
pnpm run lint      # 仅 lint
```

## 依赖

- `@vscode/sudo-prompt` - Proposed API 启用时的权限提升

## 致谢

本项目基于 [Cometix Tab](https://github.com/Cometix-Org/cometix-tab-copilot-exp) 开发，感谢原作者 Haleclipse / Cometix-Org 的工作。

原项目探索了 Cursor Tab 的接口与代码逆向，希望 Cursor 有朝一日能提供官方的 VS Code 插件。

## 许可证

[AGPL-3.0](LICENSE) — 与原项目保持一致。
