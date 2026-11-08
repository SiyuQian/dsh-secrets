# 阶段 0：DSH API 调研结论（DSH 0.2.2-rc.1）

来源：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 解包后的 `dsh/node_modules/@deepseek-ai/*`，以及 profile 中已安装的第三方插件 `dsh-plugin-github`、`dsh-visual-workflow`、`dsh-pocket`。

| # | 问题 | 结论 | 出处 |
|---|---|---|---|
| Q1 | Client→Host 独立提交通道 | ✅ `ctx.connection.fetch.register({ path: '/api/<method>', methods: ['POST'], requestBody: 'buffered', fetch })`。浏览器调用 `ctx.get('connection').rpc.call('/api', method, payload)`。**不写会话日志**：这条通道不经过 session、commands 或 tools。 | `dsh-plugin-github/lib/index.js` 的 `payloadRoute`；`dsh-client-connection/lib/index.js:823-851` |
| Q2 | 认证 | ✅ `/api` 前缀路由会先调用 `connection.admit(req)`，检查可信 Host/Origin 和浏览器 cookie，失败返回 401/403，之后才会分发到 fetch 路由。nonce 不需要。 | `dsh-client-connection/lib/index.js:1044-1058` |
| Q3 | `shellEnv` 运行时动态 key | ❌ contributor 必须预先声明 `variables`，返回未声明的 key 会直接报错。v1 不做 session 注入，只支持 dotenv。 | `dsh-shell-env` README「Adding your own environment facts」 |
| Q4 | 不展开步骤组也能填写凭据 | ✅ 活跃表单放在 `conversation.input.dock`（session-scoped list）而不是工具行内部。`useChat` 取最新 open Turn，再以 `nodes.turnDataSource(turn, 'tool-call')` + `useSyncExternalStore` 订阅该 Turn 的工具投影；其中 `{ root }` 包括折叠组里的工具。只为 `root.phase === 'start'` 的 `request_secret` 显示表单，并以 sessionId + callId 为 key 清理状态。`tool.call.toolview` 只显示摘要和完成回执。 | live `Slots.listSubTree('conversation.input.dock')`；`dsh-client-ui-chat` README:90，`lib/client.js`:10582–10608、10647–10649、15318–15331 |
| Q5 | post-execute 的覆盖面 | ✅ 所有工具（包括子代理内部的调用）都会经过共享 pipeline 的 `tools/post-execute`。监听器签名为 `(exec, result, next)`，返回 `{kind:'accept', content}` 可替换 content，返回 `{kind:'block', feedback}` 可阻断。spill-policy 在 `next()` 之后运行，我们的监听器先调用 `next()` 再脱敏，因此 spill 写盘前的 content 就已经脱敏（spill 写入的是 decision.content）。PTC 子调用的 canonical value 不受影响，所以检测到 `exec.parent` 时直接拒绝 `request_secret`。 | `dsh-tools/lib/types/pipeline.js:411-458`；`dsh-spill-policy/lib/index.js:237` |
| Q6 | 设置页 slot | ✅ `ctx.slots.register({ name: 'settings.section', id, order, label: () => string, inject: () => props }, Component)` | `dsh-pocket/client/index.jsx:680`；`dsh-client-ui-agent-preset` |

## 其他确认项

- **Guard**：`ctx.tools.guard(exec => reason | undefined)` 是同步、单调的；其他插件的 allow 不能推翻它。`pre-execute` 返回 `{kind:'ask', reason, displayReason}` 时，由 `ctx.get('approval')` 弹出用户确认。没有 approval 服务时降级为 deny（fail-closed）。
- **参数**：参数会被 deepFreeze，pre-execute 不能改写参数。这与设计一致：v1 不做参数注入。
- **人机交互**：只允许 runtime root 发起。判断方式为 `ctx.get('agents').roots().includes(agent)`，与 `userQuestions` 相同。
- **Skill**：`ctx.skills.registerProvider(() => ({ name, list, get }))`，可参照 `dsh-skill-office` 的实现。
- **工具注册**：`ctx.tools.register(definition)`。definition 必须包含 `output: { schema, render }`，parameters 使用原生 JSON Schema。参照 `dsh-visual-workflow` 的自写 defineTool。
- **超时**：只有 definition 声明了 `timeoutMs` 才会被截止，我们的超时自己管理。
- **主题 token**：`--dsw-alias-label-{primary,secondary,tertiary}`、`--dsw-alias-bg-layer-{1,2}`、`--dsw-alias-border-l{1,2}`、`--dsw-alias-state-{error,warn,success}-primary`、`--dsw-alias-button-primary-fill`、`--dsw-alias-interactive-bg-hover`。
