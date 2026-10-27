# Branchroom 开发约定

## 当前工作阶段

本轮用户要求只完成开发前期准备，后续由 Claude Code 开始实现。准备阶段不要自动启动完整产品开发。用户在后续明确要求继续开发时，按 docs/HANDOFF-CLAUDE.md 和 docs/BACKLOG.md 从 BR-001 开始。

## 产品事实

- 独立 Git 桌面客户端；IDEA 风格已获用户认可。
- 首要差异点：批量 AI 修改审查、本地 Claude Code / Codex 辅助 Review、反馈与增量复审。
- 用户已明确卸载并禁止 brainstorming 技能，不要使用、恢复或重新安装它。
- 用户不希望反复确认已授权的常规工作。工程内部可逆决策可自行处理并记录。

## 阅读顺序

README.md → CONTEXT.md → docs/PRD.md → docs/ARCHITECTURE.md → docs/CONTRACTS.md → docs/BACKLOG.md → docs/HANDOFF-CLAUDE.md。
Agent 接入任务另读 docs/AGENT-INTEGRATION.md；UI 任务另读 .impeccable.md 和 reference/README.md。

## 工程边界

- reference/ 是归档的设计/可运行原型，绝不直接作为生产架构，也不要批量改写以掩盖其已知限制。
- 不复制原型的 .review-data、CLI 输出、账号配置、真实仓库文件和会话记录。
- 正式产品不能硬编码 fde-study、开发者用户名、端口或 Agent 安装路径。
- 用户仓库只作为输入；不得为测试制造改动、提交、stash 或切换分支。自动化测试使用临时 Git 仓库。
- Git 暂存/提交等写操作只由明确的产品操作触发。Agent 辅助审查不写仓库，不自动判定“已审查”。
- 使用参数数组调用子进程，不拼 shell 命令。不通过更改用户全局 Agent 配置修复兼容性。
- 报错、取消、未覆盖、内容过期和“未发现问题”必须区分。

## 验证与报告

修改功能前为关键行为写失败测试；验证真实行为而非实现细节。UI 要做实际桌面/浏览器检查。完成后报告真实通过项与限制。

当前命令：
- 准备检查与参考原型：`bun run check:prep`；`bun run test:reference`
- 正式应用（BR-001 建立）：`bun run typecheck`；`bun run test`（vitest 单元+集成）；`bun run test:e2e`（Playwright 真实窗口）；`bun run build`；`bun run package:mac`
- vitest 只发现 `tests/unit` 与 `tests/integration`；`tests/e2e` 由 Playwright 运行，会先执行 `bun run build`。参考原型的 Bun 测试仍走 `test:reference`，vitest 不扫描 `reference/`。
- e2e 通过 `BRANCHROOM_USER_DATA_DIR` 隔离 userData，在主进程替换系统目录对话框；不要在生产代码里添加测试后门。

## Agent skills

- issue_tracker: local-markdown
- issue_tracker_path: docs/BACKLOG.md
- issue_ids: BR-001 起递增
- statuses: ready / in-progress / blocked / done / backlog
- triage_labels: feature / bug / architecture / design / verification
- domain_context: CONTEXT.md
- architecture_decisions: docs/adr/
- specs: docs/PRD.md、docs/CONTRACTS.md
- 使用子代理与否服从用户当轮指示；不要只因任务可拆分就自动派出多个实现代理。
