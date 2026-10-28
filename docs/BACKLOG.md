# 本地开发任务

跟踪方式：本文件，不创建远程 issue。完成任务后补上提交、测试证据与剩余限制，再推进下一项。不要把计划勾选当作实现证据。独立审计记录见 docs/PROJECT-ISSUES.md。

| ID | 状态 | 类型 | 交付 | 依赖 |
| --- | --- | --- | --- | --- |
| BR-001 | done | architecture | Electron + React + TS 工程、原生选仓库、受限 preload、基础测试与打包启动验证 | 无 |
| BR-002 | done | feature | Git 服务、一致性快照、真实文件列表、双栏/单栏 Diff 与全文 | BR-001 |
| BR-003 | done | feature | 持久化人工审查/草稿、内容变化复审、仓库与 worktree 隔离 | BR-002 |
| BR-004 | done | feature | Codex/Claude 适配、配置兼容诊断、任务生命周期、校验报告与历史 | BR-002 |
| BR-005 | in-progress | design | Agent 意见定位/采纳、修复反馈、复审闭环与三轮真实试用 | BR-003、BR-004 |
| BR-006 | done | feature | 显式暂存/取消暂存、提交预览与文件级提交 | BR-005 |
| BR-007 | ready | feature | 分支/提交图/详情/筛选联动与分支基础操作 | BR-006 |
| BR-008 | backlog | feature | Fetch/Pull/Push 与状态恢复、merge/rebase 中断与冲突处理 | BR-007 |
| BR-009 | backlog | feature | 意图分组、组级/hunk 审查、增量审查优化 | BR-005 |
| BR-010 | backlog | feature | worktree 任务、Agent 编码会话、从反馈启动修复 | BR-005 |
| BR-011 | backlog | feature | PR 独立审查入口、固定版本 Diff、人工与 Agent 审核及更新复审；平台与远程回写范围待确定 | BR-003、BR-004 |

## BR-011 · PR 审核（新增要求，尚未实现）

用户已要求支持 PR 审核。需求与验收边界见 [PRD 的 PR 审核章节](PRD.md#pr-审核新增产品要求2026-10-28)。平台、入口及远程评论/批准范围确定后细化实施计划；不依赖 BR-008 的通用 fetch/pull/push 全部完成。

实现重点：引入独立审查范围及版本身份；从固定版本构建 PR 快照；复用 Diff、人工状态与 Agent Review；保存核验依据 PR 版本而非磁盘工作区；隔离 PR 与工作区记录；PR 模式下不显示工作区暂存/提交操作。先写关键行为失败测试，再实现服务、受限 IPC 与界面，并完成真实 Electron 检查。

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

## BR-003 · 人的审查状态（done，2026-10-28）

验收：重启恢复；两仓库与两个 worktree 不串状态；只 stage/unstage 不误判过期；内容变化后受影响文件待复审；保存旧 fingerprint 被拒绝且草稿保留；超长反馈明确报错而非截断。

实际证据（2026-10-28）：

- `bun run test` 88/88：审查存储读写/损坏备份/原子写；身份只绑定基线+当前内容（stage/unstage 不变）；重试落定新 HEAD；标记后内容变化派生 recheck 而不改写历史；保存旧 fingerprint 被拒（content_changed）且草稿保留；超长反馈报 note_too_large 不截断；主仓库与 linked worktree 记录互不可见。
- `bun run test:e2e` 12/12：标记已审查+反馈重启后恢复；草稿防抖自动保存、重启恢复；标记后磁盘再变化 → 刷新显示 ↻ 待复审，过期保存被拒且提示 content_changed；linked worktree 打开为未审查；renderer 无任意系统调用入口（bridge 扩至 10 个类型化方法）。
- 结论保存前主进程双重核对：快照登记表指纹 + 磁盘实时身份（git status 单路径 + blob/磁盘内容），与快照生成规则一致。

同一轮修复了 docs/PROJECT-ISSUES.md 的独立审计发现（CHECK-01..11），证据见该文件文末附录；CHECK-12 的文档矛盾已同步。

已知限制与后续补齐点：

- 反馈草稿的防抖自动保存按文件为粒度；切换文件前未满延时的输入以最后一次落盘为准。
- 大 Diff 的对齐计算预算按行数阈值跳过（明确提示），worker 化与虚拟化在 BR-009 细化。
- Agent Review 仍未实现；"采纳意见产生反馈草稿"属 BR-005。

## BR-004 · Agent Review（done，2026-10-28）

验收：CLI 缺失/认证/模型配置失败分开；Codex/Claude 不破坏用户 provider 配置；取消清理整棵进程树；输出路径/side/行号/覆盖合法；记录多次报告；真调用与假 CLI 自动化测试分别记录，不能用 UI 演示替代。

实际证据（2026-10-28）：

- `bun run test` 119/119（新增 31）：报告校验（coverage 完整性/行号越界/枚举/重复意见/非对象输入）、runner（成功/非零/超时/输出上限/取消杀整树含孙进程/ENOENT）、能力检测（missing/available/incompatible）、RunManager（queued→succeeded、run_busy、cancelled、agent_auth_required 与 agent_incompatible 分类、agent_timeout、agent_missing、unknown snapshot → content_changed、崩溃遗留 run → interrupted、历史保留）。
- `bun run test:e2e` 14/14：假 CLI 经产品级 settings（显式可执行路径）注入，UI 全流程——能力芯片、发起审查、意见列表、点击定位到文件、历史 run、进行中停止 → cancelled。renderer 桥扩至 14 个类型化方法，仍无任意系统调用入口。
- 真实 CLI 验证（`bun scripts/real-agent-check.ts`，手动运行、元数据不含代码内容）：codex succeeded 27 秒 2 条 P2；claude succeeded 228 秒 2 条 P2，双方均真实发现 fixture 埋的缺陷。Claude 兼容问题定位为原型 `--setting-sources ''` 清空用户配置所致；正式适配器保留配置并用 `--restricted`，详见 AGENT-INTEGRATION.md。
- 生命周期：退出前 `cancelAllActive()` 终止全部 CLI 进程树；run 逐状态原子落盘，重启遗留 running → interrupted 不自动重跑。

已知限制与后续补齐点：

- 显式 CLI 路径目前经 userData/agent-settings.json 配置，GUI 选择入口与 BR-005 可用性验证一起做。
- Agent 面板意见点击定位到文件（Diff 视图），行内滚动定位与"采纳为草稿"属 BR-005。
- 超时默认 8 分钟常量；倒计时显示与可配置化留到可用性轮。

## BR-005 · 可用性验证（in-progress：机制已完成，待三轮真实试用）

验收：意见一击定位；issue/verify 区分；采纳仅产生草稿；旧版本意见提示并阻止直接应用；修复后刷新只复审变化；代码/文档/混合变更三轮试用。根据 ACCEPTANCE.md 记录阻碍，而不是只评价“看起来不错”。

机制部分证据（2026-10-28）：

- 一击定位：单击意见即打开对应文件并滚动高亮到目标行（e2e 断言 `.focus-line` 行包含预期内容）。
- issue/verify 区分：列表徽标 + 详情中的类型说明（issue=输入可证明 / verify=需外部依据）。
- 采纳仅产生草稿：意见详情「采纳为反馈草稿」组装影响/依据/建议为草稿并绑定当前内容身份；e2e 断言仓库工作区无新增改动、ReviewPanel 收到草稿。
- 旧版本意见：内容变化后列表标「旧」，详情显示拦截横幅且采纳禁用。
- 只复审变化：复审按钮按 recheck 文件集合发起；e2e 覆盖 标记→外部修改→刷新→待复审→复审→新意见可采纳 的闭环。
- 试用步骤已写入 docs/ACCEPTANCE.md「当前可执行的试用步骤」。

待完成：三轮真实试用（A 中文文档/B 代码修复/C 混合批量）需要用户选择真实仓库并按每轮记录反馈主观负担与卡点；完成后本任务才能置 done。

## BR-006 · 暂存与提交（done，2026-10-28）

验收要点：界面必须让用户知道目标是 worktree、index 还是本地分支；无推送/远程操作；高风险操作不混入 review runner。

实际证据（2026-10-28）：

- `bun run test` 128/128（新增 9）：stage/unstage 显式路径（中文/空格/子目录）、unstage 不动工作区、commitStaged 只提交索引、commitFiles 只提交所选路径的工作区内容（未跟踪文件先入索引）、提交预览、空信息/未暂存/路径越界拒绝且无副作用。
- `bun run test:e2e` 18/18（新增 2）：UI 暂存 → 提交预览（将提交 N 个文件 + 增删统计）→ 提交已暂存 → `git log` 真实可查、未提交文件保留、快照自动刷新；文件级提交只含所选文件；空提交信息禁用按钮。
- 安全边界：写操作仅由显式按钮触发（暂存/取消暂存/提交），按钮文案明确目标（索引/当前分支），无 push/reset/force；review runner 不含任何 Git 写操作；提交身份用用户自己的 Git 配置，缺失时给出可操作错误而非伪造。

已知限制：文件级提交会把未跟踪的所选文件先加入索引（IDEA 同语义）；无 hunk 级暂存（后续任务）；无提交历史浏览（BR-007）。

## 后续任务的控制点

Git 写操作已按 BR-006 范围开放（暂存/取消暂存/提交），仍无推送与远程操作。界面文案明确目标是索引还是当前分支；高风险操作不得顺手混入 review runner。每项按独立需求细化后实施；不预造全量复杂 Git 状态机。
