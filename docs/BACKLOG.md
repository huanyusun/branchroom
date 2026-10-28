# 本地开发任务

跟踪方式：本文件，不创建远程 issue。正式应用目前尚无实现；仅 BR-001 为 ready。完成任务后补上提交、测试证据与剩余限制，再推进下一项。不要把计划勾选当作实现证据。

| ID | 状态 | 类型 | 交付 | 依赖 |
| --- | --- | --- | --- | --- |
| BR-001 | done | architecture | Electron + React + TS 工程、原生选仓库、受限 preload、基础测试与打包启动验证 | 无 |
| BR-002 | done | feature | Git 服务、一致性快照、真实文件列表、双栏/单栏 Diff 与全文 | BR-001 |
| BR-003 | ready | feature | 持久化人工审查/草稿、内容变化复审、仓库与 worktree 隔离 | BR-002 |
| BR-004 | backlog | feature | Codex/Claude 适配、配置兼容诊断、任务生命周期、校验报告与历史 | BR-002 |
| BR-005 | backlog | design | Agent 意见定位/采纳、修复反馈、复审闭环与三轮真实试用 | BR-003、BR-004 |
| BR-006 | backlog | feature | 显式暂存/取消暂存、提交预览与文件级提交 | BR-005 |
| BR-007 | backlog | feature | 分支/提交图/详情/筛选联动与分支基础操作 | BR-006 |
| BR-008 | backlog | feature | Fetch/Pull/Push 与状态恢复、merge/rebase 中断与冲突处理 | BR-007 |
| BR-009 | backlog | feature | 意图分组、组级/hunk 审查、增量审查优化 | BR-005 |
| BR-010 | backlog | feature | worktree 任务、Agent 编码会话、从反馈启动修复 | BR-005 |

## BR-001 · 首个交付（done，2026-10-28）

范围：把正式桌面工程启动起来；原生打开目录后验证 Git 仓库身份，展示名称、路径、分支、HEAD 与明确失败状态。建立类型化 bridge、测试入口与本地打包脚本。

验收：macOS 实际启动；选中有效仓库能显示身份；取消无报错；非 Git 目录不被接受；中文/空格路径正常；renderer 无任意系统调用入口。依赖被锁定，正式 dev/build/typecheck/test 命令写入 README。不是把 HTML 包进窗口就宣称整个客户端完成。

实际证据（2026-10-28，macOS 15.8.1 x86_64，Node 22.22.0 + Bun 1.3.11）：

- `bun run typecheck` 通过；`bun run test` 13/13（临时 Git 仓库 fixture：未创建 HEAD、分离 HEAD、linked worktree 同 common dir 不同 id、裸仓库拒绝、中文+空格路径、不存在路径）。
- `bun run test:e2e` 7/7：暗色空状态、取消选择无报错、有效仓库显示真实身份并可从最近列表重开、非 Git 目录显示 `not_git_repository` 且不入列表、已删除路径标记“路径已失效”且可移除、renderer 无 `require/process/ipcRenderer` 且仅暴露 5 个类型化方法、打包 .app 真实启动（打开仓库 → 关闭 → 重开且最近列表保留）。
- `bun run package:mac` 产出 `dist/mac/Branchroom.app`（本机开发者证书签名、未公证，仅本地开发构建）；打包验证由 `tests/e2e/packaged-app.spec.ts` 驱动。
- 界面做了真实截图检查（空状态 + 已打开仓库两种状态）。

已知限制与后续补齐点：

- 已补充 Branchroom 应用图标（`build/icons/`），配置 `mac.icon`；打包内 ICNS 与源资源 SHA-256 一致。仍未做公证，不能直接分发。
- 最近列表展示时逐条重跑 Git 校验，条目多时会有可感知延迟；BR-003 引入持久状态时应改为带失效检测的缓存。
- `listRepositories` 每次调用都会重新解析 Git 身份，返回的是当时快照而非缓存。
- BR-001 不包含 Diff、审查状态、Agent Review、Git 写操作；参考原型中的这些能力不算正式实现。
- Bun 默认拦截 Electron postinstall，需要 `trustedDependencies`（已配置）；受限网络下载 Electron 二进制可用 `ELECTRON_MIRROR`，过程记录见 ADR 0001。

## BR-002 · 真实变更阅读（done，2026-10-28）

范围：HEAD/worktree、未跟踪、暂存/未暂存、删除、rename、冲突与未创建 HEAD。保留旧路径；不支持阅读的项要显示原因，不能消失。

验收：临时仓库 fixture 覆盖上述状态；内容与 patch 同一快照；中文长行对齐；新增文件不浪费左半屏；有版本变化时重试而不是生成混合快照。

实际证据（2026-10-28）：

- `bun run test` 46/46：porcelain v2 -z 解析（rename/unmerged/中文空格路径/子模块）、行对齐配对（modify/add/del/计数）、快照 fixture 覆盖修改/未跟踪/删除/重命名（含纯重命名）/合并冲突/二进制/符号链接/超大文件/未创建 HEAD/暂存与工作区混合；指纹在 stage/unstage 间不变；HEAD 中途移动 → 重试并落在新 HEAD；持续移动 → `snapshot_changed` 而非混合快照。
- `bun run test:e2e` 9/9：文件列表四类变更（含必须显示的二进制）、新增文件默认单栏、对齐双栏出现修改对、删除单栏、二进制显示原因、对比/全文切换、磁盘再修改后刷新可见、干净仓库空状态；打包 .app 重新构建后真实启动通过。
- UI 截图实际检查：工作区头部身份摘要、快照时间、增删统计；长中文行换行后左右两栏逐行对齐（共享行高）。

已知限制与后续补齐点：

- 大 Diff 采用渲染上限（对齐 4000 行/全文 20000 行）并明确显示未覆盖范围，完整虚拟化（BR-009 或按需提前）。
- 快照为手动刷新；文件监视与去抖属 PRD 后续条目。
- 冲突文件显示工作区全文（含冲突标记），不做三栏合并视图；属 BR-008 冲突处理范围。
- worktree 目录内的仓库已按 worktree 根登记，但 BR-003 之前审查记录还没有持久化隔离可言。

## BR-003 · 人的审查状态

验收：重启恢复；两仓库与两个 worktree 不串状态；只 stage/unstage 不误判过期；内容变化后受影响文件待复审；保存旧 fingerprint 被拒绝且草稿保留；超长反馈明确报错而非截断。

## BR-004 · Agent Review

验收：CLI 缺失/认证/模型配置失败分开；Codex/Claude 不破坏用户 provider 配置；取消清理整棵进程树；输出路径/side/行号/覆盖合法；记录多次报告；真调用与假 CLI 自动化测试分别记录，不能用 UI 演示替代。

Claude 模型问题的调查步骤详见 AGENT-INTEGRATION.md。它是待解决的真实兼容性问题，不是已修复事项。

## BR-005 · 可用性验证

验收：意见一击定位；issue/verify 区分；采纳仅产生草稿；旧版本意见提示并阻止直接应用；修复后刷新只复审变化；代码/文档/混合变更三轮试用。根据 ACCEPTANCE.md 记录阻碍，而不是只评价“看起来不错”。

## 后续任务的控制点

BR-006 起才开放 Git 写操作。界面必须让用户知道目标是 worktree、index 还是远程分支。高风险操作不得顺手混入 review runner。每项按独立需求细化后实施；首个切片不预造全量复杂 Git 状态机。
