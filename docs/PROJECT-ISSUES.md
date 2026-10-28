# 项目问题检查记录

检查日期：2026-10-28。基于提交 `57b23b8`，范围为正式应用 `src/`、测试、构建配置与开发文档；参考原型仅运行已有测试，不作为生产实现审计。此次只记录，不修复功能，不调整 BACKLOG 状态。所有复现写入均发生在系统临时 Git 仓库，未修改用户仓库。

严重程度：P1 为影响变更完整性、仓库归属或整份快照可用性；P2 为局部错误、可靠性或验证缺口；P3 为文档与显示细节。编号 CHECK-* 仅用于本报告定位，不占用 BR-* 产品任务号。

## 检查结果概览

| 编号 | 优先级 | 问题 | 证据状态 |
| --- | --- | --- | --- |
| CHECK-01 | P1 | 一致性校验漏掉新变更、路径集合与 index 变化 | 临时仓库复现 |
| CHECK-02 | P1 | 暂存删除后重建同名文件产生重复 ID 与错误 patch | 临时仓库复现 |
| CHECK-03 | P1 | 已提交子模块变更导致整份快照失败 | 临时仓库复现 |
| CHECK-04 | P2 | 最近仓库并发写入丢记录并抛 ENOENT | 临时目录复现 |
| CHECK-05 | P2 | 最近仓库存储 schema 校验过浅 | 构造文件复现 |
| CHECK-06 | P2 | Git 引号路径无法关联 patch | 临时仓库复现 |
| CHECK-07 | P1 | 切换仓库后，旧请求可覆盖新仓库快照 | 静态代码确认，待桌面延迟复现 |
| CHECK-08 | P2 | Diff 行数限制在完整同步计算之后才生效 | 静态代码确认，待性能测量 |
| CHECK-09 | P2 | Diff 超限错误码被包装后丢失 | 静态错误链确认，未构造 64 MiB 输出 |
| CHECK-10 | P3 | 行数统计及 patch 统计不准确 | 部分动态复现、部分静态确认 |
| CHECK-11 | P2 | 打包测试可跳过或测试旧产物 | 静态测试流程确认 |
| CHECK-12 | P2 | 开发阶段及接手文档互相矛盾 | 文档与代码对照确认 |

## CHECK-01 · 快照一致性不能覆盖完整变更集合

位置：[snapshots.ts](../src/main/services/snapshots.ts#L94)，以及同文件第 271–290 行。

校验仅保存首次 status 中已有路径的 mtime/size，最终核对 HEAD 与这些路径；没有重新核对 status、index 或内容摘要。初始干净仓库的 stamps 为空，即使捕获期间产生修改，仍会直接成功。缺失路径重新出现、原本干净文件变脏、新增未跟踪文件也不在核对范围内。mtime/size 本身不能证明内容相同。

复现：临时仓库提交 `f=old\n`，调用 `buildSnapshot(repo, {hooks: {beforeVerify: async () => { /* 把 f 改为 new\n，同时新建 new */ }}})`。实际返回 `files.length === 0`，随后真实 Git status 为 ` M f` 与 `?? new`，没有触发重试。

影响：报告所称“期间任何变化整体重试”不成立；在后续 Agent Review 使用前必须建立可靠的内容一致性边界。此复现直接证明漏检，尚未人为控制进程时序来演示 patch 与正文混合的具体返回值。

建议：冻结并核对路径集合、HEAD、相关 index 状态及内容摘要；固定基线对象，确保 patch 由同一份冻结内容生成或经过内容核验。回归至少覆盖捕获期间新增、删除恢复、原干净文件变化、仅 index 变化、同大小内容替换。

## CHECK-02 · 暂存删除后重建同名文件，重复条目携带矛盾内容

位置：[snapshots.ts](../src/main/services/snapshots.ts#L130)、第 216、241 行；[FileList.tsx](../src/renderer/features/changes/FileList.tsx#L37)。

复现：临时仓库提交 `f=old\n` → `git rm f` → 在工作区重新写入 `f=new\n` → 构建快照。

实际结果：返回两个 `path/id` 均为 `f` 的条目，一个 deleted、一个 added；added 条目正文为 `new\n`，却复用了删除 `old\n` 的 patch。UI 使用 `file.id` 作为 React key、用 path 选择，再以 `find` 取首项，因而两项无法被可靠区分，新增内容可能无法选中。

建议：按“HEAD 到当前工作区”的范围合并同路径记录，暂存状态单独保留；每个快照内确保文件 ID 唯一，patch 与实际 base/current 一致。回归应断言新正文可选中且 patch 方向正确。

## CHECK-03 · 子模块不受支持时使整个工作区不可阅读

位置：[git.ts](../src/main/services/git.ts#L125) 中三处 `fields[2] === 'S'`；[snapshots.ts](../src/main/services/snapshots.ts#L153)。

复现：临时父仓库记录 gitlink，在临时子仓库创建新提交，使父仓库 status 的子模块字段为 `SC..`。调用快照后抛出 `SnapshotError: git cat-file blob <commit> 失败`。

根因有两处：porcelain v2 子模块字段为 `S...`，不是单字符 `S`；并且即使修好识别，代码也在处理子模块之前把 HEAD gitlink 指向的 commit 当作 blob 读取。

影响：存在一个变化的子模块即可阻止其他普通文件显示，与 README 声称“子模块显示明确原因，不会消失”不符。

建议：保留 mode/对象类型，先识别 gitlink 并生成不可审阅条目，再跳过 blob 读取；测试子模块新增、指针变化、工作区脏与删除。

## CHECK-04 · 最近仓库读改写没有串行化

位置：[recent-store.ts](../src/main/services/recent-store.ts#L61)。

复现：对同一个 store 同时调用 `Promise.allSettled([store.add(repoA), store.add(repoB)])`。本次结果为一次成功、一次 `ENOENT`（rename 固定 `.tmp` 文件失败），最终只保留一个 ID。

根因：两次操作独立 load，写相同临时路径，再 rename；原子 rename 只能保护单次替换，不能保护完整读改写事务。并发 add/remove 同样存在覆盖风险。

建议：在 store 内串行执行完整读改写；临时文件使用唯一名称，并测试并发新增、删除及失败恢复。仅更换临时文件名仍会丢更新。

## CHECK-05 · 损坏的最近仓库记录通过 schema 校验

位置：[recent-store.ts](../src/main/services/recent-store.ts#L27)；[handlers.ts](../src/main/ipc/handlers.ts#L130)。

复现：写入 `{"schemaVersion":1,"entries":[{"repository":{},"lastOpenedAt":"bad"}]}`，`store.list()` 原样返回，无备份也无拒绝。

根因：只检查 repository 是对象、时间是字符串，不检查 root/id/name 等必需字段及字段类型。后续读取 `record.repository.root` 并传入路径解析，可能使整个最近列表接口返回 internal_error。

另有静态发现：load 捕获所有 readFile 错误并返回空数组，无法区分文件不存在与权限/I/O 失败，后续保存可能掩盖原有记录；备份失败也会打印“已备份”。

建议：完整验证持久化字段；只对 ENOENT 视为空存储，其余错误明确返回；备份日志反映真实结果。测试缺字段、错误类型、非法时间与读取失败。

## CHECK-06 · Tab 等被 Git 引用的文件名丢失 patch

位置：[git.ts](../src/main/services/git.ts#L205) 的 `splitPatchByFile`。

复现：提交名为 `tab\tname` 的文本文件后修改内容。快照中 path 正确、base/current 存在，但 `patch === null`，且 `reviewable === true`。

根因：即使 `core.quotePath=false`，Git 仍会对 Tab/换行/引号等路径进行 C 风格引用；解析器只认识不带引号的 `+++ b/`，没有解码引用路径。默认 Diff 前缀也没有显式固定，用户配置可能进一步影响匹配（此配置分支未动态复现）。

影响：patch 与统计缺失，后续消费 patch 的审查流程会拿到不完整材料。当前 UI 通过 base/current 计算对齐，不能因此推断界面正文完全消失。

建议：采用可靠的 Git patch 路径解析，或以 NUL 分隔的元数据建立文件映射；固定需要依赖的 diff 输出选项。测试 Tab、换行、引号、反斜杠及重命名路径。

## CHECK-07 · 快照请求没有仓库归属或请求序号保护

位置：[Workspace.tsx](../src/renderer/features/changes/Workspace.tsx#L31)，[App.tsx](../src/renderer/App.tsx#L137) 附近的 Workspace 渲染。

证据类型：静态确认异步竞态，未执行桌面延迟注入复现。

触发：仓库 A 的 getSnapshot 较慢，此时打开仓库 B。Workspace 无按仓库 key 重建，effect 也没有 cleanup 或请求序号；B 请求完成后，A 仍能调用同一组 setState。初始读取期间刷新按钮也可用，允许多个读取并发。

影响：标题可能显示 B，文件与 Diff 却属于 A；同仓库旧刷新也可能覆盖新刷新。

建议：请求完成时验证当前 repoId 与请求版本；effect 失效时忽略结果。增加可控 Promise 返回顺序的组件测试和真实窗口切仓库测试。

## CHECK-08 · 大 Diff 渲染上限不能限制计算成本

位置：[DiffView.tsx](../src/renderer/features/changes/DiffView.tsx#L102)、第 155 行；[diff.ts](../src/renderer/lib/diff.ts#L21)。

证据类型：静态确认；本轮未做耗时/内存压测，不给出未经测量的卡顿时长。

`useMemo` 在 renderer 主线程同步调用 `diffArrays`，生成全部对齐行后才 slice 到 4000 行。1 MiB 内容限制仍允许很多短行且差异很大的文本；渲染上限无法约束 diff 算法、对象分配和消息传输成本。计算也不检查 reviewable，超出 patch 上限但保留正文的文件仍可能执行完整对齐。

建议：计算前建立行数/工作量预算；worker 中计算并支持取消或时限，超限显示明确未覆盖原因；再按需求加入窗口化渲染。补充高差异、多短行的性能基线。

## CHECK-09 · diff_too_large 分支无法识别实际缓冲区溢出

位置：[git.ts](../src/main/services/git.ts#L63)、第 44 行；[snapshots.ts](../src/main/services/snapshots.ts#L116)。

证据类型：静态错误链确认，未生成 64 MiB 以上 Diff。

runGit 已将 execFile 的 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 包为 `RepositoryError(code='git_failed', cause=原错误)`；调用方检查的却是外层 error.code。因此溢出不会走 diff_too_large，而会返回 repository_unavailable，丢失真正的限制和补救说明。

建议：保留/映射资源上限错误码，或读取受控 cause；对缓冲区上限设置可注入的小值来验证真实错误链，避免测试创建巨型文件。

## CHECK-10 · 行数与增删统计存在边界错误

位置：[diff.ts](../src/renderer/lib/diff.ts#L80)、第 90 行；[DiffView.tsx](../src/renderer/features/changes/DiffView.tsx#L11)。

动态复现：未跟踪文件内容为 `x\n`，fileChangeStats 返回 `+2/-0`，实际只有一行。末尾换行通过 split 产生的空字符串也会被渲染成额外行。

静态确认的另一分支：统计代码跳过所有 `+++`、`---` 开头的行，而合法 hunk 内容可能为 `+++literal`（新增正文以 `++` 开头），这会被误当成文件头。

建议：统一保留换行语义的行拆分；仅在 hunk 范围统计增删，区分文件头和正文。测试末尾有/无换行、空文件、以多个 +/- 开头的正文与 CRLF。

## CHECK-11 · 打包验证可能验证旧产物或悄悄跳过

位置：[packaged-app.spec.ts](../tests/e2e/packaged-app.spec.ts#L12)，[global-setup.ts](../tests/e2e/global-setup.ts#L5)。

global setup 仅 build 到 out，不重新 package；测试只判断 dist 中二进制是否存在。干净 checkout 会 skip；已有 dist 时可测试旧代码。本轮 9/9 包含一次真实打包应用启动，但不能据此声称当前提交已重新打包验证，且该测试没有覆盖 BR-002 Diff。

建议：拆分普通桌面测试与必须先打包的发布验证命令；发布验证禁止缺包时跳过，并记录构建提交/资源版本。文档证据区应区分 out 构建和 dist 应用。

## CHECK-12 · 阶段文档与实际代码状态矛盾

位置：[HANDOFF-CLAUDE.md](HANDOFF-CLAUDE.md#L6)、第 29、46 行；[BACKLOG.md](BACKLOG.md#L3)；[AGENTS.md](../AGENTS.md#L3)；[ARCHITECTURE.md](ARCHITECTURE.md#L3)。

接手文档仍称没有 Electron/React 实现、没有 dev/build 命令并要求从 BR-001 开始；BACKLOG 开头称“尚无实现、仅 BR-001 ready”，但紧接的表格标 BR-001/002 done、BR-003 ready；架构标题也仍称尚未创建实现。README 已更新到 BR-002，形成互相矛盾的事实来源。

README 关于“一致快照绝不混合”“子模块只显示不可审阅原因”的绝对表述又被 CHECK-01/03 的实际行为否定。

建议：同步事实状态、接手起点与命令，保留未经授权不推进后续任务的边界；完成关键回归前，把相关能力描述调整为真实限制。

## 已执行验证与边界

| 检查 | 本轮真实结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run test` | 5 个文件，46/46 通过 |
| `bun run check:prep` | 通过，25 个必需文件及本地文档链接/命令检查 |
| `bun run test:e2e` | 9/9 通过，含 Electron 真实窗口及已有 dist 应用启动；global setup 构建通过 |
| `bun run test:reference` | 8/8 通过，24 次断言 |
| 临时仓库/目录补充探针 | 确认 CHECK-01/02/03/04/05/06，以及 CHECK-10 的末尾换行统计问题 |

已有测试全部通过不表示上述边界行为正确。此次未运行新的 package:mac，未执行真实 Agent 调用、签名/公证复验、依赖漏洞数据库扫描或完整可访问性审计；没有把这些未检查项写成已确认缺陷。BR-003 起尚未实现的产品能力属于既有计划，不重复计为 bug。

建议处理顺序：先 CHECK-01/02/03/07 保证内容与仓库归属，再 CHECK-04/05 确保存储可靠，随后处理解析、性能和验证缺口；文档同步可独立进行。修复时按 AGENTS.md 先写关键行为失败测试。

---

## 修复状态附录（2026-10-28，基于本轮开发）

按审计建议顺序修复 CHECK-01/02/03/07（内容完整性与仓库归属）、CHECK-04/05（存储可靠性）、CHECK-06/09/10（解析与统计）、CHECK-08（计算预算）、CHECK-11（打包验证）与 CHECK-12（文档同步）。每项先写失败测试再修复；修复后全套 `bun run typecheck`、`bun run test`（88/88）、`bun run test:e2e`（12/12，含重新打包后的 .app 真实启动）通过。

| 编号 | 状态 | 修复方式与证据 |
| --- | --- | --- |
| CHECK-01 | 已修复 | 快照核对改为 HEAD + 捕获期 status 原文深度比较：路径集合、XY、blob 哈希、子模块字段任一变化即整体重试。回归覆盖干净仓库中途变脏、捕获期新增未跟踪文件、仅 index 变化、被删路径重现（tests/integration/snapshot-integrity.test.ts）。 |
| CHECK-02 | 已修复 | 同路径多记录按"HEAD→工作区"净效果合并为单一条目（id 唯一）；合并路径的 patch 置空（整树 diff 无法表达中间态），统计回退内容行数。回归断言暂存删除+重建得到单条 modified、base=old、current=new。 |
| CHECK-03 | 已修复 | 子模块识别改为 S 前缀匹配；识别后在读取任何 blob 之前短路为不可审阅条目（原因含"子模块"），普通文件不受影响。回归覆盖指针变化与仅工作区弄脏两种情况。 |
| CHECK-04 | 已修复 | recent-store 全部读改写经内部串行队列，临时文件唯一命名。回归覆盖并发三条 add 与 add+remove 交错。 |
| CHECK-05 | 已修复 | 最近仓库条目深度校验（id/name/root/gitDir/commonGitDir 非空字符串、branch/head 类型、时间可解析）；load 仅把 ENOENT 视为空存储，其余错误向上抛；备份失败如实记录。回归覆盖缺字段、错误类型与 EISDIR。 |
| CHECK-06 | 已修复 | splitPatchByFile 解码 Git C 风格引用路径（含 \t \n 八进制 UTF-8），引用路径的 a//b/ 前缀在引号内、解码后剥离。回归：`tab<TAB>名字.md` 的 patch 正常关联（tests/integration/git-snapshot.test.ts）。 |
| CHECK-07 | 已修复 | Workspace 使用请求序号守卫（renderer/lib/latest-guard.ts，单元测试覆盖），effect 清理时失效进行中请求；App 以 repository.id 为 key 重建工作区。 |
| CHECK-08 | 部分修复 | 对齐前先做行数预算（单侧 > 20000 行不做同步对齐，显示明确提示与全文入口）；非可审阅文件不做对齐。worker 化与逐块窗口化仍属后续（记入 BR-009 范围），未声称已完全解决。 |
| CHECK-09 | 已修复 | runGit 支持 overflowCode：ERR_CHILD_PROCESS_STDIO_MAXBUFFER 映射为 diff_too_large 专属错误码，不再被吞成 git_failed。回归用 maxBuffer=16 的小仓库 diff 验证真实错误链，不构造 64 MiB 数据。 |
| CHECK-10 | 已修复 | 统一 splitContentLines（结尾单个换行不产生幻影行）；patch 统计改为 hunk 范围状态机，正文以 +/- 开头不再误判为文件头。单元回归覆盖空内容、有无结尾换行、`++正文`、`\ No newline` 行。 |
| CHECK-11 | 已修复 | 新增 `bun run verify:packaged`：先重新 package:mac 再以 BRANCHROOM_REQUIRED_PACKAGED=1 强制运行打包测试，产物缺失直接失败不跳过；`test:e2e` 保持对 out/ 构建的桌面流程验证。 |
| CHECK-12 | 已修复 | HANDOFF/BACKLOG/ARCHITECTURE/AGENTS/README 同步至真实阶段；README 中"绝不返回混合快照""子模块不消失"的表述在 CHECK-01/03 修复并补充回归后成立，并已在 README 能力边界注明实现方式。 |

说明：BR-003（人工审查持久化/草稿/复审/worktree 隔离）在本轮审计修复之上完成，其验收证据见 docs/BACKLOG.md 的 BR-003 小节。审计中"未运行 package:mac、未做性能压测"等边界项，本轮以 verify:packaged 补上打包验证；worker 化性能优化仍按计划后置。
