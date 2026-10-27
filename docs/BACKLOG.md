# 本地开发任务

跟踪方式：本文件，不创建远程 issue。正式应用目前尚无实现；仅 BR-001 为 ready。完成任务后补上提交、测试证据与剩余限制，再推进下一项。不要把计划勾选当作实现证据。

| ID | 状态 | 类型 | 交付 | 依赖 |
| --- | --- | --- | --- | --- |
| BR-001 | ready | architecture | Electron + React + TS 工程、原生选仓库、受限 preload、基础测试与打包启动验证 | 无 |
| BR-002 | backlog | feature | Git 服务、一致性快照、真实文件列表、双栏/单栏 Diff 与全文 | BR-001 |
| BR-003 | backlog | feature | 持久化人工审查/草稿、内容变化复审、仓库与 worktree 隔离 | BR-002 |
| BR-004 | backlog | feature | Codex/Claude 适配、配置兼容诊断、任务生命周期、校验报告与历史 | BR-002 |
| BR-005 | backlog | design | Agent 意见定位/采纳、修复反馈、复审闭环与三轮真实试用 | BR-003、BR-004 |
| BR-006 | backlog | feature | 显式暂存/取消暂存、提交预览与文件级提交 | BR-005 |
| BR-007 | backlog | feature | 分支/提交图/详情/筛选联动与分支基础操作 | BR-006 |
| BR-008 | backlog | feature | Fetch/Pull/Push 与状态恢复、merge/rebase 中断与冲突处理 | BR-007 |
| BR-009 | backlog | feature | 意图分组、组级/hunk 审查、增量审查优化 | BR-005 |
| BR-010 | backlog | feature | worktree 任务、Agent 编码会话、从反馈启动修复 | BR-005 |

## BR-001 · 首个交付

范围：把正式桌面工程启动起来；原生打开目录后验证 Git 仓库身份，展示名称、路径、分支、HEAD 与明确失败状态。建立类型化 bridge、测试入口与本地打包脚本。

验收：macOS 实际启动；选中有效仓库能显示身份；取消无报错；非 Git 目录不被接受；中文/空格路径正常；renderer 无任意系统调用入口。依赖被锁定，正式 dev/build/typecheck/test 命令写入 README。不是把 HTML 包进窗口就宣称整个客户端完成。

## BR-002 · 真实变更阅读

范围：HEAD/worktree、未跟踪、暂存/未暂存、删除、rename、冲突与未创建 HEAD。保留旧路径；不支持阅读的项要显示原因，不能消失。

验收：临时仓库 fixture 覆盖上述状态；内容与 patch 同一快照；中文长行对齐；新增文件不浪费左半屏；有版本变化时重试而不是生成混合快照。

## BR-003 · 人的审查状态

验收：重启恢复；两仓库与两个 worktree 不串状态；只 stage/unstage 不误判过期；内容变化后受影响文件待复审；保存旧 fingerprint 被拒绝且草稿保留；超长反馈明确报错而非截断。

## BR-004 · Agent Review

验收：CLI 缺失/认证/模型配置失败分开；Codex/Claude 不破坏用户 provider 配置；取消清理整棵进程树；输出路径/side/行号/覆盖合法；记录多次报告；真调用与假 CLI 自动化测试分别记录，不能用 UI 演示替代。

Claude 模型问题的调查步骤详见 AGENT-INTEGRATION.md。它是待解决的真实兼容性问题，不是已修复事项。

## BR-005 · 可用性验证

验收：意见一击定位；issue/verify 区分；采纳仅产生草稿；旧版本意见提示并阻止直接应用；修复后刷新只复审变化；代码/文档/混合变更三轮试用。根据 ACCEPTANCE.md 记录阻碍，而不是只评价“看起来不错”。

## 后续任务的控制点

BR-006 起才开放 Git 写操作。界面必须让用户知道目标是 worktree、index 还是远程分支。高风险操作不得顺手混入 review runner。每项按独立需求细化后实施；首个切片不预造全量复杂 Git 状态机。
