# Branchroom

面向 AI 编程的独立桌面 Git 客户端：沿用 IDEA 的高密度 Git 交互，以批量修改审查、Agent 辅助 Review 和增量复审为核心。

**当前状态：BR-001 首个桌面切片已实现（Electron + React + TS 工程、原生选仓库、受限 preload、测试与本地打包）。变更阅读、人工审查持久化与 Agent Review 属于 BR-002 起，尚未实现。** 参考 `reference/` 仍是原型，不是正式应用。

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

## 正式应用命令（BR-001 建立）

环境：Node.js ≥ 22.22.0 与 Bun ≥ 1.3.11 作为开发工具；打包后的应用不依赖 Bun。

```sh
bun install          # 安装锁定依赖（electron 在 trustedDependencies 中，首次安装会下载二进制）
bun run dev          # 启动开发模式（electron-vite dev）
bun run typecheck    # tsc --noEmit
bun run test         # vitest：单元 + 集成测试（临时 Git 仓库 fixture）
bun run test:e2e     # Playwright 驱动真实 Electron 窗口
bun run build        # 构建主进程/preload/renderer 到 out/
bun run package:mac  # build + electron-builder 生成 dist/ 下的本地 .app（未签名）
```

锁定版本：electron 45.0.0、electron-vite 6.0.0、vite 8.3.5、React 19.3.1、TypeScript 5.9.3、Vitest 5.0.5、Playwright 1.64.1、electron-builder 26.18.0（均 `--exact`，见 lockfile）。选型理由见 [ADR 0001](docs/adr/0001-desktop-stack.md)。

当前能力边界：可选择本地目录并校验 Git 仓库身份（名称、路径、分支/分离 HEAD、HEAD、worktree），最近仓库列表带失效标记与移除；取消选择不是错误；非 Git 目录、裸仓库、不存在的路径返回明确错误码。renderer 运行在 contextIsolation + sandbox 之下，只有 `window.branchroom` 上的五个类型化方法。**尚无** Diff 阅读、审查状态、Agent Review、Git 写操作。

自动化说明：`tests/e2e` 通过环境变量 `BRANCHROOM_USER_DATA_DIR` 隔离 userData，并通过 Playwright 在主进程内替换系统目录对话框，生产代码不含测试后门。

## 参考原型（不是正式应用）

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
