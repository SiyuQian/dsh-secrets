# DSH API 调研结论（DSH 0.2.2-rc.1）

[English](./api-findings.md) | 简体中文

来源：DSH 桌面应用附带的已安装 `@deepseek-ai/*` 包、实时 Cordis 检查，以及当前 profile 中安装的第三方插件 `dsh-plugin-github`、`dsh-visual-workflow` 和 `dsh-pocket`。下文的包路径和行号仅对应本次检查的版本，并非稳定的 API 标识符。

| # | 问题 | 结论 | 来源 |
|---|---|---|---|
| Q1 | 独立的 Client-to-Host 提交通道 | 支持通过 `ctx.connection.fetch.register({ path: '/api/<method>', methods: ['POST'], requestBody: 'buffered', fetch })` 注册。浏览器调用 `ctx.get('connection').rpc.call('/api', method, payload)`。**此通道不会写入会话日志：**它绕过会话、命令和工具。 | `payloadRoute`（位于 `dsh-plugin-github/lib/index.js`）；`dsh-client-connection/lib/index.js:823–851` |
| Q2 | 身份验证 | `/api` 下的路由先调用 `connection.admit(req)`，检查可信的 Host/Origin 和浏览器 cookie。验证未通过时，在分派到 fetch 路由前返回 401/403。无需单独的 nonce。 | `dsh-client-connection/lib/index.js:1044–1058` |
| Q3 | 在 `shellEnv` 中使用动态运行时键 | 不支持。贡献方必须预先声明 `variables`；返回未声明的键会报错。因此，第 1 版使用 dotenv 文件，而不向会话环境注入变量。 | `dsh-shell-env` README 的“Adding your own environment facts”一节 |
| Q4 | 无需展开进程组即可输入凭据 | 将当前表单放入会话作用域的 `conversation.input.dock` 列表，而不是工具行内。通过 `useChat` 选取最新的未结束 Turn，再通过 `nodes.turnDataSource(turn, 'tool-call')` 和 `useSyncExternalStore` 订阅该 Turn 的工具投影。每个 `{ root }` 都包含被折叠分组隐藏的工具。仅为 `root.phase === 'start'` 的 `request_secret` 显示表单，并使用 `sessionId + callId` 作为键，以重置本地状态。`tool.call.toolview` 只显示摘要和已结束调用的回执。 | 实时 `Slots.listSubTree('conversation.input.dock')`；`dsh-client-ui-chat` README:90 和 `lib/client.js:10582–10608,10647–10649,15318–15331` |
| Q5 | 执行后处理的覆盖范围 | 所有工具，包括子代理内的调用，都会经过共享的 `tools/post-execute` 管线。监听器接收 `(exec, result, next)`；`{ kind: 'accept', content }` 替换内容，`{ kind: 'block', feedback }` 阻止内容返回。溢写策略在 `next()` 之后运行；本插件先调用 `next()`，再执行脱敏，因此 `decision.content` 在写入溢写文件前已完成脱敏。PTC 子调用会保留独立的规范值，因此 `request_secret` 会拒绝任何带有 `exec.parent` 的执行。 | `dsh-tools/lib/types/pipeline.js:411–458`；`dsh-spill-policy/lib/index.js:237` |
| Q6 | 设置页插槽 | 使用 `ctx.slots.register({ name: 'settings.section', id, order, label: () => string, inject: () => props }, Component)` 注册。 | `dsh-pocket/client/index.jsx:680`；`dsh-client-ui-agent-preset` |

## 其他结论

- **读取防护：**`ctx.tools.guard(exec => reason | undefined)` 同步执行，且具有单调性。其他插件的放行无法覆盖它的拒绝。`pre-execute` 返回 `{ kind: 'ask', reason, displayReason }` 时，会通过 `ctx.get('approval')` 请求用户确认。检查到的接口约定要求 `displayReason` 是必须包含 `en` 条目的语言映射，而非普通字符串。本插件同时提供 `zh`，未匹配到相应语言时仍回退到英文。若没有 approval 服务，则拒绝执行（fail-closed）。
- **参数：**工具参数会被深度冻结；pre-execute 监听器无法改写参数。这与第 1 版不注入参数值的设计一致。
- **交互式请求：**只有运行时根代理可以发起表单请求，沿用 `userQuestions` 模式，通过 `ctx.get('agents').roots().includes(agent)` 检查。
- **Skills：**使用 `ctx.skills.registerProvider(() => ({ name, list, get }))` 注册 provider；参见 `dsh-skill-office` 的实现。
- **工具注册：**`ctx.tools.register(definition)` 要求提供 `output: { schema, render }`；参数使用原生 JSON Schema。`dsh-visual-workflow` 中自定义的 `defineTool` 提供了示例。
- **超时：**只有工具定义声明了 `timeoutMs`，框架才会设置工具执行截止时间。本插件自行管理表单超时。
- **主题 token：**检查到的 UI 使用 `--dsw-alias-label-{primary,secondary,tertiary}`、`--dsw-alias-bg-layer-{1,2}`、`--dsw-alias-border-l{1,2}`、`--dsw-alias-state-{error,warn,success}-primary`、`--dsw-alias-button-primary-fill` 和 `--dsw-alias-interactive-bg-hover`。
