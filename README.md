# Branchroom

面向 AI 编程的独立桌面 Git 客户端：沿用 IDEA 的高密度 Git 交互，以批量修改审查、Agent 辅助 Review 和增量复审为核心。

**当前状态：开发准备完成，正式桌面应用尚未开始实现。** 本仓库包含产品约定、架构、接口、任务计划，以及已验证的浏览器原型。不要把原型当作已完成的应用。

## 从这里开始

| 内容 | 入口 |
| --- | --- |
| Claude Code 接手与可直接使用的开工提示词 | [接手说明](docs/HANDOFF-CLAUDE.md) |
| 用户确认的需求与首版范围 | [产品需求](docs/PRD.md) |
| 领域概念与状态约束 | [上下文](CONTEXT.md) |
| 桌面应用架构与目录规划 | [架构](docs/ARCHITECTURE.md) |
| IPC 与服务契约 | [接口契约](docs/CONTRACTS.md) |
| 开发次序与验收 | [实施计划](docs/superpowers/plans/2026-10-28-first-desktop-slice.md) |
| 本地任务列表 | [开发任务](docs/BACKLOG.md) |
| 真实使用验证方法 | [试用方案](docs/ACCEPTANCE.md) |
| Claude / Codex 接入调查与已知问题 | [Agent 接入](docs/AGENT-INTEGRATION.md) |
| 原型范围与限制 | [原型说明](reference/README.md) |

## 当前可运行的检查与参考原型

环境：Bun 1.3.11 或更高；正式应用开发建议 Node.js 22.22.0 或更高。当前准备仓库没有第三方依赖，不需要先安装 Electron。

```sh
bun run check:prep
bun run test:reference
bun run prototype:design
```

设计原型地址：<http://127.0.0.1:7458/>。停止时使用 Ctrl+C。

真实 Git 审查原型需显式提供仓库路径：

```sh
BRANCHROOM_REPO='/绝对路径/你的仓库' bun run prototype:live
```

地址：<http://127.0.0.1:7457/>。此参考界面仍保留 fde-study 的场景文案，暂不是通用仓库管理器。使用其他仓库时以真实文件列表和 Diff 为准。端口被旧原型占用时，先停止旧进程，勿直接终止未知进程。

Agent Review 使用本机 CLI 的现有账号调用模型服务，不是离线推理。原型审查数据只保存在 `reference/prototype/.review-data/`，Git 已忽略；不要提交运行记录、认证配置或被审查仓库内容。

## 技术方向

建议 Electron + React + TypeScript，以 typed preload/IPC 连接本地 Git、审查状态和 Agent 进程。Bun 先用于原型、包管理及测试；正式运行时不依赖用户另外安装 Bun。取舍记录在 [ADR 0001](docs/adr/0001-desktop-stack.md)。未安装或锁定生产依赖，正式脚手架在 BR-001 中建立。

当前没有 `dev`、`build` 或桌面发布产物。这些属于下一轮实现与验收，不应在接手时误报为已有能力。
