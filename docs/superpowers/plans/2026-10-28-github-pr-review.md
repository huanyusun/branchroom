# GitHub PR 只读审核开发计划

> **For agentic workers:** 使用 executing-plans 按任务执行；是否使用子代理服从用户当轮指示。本次仅产出计划，未授权实施应用代码。步骤使用复选框记录执行证据，不能提前勾选。

**Goal:** 无需切换本地分支即可打开 github.com PR，完成固定版本 Diff、人工与本地 Agent 审核、更新复审及历史查看。

**Architecture:** 引入独立 ReviewTarget，工作区与 PR 共用快照阅读和审查服务，Git 写服务继续只接受本地仓库。主进程通过 gh 的 GET API 获取元信息、共同祖先、分页文件、固定 tree/blob，发布完整冻结快照；按目标存储审查记录与历史。

**Tech Stack:** 现有 Electron / React / TypeScript / diff / Vitest / Playwright；新增外部依赖为用户本机 GitHub CLI，不新增认证 SDK。

**设计依据:** [GitHub PR 只读审核设计](../../designs/github-pr-review.md)。以下是开发顺序，不表示应用已实现，也不把设计提案自动视为已验收的领域规则。

## 全局约束

- 仅 github.com 只读；无远程评论、Approve、Request changes、合并或自动编码。
- 不改用户仓库、全局 Agent/gh 配置；API 参数数组、固定主机与 GET，不拼 shell。
- 不改 reference/；不拷贝真实内容、凭据、会话或 CLI 输出到源码。
- 用户当前已有未提交改动，实施前重新确认 git diff 范围，不能覆盖或顺手提交。
- 每项先写关键失败测试并实际运行，再实现；临时 Git 仓库及合成响应为自动化数据源。
- 未覆盖、取消、失败、过期、未知与“未发现问题”分别表达。
- 沿用 Node ≥22.22.0、Bun ≥1.3.11 和现有锁定依赖；无需升级工具链。
- 3000 文件、单侧文本 1 MiB、单文件 patch 2 MiB、快照总量 64 MiB、4 路内容并发、请求 30 秒、加载 5 分钟、最多 3 次版本一致性尝试。

## 依赖与交付顺序

T1 目标身份与迁移 → T2 GitHub 解析/只读传输 → T3 固定快照 → T4 人工审查适配 → T5 Agent 与双侧定位 → T6 桌面完整流程 → T7 验收及文档。

T1–T5 为内部可测试交付，T6 才形成用户可用的 PR 审核；BR-011 在 T7 完成前保持 in-progress，不因后端测试通过置 done。无需等待 BR-007/008 全部完成；实施优先级由下一次开发指令确定，不在本次启动。

## T1：独立目标、内容状态与持久化兼容

**文件：**修改 src/shared/contracts.ts、src/shared/schemas.ts、src/main/services/review-store.ts、review-service.ts、review-runs.ts；新增 src/main/services/review-targets.ts、review-migrations.ts；测试 tests/unit/review-targets.test.ts、tests/integration/review-migrations.test.ts，并扩展 review-store/review-flow/run-manager 现有测试。

**接口：**目标注册表提供 remember(target)、get(targetId)、worktreeTarget(repoId)；采用设计文档的 ReviewTarget、PullRequestVersion、ContentSide；Snapshot/ReviewRun 持有 targetId。review-store 按 targetId 寻址，快照注册表提供 snapshotOf(id)、latestFor(targetId) 并校验归属。旧 repoId API 在 handler 内适配到工作区目标。

- [ ] 写失败测试：两个 worktree、两个 PR 同路径不共享记录；同一 PR 改标题/仓库更名不改 ID；absent 与空文件摘要不同，unavailable 不可推导相等；将其他目标 snapshotId 用于保存被拒。
- [ ] 写迁移 fixture：旧 state.json、草稿、run；重复迁移结果一致，损坏文件/写入失败不覆盖旧数据；旧 run 无原快照明确无上下文。
- [ ] 运行 `bun run test -- tests/unit/review-targets.test.ts tests/integration/review-migrations.test.ts`，记录预期失败，再实现目标与 schemaVersion=2 原子迁移。
- [ ] 实现按目标写入串行队列，并以同时保存两文件草稿验证不会丢失任一记录。
- [ ] 运行上述测试及 `bun run typecheck`，再跑完整 `bun run test`，确保工作区行为无回退；检查差异后形成独立提交，不能包含他人改动。

**门槛：**目标不依赖本地 root，现有工作区记录/草稿/run 可恢复；不预建全局通用事件溯源系统。

## T2：PR 入口解析与 gh 只读适配

**文件：**新增 src/main/github/reference.ts、client.ts、capabilities.ts；新增 src/main/services/github-settings.ts；修改 shared/schemas.ts；测试 tests/unit/github-reference.test.ts、tests/integration/github-client.test.ts；假 CLI fixture 在 tests/fixtures/github/，仅含合成材料。

**接口：**parsePullRequestReference(reference, candidates) 返回规范化 owner/repo/number 或明确候选；GitHubClient.get(endpoint, {signal}) 返回 unknown，经专用 schema 校验后使用；getGitHubCapability 返回不含凭据的诊断。客户端不暴露 method/host/任意 URL 给 renderer。

- [ ] 写 URL/编号失败测试：普通链接及 files/commits/片段、#编号、HTTPS/SSH remote；无仓库、歧义、恶意主机、userinfo、端口、0/负数/超大编号、编码分隔符等拒绝。
- [ ] 写假 gh 集成测试：记录 argv，断言只有 api + 固定 host + GET；测试 ENOENT、401、404、限流、非 JSON、输出溢出、超时、取消杀后代。用哨兵凭据断言日志与 Result 无泄露。
- [ ] 运行 `bun run test -- tests/unit/github-reference.test.ts tests/integration/github-client.test.ts` 观察失败；实现最小解析、能力检测和有界客户端。
- [ ] 以 `gh --help` / `gh api --help` 能力检测确定所需 flags，不写死本机版本号；提供产品级可执行路径设置，测试无需生产后门。
- [ ] 重跑上述测试和 typecheck；记录客户端 GET 边界与诊断证据，独立提交。

**门槛：**只解析/只读传输可验证；404 文案为“不存在或无权限”，没有未经授权的 gh 登录或配置修改。

## T3：完整固定 PR 快照与加载生命周期

**文件：**新增 src/main/github/schemas.ts、objects.ts，src/main/services/pull-request-snapshots.ts、pull-request-loads.ts、snapshot-store.ts；扩展 shared/contracts.ts；测试 tests/integration/pull-request-snapshot.test.ts、pull-request-loads.test.ts，tests/unit/github-schemas.test.ts。

**接口：**loadPullRequestSnapshot(reference, signal, onProgress) 产生目标、PR 元信息、固定版本快照；SnapshotStore.publish(snapshot) 原子保存再更新 latest；LoadManager.start/cancel/get/onUpdate 使用 operationId，终态可查询。返回材料只能来自固定 tree/blob。

- [ ] 用合成提交图构造失败测试：main 从共同祖先前进，PR 独立前进，旧侧必须取共同祖先；fork 使用各自固定仓库/提交，拒绝混入本地磁盘内容。
- [ ] 写分页测试：101 文件、300/301 文件、3000/3001 边界、重复页/计数不足；Compare files 截断不影响文件全集，PR files 不能静默截断。
- [ ] 写对象测试：中文/空格、新增空文件、删除空文件、rename、mode-only、符号链接/gitlink/LFS、二进制、大 blob、缺对象、无尾换行、无 patch、OID 不符、tree truncated。
- [ ] 写一致性和生命周期测试：读取间 head/base 变化重建；持续变化三次失败；取消不发布；旧快照在刷新失败时保留；退出清理请求；超总量明确失败。
- [ ] 运行 `bun run test -- tests/integration/pull-request-snapshot.test.ts tests/integration/pull-request-loads.test.ts tests/unit/github-schemas.test.ts` 记录失败；按设计的八步读取顺序实现。
- [ ] 用临时本地仓库记录 HEAD、status、index 摘要、refs、磁盘摘要，完成加载后逐项相同；客户端进程记录中不得出现 fetch/checkout/stash/add/commit/push。
- [ ] 重跑测试与 typecheck；独立提交并记录资源预算行为。

**门槛：**只有完整一致快照可以成为 latest；无法证明全集时不能展示完整审查进度。

## T4：PR 人工审查、保存核验与刷新适用性

**文件：**修改 review-service.ts、review-store.ts、review-targets.ts、snapshot-store.ts；新增 src/main/services/review-applicability.ts；扩展 tests/integration/review-flow.test.ts，新增 tests/unit/pr-applicability.test.ts。

**接口：**saveReview/saveDraft 接收 targetId/snapshotId/fileId/expectedFingerprint；核对归属与目标最新材料。工作区保持 liveIdentity 核验；PR 使用冻结材料与最近已发布快照，不访问本地路径。评估返回 applicable/stale/unknown，而非缺证据时 false。

- [ ] 写失败测试：无本地 root 可保存 PR；错误目标拒绝；本地脏文件不影响 PR；刷新后改变材料拒绝旧保存并保留草稿；未改变材料保留判断。
- [ ] 覆盖 baseOid 变化但双侧相同、merge-base 内容改变、rename 不迁移、旧文件移出 PR、未知材料、两个 PR 隔离、离线保存已知版本。
- [ ] 运行 `bun run test -- tests/unit/pr-applicability.test.ts tests/integration/review-flow.test.ts` 观察失败，再实现目标分派与匹配；不把工作区 ADR 0002 偷换成 PR 政策。
- [ ] 重跑上述测试与所有 review-store 测试；检查重启恢复与历史上下文，独立提交。

**门槛：**状态按材料派生、不改写历史；旧草稿不会绑定到新内容。

## T5：Agent 复用、双侧定位与准确覆盖

**文件：**修改 agents/report.ts、profiles.ts、services/review-runs.ts；修改 renderer/features/agent-review/AgentPanel.tsx、changes/DiffView.tsx；扩展 tests/unit/agent-report.test.ts、tests/integration/run-manager.test.ts、tests/e2e/finding-flow.spec.ts。

**接口：**Agent schema 增加 side=base/current，payload 提供 base_numbered/current_numbered；校验对应侧行数。旧持久化报告缺 side 只按旧版本 current 迁移，新输出必须显式给出 side；onSelectFile(path, {side, line}) 贯穿 Diff。run 持有 requested/covered/skipped 与固定 snapshotId，不再依赖 PR 的本地仓库 root。

- [ ] 写失败测试：删除文件意见可定位 base；新侧不存在时 current 意见被拒；越界/错 path/重复/漏覆盖仍拒绝；旧 current 报告可读。
- [ ] 测试整批含二进制：显示可审覆盖和 skipped，不宣称整个 PR 无问题；测试取消、退出、旧 run 完成时新快照已发布、同材料保留与变化材料 stale。
- [ ] 运行 `bun run test -- tests/unit/agent-report.test.ts tests/integration/run-manager.test.ts` 观察失败，再同步修改 schema、prompt、校验、输入指纹与 UI。
- [ ] 跑上述测试及 `bun run test:e2e -- tests/e2e/finding-flow.spec.ts`；实际检查删除侧滚动高亮、草稿来源版本，独立提交。

**门槛：**issue/verify、采纳只生成草稿、历史逐次保留等既有约束继续成立；不假造测试执行结论。

## T6：桌面入口、可取消加载与完整审查页

**文件：**新增 renderer/features/pull-requests/OpenPullRequestDialog.tsx、PullRequestHeader.tsx；修改 App.tsx、changes/Workspace.tsx、FileList.tsx、ReviewPanel.tsx、styles/app.css；修改 main/ipc/handlers.ts、preload/index.ts、main/index.ts、shared/schemas.ts；新增 tests/e2e/pull-request.spec.ts 并更新 bridge 白名单断言。

**接口：**实现设计文档所列 GitHub capability、resolve、load/cancel/get、target list/snapshot 方法；Review API 按 target；写 API 仍只接受已登记本地 repoId。Workspace 接收 ReviewTarget+显示模型，而非假 Repository。

- [ ] 先写真实 Electron 失败场景：空状态 URL 进入、仓库内编号选择、gh 不可用、慢加载取消、404/限流；renderer 使用产品 gh 路径设置接入假 CLI，不添加测试环境后门。
- [ ] 再写完整闭环：打开 PR → Diff → 人工标记 → Agent 意见 → 旧侧定位 → 采纳草稿 → PR 更新 → 刷新 → 待复审 → 重启查看历史。
- [ ] 断言 PR 页不存在暂存/取消暂存/提交/index 图标；尝试把 targetId 传给写 IPC 被拒，临时仓库状态不变；非法 sender 与任意 endpoint 输入拒绝。
- [ ] 运行 `bun run test:e2e -- tests/e2e/pull-request.spec.ts`，记录功能缺失的失败；实现布局、状态机与受限 bridge。loading 订阅先于启动，卸载使回调失效；切换前等待草稿落盘。
- [ ] 在真实 Electron 窗口检查宽/窄布局、键盘焦点、长标题/路径、错误与旧版本横幅；截图留作验收证据，不能用线框代替。
- [ ] 重跑该 e2e、typecheck、完整 test；独立提交。

**门槛：**这是第一个用户可用版本；取消/失败不清空已有审查，工作区模式继续可用。

## T7：全量验证、真实读取与交接

**文件：**更新 README.md、docs/PRD.md、ARCHITECTURE.md、CONTRACTS.md、AGENT-INTEGRATION.md、ACCEPTANCE.md、BACKLOG.md、HANDOFF-CLAUDE.md；领域模型变动按 ONTOLOGY.md 维护约定同步能力问题和案例；必要时新增 ADR 记录 PR 匹配政策。

- [ ] 执行 `bun run typecheck`、`bun run test`、`bun run test:e2e`、`bun run build`、`bun run package:mac`；使用 `bun run verify:packaged` 验证实际 .app 启动。先确认当前并行改动后再定位失败，不能覆盖其他工作。
- [ ] 真实 GitHub 读取至少覆盖公开 PR 和 fork/私有可访问 PR；无相应账号权限时写明未验证，不能用 fixture 冒充。只读取，不发表任何远程内容。
- [ ] 真实 Agent 验证使用临时仓库或合成材料。若需向模型提交真实私有 PR 内容，遵循用户对该材料的实际授权，不能把“验证”视为任意使用私有代码的许可。
- [ ] 验收矩阵逐项记录命令、结果、截图/证据位置、真实调用与模拟边界、资源限制；完成全部要求才更新 BR-011 done。残留缺项必须列出，不能用总测试数掩盖。
- [ ] 文档审查确认范围、类型、API、迁移版本、错误码一致；`git diff --check`；独立提交，仅包含本任务文件。

## 关键测试样例

以下是行为断言示例，实施时接入各任务定义的 fixture builder；不是当前已存在的测试接口，也不是可直接复制运行的完整测试文件。

```ts
// T3：共同祖先到 PR head，而非目标分支 tip 或工作区。
expect(snapshot.version).toEqual({baseOid: B, headOid: H, mergeBaseOid: A,
  baseRepositoryId: 101, headRepositoryId: 202});
expect(snapshot.files.find(f => f.path === 'a.ts')?.baseContent).toBe(contentAtA);
expect(snapshot.files.find(f => f.path === 'a.ts')?.currentContent).toBe(contentAtH);
expect(afterRepositoryState).toEqual(beforeRepositoryState);

// T4：无证据不等于匹配；空文件不等于不存在。
expect(assess(missingCurrentMaterial)).toBe('unknown');
expect(identity(absent, text(''))).not.toBe(identity(text(''), text('')));

// T5：删除侧定位，严格按侧校验。
expect(report.findings[0]).toMatchObject({side: 'base', startLine: 3});
expect(() => validate(currentSideFindingForDeletedFile)).toThrow();
```

## 计划自审与当前证据

本次已核对现有源码的工作区 root 依赖、磁盘保存核验、按 repoId 存储/排队、current-only Agent schema、FileList 强制暂存入口等接入点；设计分别在 T1/T4/T5/T6 安排改造。API 截断、fork、对象模式、分页与一致性在 T2/T3；历史与迁移在 T1/T3/T4；UI 与真实验证在 T6/T7。

本次仅做文档链接、内容与差异检查，不运行应用功能测试，不声明任何 PR 功能已可用。下一次明确要求开发时按本计划执行，无需重新确认已选定的 GitHub 只读方向。
