# Branchroom

[![CI](https://github.com/huanyusun/branchroom/actions/workflows/ci.yml/badge.svg)](https://github.com/huanyusun/branchroom/actions/workflows/ci.yml)

面向 AI 编程的独立桌面 Git 客户端：沿用 IDEA 的高密度 Git 交互，以批量修改审查、Agent 辅助 Review 和增量复审为核心。

**当前状态：BR-001..006 已实现并可日常使用（工程、真实变更阅读与 Diff、人工审查持久化、Agent Review 真实调用、意见采纳与复审闭环、暂存与提交到本地分支），打包产物见 Actions/Release。BR-005 剩余三轮真实试用待用户参与；下一项是 BR-007（分支与历史）。尚无 fetch/pull/push 与远程操作。** 参考 `reference/` 仍是原型，不是正式应用。

## 在其他电脑获取构建

- 推送即自动验证：GitHub → Actions → **CI** 查看每次提交的检查结果。
- 要拿现成的 app：Actions → **Build macOS app** → Run workflow → 完成后在该次运行底部下载 `Branchroom-mac-arm64.zip`（Apple Silicon）或 `Branchroom-mac-x64.zip`（Intel）；推 `v*` 标签会自动发 Release。CI 产物为未签名构建，首次打开需在「系统设置 → 隐私与安全性」允许。

## 从这里开始

| 内容 | 入口 |
| --- | --- |
| Claude Code 接手与可直接使用的开工提示词 | [接手说明](docs/HANDOFF-CLAUDE.md) |
| 用户确认的需求与首版范围 | [产品需求](docs/PRD.md) |
| 领域概念与状态约束 | [上下文](CONTEXT.md) |
| 领域身份、审查语义与图谱草案 | [领域本体](docs/ONTOLOGY.md) |
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
bun run test:e2e     # Playwright 驱动真实 Electron 窗口（out/ 构建）
bun run build        # 构建主进程/preload/renderer 到 out/
bun run package:mac  # build + electron-builder 生成 dist/ 下的本地 .app（本机签名，未公证）
bun run verify:packaged  # 重新打包并强制验证 .app 真实启动（产物缺失即失败）
```

锁定版本：electron 45.0.0、electron-vite 6.0.0、vite 8.3.5、React 19.3.1、TypeScript 5.9.3、Vitest 5.0.5、Playwright 1.64.1、electron-builder 26.18.0（均 `--exact`，见 lockfile）。选型理由见 [ADR 0001](docs/adr/0001-desktop-stack.md)。

当前能力边界：可选择本地目录并校验 Git 仓库身份；读取工作区相对 HEAD 的真实变更（未跟踪、已暂存、未暂存、删除、重命名、冲突），一次性构建一致快照（以 HEAD + status 深度核对保证期间变化会整体重试，不返回混合快照）；文件列表带 A/M/D/R/U 标记、审查状态图标与增删行数；修改文件为左右逐行对齐的双栏 Diff，新增/删除文件单栏，另有全文视图与手动刷新；二进制、符号链接、子模块、超限大文件不可审阅但会显示明确原因，不会消失。人工审查：按文件标记已审查/问题/重置，反馈草稿自动保存，全部绑定内容身份并持久化；内容变化派生“待复审”，仅移动暂存位置不失效；多仓库与 worktree 按根目录隔离。**Agent Review**：检测本机 Codex / Claude Code CLI（区分未安装/不兼容/可用），对整批、单文件或仅待复审文件发起真实审查（只读沙箱、stdin 传提示词、结构化输出 + 严格本地校验），意见区分 issue/verify、一击定位到行并展开依据，采纳仅生成反馈草稿（旧版本意见拦截），进行中可停止（终止整棵进程树），run 历史逐次保留，应用退出前清理进程；Claude 兼容问题已解决（保留用户 provider 配置），真实调用验证见 `bun scripts/real-agent-check.ts`。**暂存与提交（BR-006）**：按文件显式暂存/取消暂存、提交预览（文件与增删统计）、提交已暂存到当前分支、文件级提交（只提交所选文件当前内容）；必须填写提交信息，使用你自己的 Git 提交身份；无推送/远程/force 操作。renderer 运行在 contextIsolation + sandbox 之下，只有 `window.branchroom` 上的 19 个类型化方法。**尚无** 分支图/历史浏览（BR-007）、fetch/pull/push、hunk 级暂存。

自动化说明：`tests/e2e` 通过环境变量 `BRANCHROOM_USER_DATA_DIR` 隔离 userData，并通过 Playwright 在主进程内替换系统目录对话框，生产代码不含测试后门。

## 快速上手（使用打包好的应用）

1. `bun run verify:packaged` 构建并验证 `dist/mac/Branchroom.app`（本机签名，未公证，仅本机使用）。
2. 打开应用 → 「打开本地仓库…」选择你的仓库 → 查看变更 → 对需要第二双眼睛的改动点「审查全部变更」。
3. 单击 Agent 意见定位到行；「采纳为反馈草稿」把意见变成反馈；修好后「刷新」→「复审待复审文件」。
4. 审完的文件点「暂存」，填写提交信息后「提交已暂存」（或对单个文件用「提交所选文件」）。提交只写本地分支，不做任何远程操作。

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
