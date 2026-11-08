# dsh-secrets

[English](./README.md) | 简体中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，让 Agent 通过安全表单向你索取 API key、密码和 token，而不把凭据值暴露给模型。

## 工作原理

1. Agent 调用 `request_secret`，指定变量名、用途和 dotenv 文件。
2. 密码表单直接显示在聊天输入框上方，并聚焦第一个字段。即使对话中的工作详情已折叠，表单仍可填写；工具行只显示请求状态。
3. 你输入的值通过经过认证的 `/api/dsh-secrets.*` 路由直接发送给 Host，不会成为工具参数、工具结果或会话事件。
4. 值写入权限为 `0600` 的 dotenv 文件。已有行、注释和换行格式都会保留。
5. Agent 只收到 `{ status, path, names, added, updated, unchanged, kept }`。

内置的 `secrets` skill 告诉 Agent 何时以及如何调用该工具。

文档提供英文和简体中文两版，英文是默认入口。界面和审批提示均支持两种语言，跟随 Harness 的语言设置；没有对应翻译时回退到英文。

## 防护措施

| 层级 | 机制 | 作用 |
|---|---|---|
| L1 读取拦截 | `ctx.tools.guard()` | 拒绝 `read`、`edit`、`write`、`grep`，以及读取受管理文件的 shell 命令（如 `cat`、`cp`、`source`、`python -c open(...)` 等）。其他插件无法覆盖该拒绝。 |
| L2 输出脱敏 | `tools/post-execute` | 将工具结果中的受管理凭据替换为 `[REDACTED:NAME]`，包括 base64（所有对齐方式，例如 Basic auth 内的编码）、URL 编码、JSON 转义和十六进制形式。脱敏失败时不返回该输出。 |
| L3 外发审批 | `tools/pre-execute` → `ask` | shell 命令同时使用受管理变量和 `curl`、`echo`、`printenv`、`ssh` 等命令时，先请求你的确认。 |
| 日志不含凭据值 | 独立 fetch 路由 | 会话日志只记录变量名、路径和数量。`registry.json` 只保存变量名、路径及 8 位字符的指纹。 |

其他规则：

- `env_file` 必须位于工作目录内。
- 子 Agent 和 `run_code`（PTC）程序不能打开表单。
- 取消后，同一轮对话中不能再次请求相同的变量。

**设置 → Secrets** 使用自适应卡片列出受管理变量，包含完整文件路径、指纹、更新时间和操作按钮。长变量名和路径在面板内换行，无需横向滚动。你可以停止管理某个变量，也可以从文件中删除它。页面不会显示凭据值。

## 已知限制

- 如果 Agent 自行编写程序读取文件，对值做任意变换后再外发，仍可能绕过 L1–L3。请只在可信的工作区中使用。这些措施提高了防护门槛，但不是沙箱。
- 少于 6 个字符的值无法脱敏，设置页会标记它们。
- L3 审批按命令进行，暂不支持“本会话始终允许”。
- 目前只支持 dotenv 文件，不支持 Keychain 或环境变量注入。

## 安装

需要 DeepSeek Harness 0.2.x 和 Node 22 或更高版本。

在 Harness 会话中，让 Agent 安装该 bundle：

```
plugin_manager install_bundle  target: https://github.com/SiyuQian/dsh-secrets.git
```

也可以克隆仓库后从本地目录安装：

```
git clone https://github.com/SiyuQian/dsh-secrets.git
# then in Harness: plugin_manager install_bundle  target: /absolute/path/to/dsh-secrets
```

安装后刷新 Web GUI。

## 配置

配置是可选的。在 profile 的 `cordis.patch.yml` 中设置：

```yaml
- id: dsh-secrets
  name: dsh-secrets
  config:
    timeoutMs: 600000        # form timeout, default 10 min
    dataDir: /abs/path       # registry location, default $DSH_HOME/plugins/dsh-secrets
    allowOutsideCwd: false   # allow env_file outside the working directory
```

`timeoutMs` 是表单超时时间，默认 10 分钟；`dataDir` 是注册信息目录；`allowOutsideCwd` 控制是否允许 `env_file` 位于工作目录之外。

## 开发

```
npm ci --ignore-scripts
npm test   # node:test; Client tests use React and react-test-renderer
```

| 文件 | 内容 |
|---|---|
| `lib/index.js` | Host：工具、路由、读取拦截、事件钩子和 skill provider |
| `lib/dotenv.js` | dotenv 内容合并、解析和删除 |
| `lib/redactor.js` | 凭据值及其编码变体的脱敏 |
| `lib/policy.js` | L1 和 L3 规则 |
| `lib/store.js` | 带 sha256 冲突重试的原子 `0600` 写入，以及注册信息管理 |
| `client/client.js` | 凭据输入区域、工具状态和设置卡片，使用原生 JavaScript，无需构建 |
| [API findings](./docs/api-findings.md) / [API 调研结论](./docs/api-findings.zh-CN.md) | 插件依赖的 Harness API 及其依据 |

修改行为、命令或安全限制时，请同步更新中英文文档。代码标识符、协议字段和共用命令示例保持英文。内置 Agent skill 使用同一份英文源文档，确保两种界面语言下的 Agent 接收相同的安全指令。

## 开源协议

MIT
