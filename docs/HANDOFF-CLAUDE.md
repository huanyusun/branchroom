# Claude Code 接手说明

## 接手时的真实状态

- 项目位置：本仓库根目录 `branchroom`。这是独立项目，不是 fde-study 的改动。
- 用户当前要求已收束为“做好前期准备，后续 Claude Code 开发”。因此尚未建立 Electron/React 生产实现、安装生产依赖或生成 .app。
- 已保存产品需求、术语、架构建议、契约、任务次序、验收，以及两个参考原型。
- `reference/design` 是 Open Design 中获认可的暗色交互设计；`reference/prototype` 是已验证真实 Git / Codex 审查流程的 Bun 浏览器原型。
- 运行记录、源仓库内容和凭据没有复制到这里。参考测试用临时 Git 仓库，不依赖 fde-study。

## 先读

1. [开发约定](../AGENTS.md) 与 [领域上下文](../CONTEXT.md)。
2. [PRD](PRD.md)、[架构](ARCHITECTURE.md)、[契约](CONTRACTS.md)。
3. [任务列表](BACKLOG.md) 与 [第一阶段实施计划](superpowers/plans/2026-10-28-first-desktop-slice.md)。
4. Agent 任务读 [接入调查](AGENT-INTEGRATION.md)；视觉任务读 [.impeccable.md](../.impeccable.md) 与 [原型说明](../reference/README.md)。

## 已验证的原型经验

- 紧凑暗色、IDEA 风格方向获用户认可；用户不能仅凭静态外观判断是否好用，所以必须持续做真实试用。
- 中文文档长行需要逐行对齐；新增文件默认单栏更合理；Diff 与全文可切换。
- 人工审查、Agent 建议、Git 暂存保持独立；Agent 不自动替人批准。
- Codex 真实调用成功；Claude 只有安装/登录确认，调用失败，详见接入调查。
- 原型最后一次报告覆盖、混合快照风险、粗糙的首尾增量算法、硬编码页面文案，都不能直接继承进正式应用。

## 用户后续开工时可直接发送

```text
请在当前 branchroom 仓库继续开发正式桌面应用。先阅读 CLAUDE.md、AGENTS.md 和 docs/HANDOFF-CLAUDE.md，再执行 docs/BACKLOG.md 的 BR-001。沿用已确认的产品方向与设计，不重新做需求访谈，也不要使用 brainstorming 技能。

先完成一个可启动、可选择真实 Git 仓库的 Electron + React + TypeScript 桌面切片，建立受限 preload、类型契约、测试和本地打包验证。保留 reference 原型供对照，不把它整体包壳当成正式应用。

关键行为先用临时 Git 仓库写测试，不修改 fde-study。完成后给出启动命令、真实验证结果、任务状态与下一步；明确哪些能力尚未实现。不要声称 Claude Code Review 已可用，那个模型/配置兼容问题仍需在 BR-004 验证解决。
```

该提示词授权 BR-001；完成后可由用户要求继续后续任务。不要因为项目有 10 项 backlog 就在这次准备阶段或一个未经授权的会话中自动实现全部范围。

## 准备阶段的现有命令

```sh
bun run check:prep
bun run test:reference
bun run prototype:design
```

真实参考原型另外设置 `BRANCHROOM_REPO` 再运行 `bun run prototype:live`，使用参考说明中的独立端口。当前没有正式 dev/build 命令；BR-001 创建后更新 README。

## 不应发生的接手错误

- 把本地 CLI 说成离线模型；混淆当前写代码的会话与客户端启动的审查 CLI。
- 为解决 Claude 报错修改用户的全局服务商/模型或要求无依据地重新登录。
- 把 fde-study 设为正式产品默认仓库，或者在其上做破坏性演示。
- 忽略 IPC、进程树与内容一致性，把 DOM 原型直接搬成唯一生产组件。
- 把取消/失败/输出无效解释成“没有问题”。
