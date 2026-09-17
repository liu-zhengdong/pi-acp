# pi-acp 开发规范

## 目标与结构

本仓库在不修改 Pi 核心的前提下，将 ACP 接到 `pi --mode rpc` 子进程。

- `src/acp/app.ts`：使用 `@agentclientprotocol/sdk` builder API 注册 ACP 请求入口。
- `src/acp/`：处理协议、会话生命周期、权限及对外事件。
- `src/pi-rpc/`：管理 Pi 子进程、RPC 请求、内部扩展及 MCP 注册桥接。
- ACP 侧使用 stdio JSON-RPC；Pi 侧使用 stdio 换行分隔 JSON。每个活跃 ACP 会话对应独立的 Pi 子进程。

## MCP 接入边界

- `session/new`、`session/load`、`session/resume` 可携带 stdio、Streamable HTTP、SSE 服务描述；在原始请求边界校验，避免 SDK 丢弃无效项后静默降级。
- 非空服务列表要求配套 pi-mcp-adapter 返回 `toolExposure: "proxy-only"`。带 MCP 的新子进程在启动时选择固定代理模式；空列表不强制依赖 MCP 扩展。
- 业务工具经固定代理发现和调用；使用说明追加到后续上下文，不把业务工具新增到模型 `tools`，不改写 system prompt。
- 保留原有服务，名称冲突拒绝，失败回滚，只释放桥接持有的注册。关闭／删除会话时清理内存中的服务描述。
- 不新增 pi-acp 自有 MCP 配置存储；连接凭据不加入模型消息。上游既有 Session 映射和 adapter 元数据缓存仍存在。
- 运行中新增 MCP 端点不是本次对外协议范围；已接入服务的目录变化沿用 MCP 通知机制。

## 实现约束

- Pi 自行执行本地文件和终端操作，不新增 ACP 客户端文件／终端委派。
- 使用小型转换函数连接 Pi 事件与 ACP 更新，并保留流式输出、取消和子进程清理的测试。
- 异常路径明确失败，不把部分能力可用表述为请求完整成功。
- 优先明确类型，避免 `any`。注释解释不明显的设计原因，不复述代码。

## 开发与验证

```bash
npm ci
npm run validate
npm run smoke
```

`validate` 包含格式、类型、lint、测试和构建。修改范围较小时先定向格式化，不让格式化过程改动原始验收证据。

MCP 联调使用 README 中的 `npm run smoke:mcp` 入口，并设置 `PI_ACP_MCP_EXTENSION` 指向配套扩展。该入口使用真实 Pi 与 MCP adapter、临时配置及本地模型夹具；检查工具往返、坏输入、完整工具定义、上下文和恢复，不代表真实模型自主行为的质量验收。

## 协作与交付

- 按用户授权提交代码；变更关联追踪 issue，通过 PR 审阅。设计讨论和工作进度维护在 issue/PR，正式使用说明维护在 README。
- issue、PR 说明和新增／修改文档默认中文；代码标识、命令及协议字段保持准确原文。
- 交付说明区分本地验证、远端 CI 和未覆盖范围；涉及配套 adapter 时明确版本或提交依赖，不自动替换用户全局安装。
