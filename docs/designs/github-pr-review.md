# GitHub PR 只读审核设计

日期：2026-10-28。状态：设计提案，开发尚未开始。

用户已确认 GitHub PR 为首个入口，先完成只读审核；本次交付仅为设计和开发计划，不修改应用代码。对应任务 BR-011。

## 目标与边界

用户粘贴 GitHub PR 链接，或在已打开的本地仓库中输入 PR 编号，即可审查 PR 的固定版本：阅读 Diff、记录人工判断、调用本地 Claude Code / Codex、采纳为本地反馈草稿、刷新后复审变化。

首轮支持 github.com 的公开及当前账号有权读取的私有 PR，含 fork、Draft、已关闭和已合并 PR。完整链接不要求本地克隆。编号需要能从当前仓库的 GitHub remote 确定目标仓库；多个候选时让用户选择，不能猜测。Enterprise、自建平台、PR 列表搜索、远程评论同步、Approve、Request changes、合并、从反馈启动编码不在本轮范围。平台状态可展示，CI/检查详情不属于本轮，不根据 Agent 结果推断其状态。

“只读”约束用户仓库与 GitHub：应用可写 userData 下的快照、审查记录、草稿和报告；本地 Agent 仍通过已有账号调用模型服务。不会修改用户 HEAD/index/worktree/refs，不需要 fetch、checkout 或 stash，不执行 PR 内容中的脚本。

## 用户流程与交互

延续 .impeccable.md 的紧凑暗色 IDEA 风格，复用文件列表、宽 Diff、人工审查和 Agent 面板。

1. 顶栏增加「打开 GitHub PR…」，空状态也可进入。对话框含输入框「PR 链接或编号」及辅助说明「编号使用当前仓库；完整链接无需本地克隆」。未打开仓库时仅接受链接。
2. 输入支持 `https://github.com/owner/repo/pull/123`，允许常用 `/files`、`/commits` 后缀、查询参数与定位片段；编号支持 `123`、`#123`。拒绝非 https、其他域名、用户名/密码、非默认端口、非法仓库段与非正安全整数；URL 只用于解析，不直接作为 API 请求地址。
3. 对话框展示 gh 状态：可用、未安装、未登录、版本不兼容。提供选择 gh 可执行文件与重新检测入口；缺失时提示用户在终端安装/登录，不代其登录、不读取显示 token、不修改全局配置。
4. 点击「打开并读取」后按真实阶段显示「读取 PR 信息 → 获取文件列表 → 读取内容 x/y → 校验版本」。提供取消。不显示没有依据的百分比。失败保留输入，可重试。
5. 成功后进入独立 PR 审查页。已有工作区可通过「工作区 / PR #123」返回；切换前等待当前草稿落盘，失败则保留输入并提示。首次可只维护一个 PR 页，不预建无限标签系统。
6. 默认审查 PR 全部变更，文件列表支持全部、未审查、待复审、问题筛选；Agent 支持整批、所选文件、待复审集合。新增单栏，修改对齐双栏，删除显示旧侧，支持全文。
7. 点击意见定位到对应侧和行；采纳只生成该 PR 当前材料的本地草稿。人工标记旁显示「仅表示该文件比较材料已审查；关联影响需另行检查」。
8. 点击「刷新 PR」重新核对远程版本。相同版本保留当前快照；版本改变先完整构建新快照再原子替换，失败保留旧视图并标「刷新失败，仍显示上次版本」。只复审比较材料实际变化的文件。

布局示意（结构线框，不是视觉验收）：

```text
Branchroom                       [打开本地仓库…] [打开 GitHub PR…]
[工作区] [PR #123]
owner/repo  #123 修复取消逻辑     Open · Draft（若适用）
contributor:fix → owner:main      [刷新 PR] [版本详情]
审查版本 head abc123 · 已核对 14:32 · 人工已审 3/8 · Agent 覆盖 6/8
┌ 变更文件 8 ────────────┬ 取消逻辑.ts · 对比 / 全文 ────────────────┐
│ 全部 未审 待复审 问题 │ merge-base 旧侧      │ PR head 新侧        │
│ ✓ M src/a.ts    +8 -3 │ 行号与逐行对齐 Diff                         │
│ ↻ M src/b.ts    +4 -1 ├ 人工：未审查 / 已审查 / 问题 · 本地反馈草稿 │
│ ○ D src/old.ts       ├ Agent：审查全部 / 当前文件 / 待复审         │
│ ○ A image.png 不可读 │ issue / verify · 定位 · 采纳为草稿 · 历史   │
└──────────────────────┴────────────────────────────────────────────┘
```

PR 页不渲染暂存、取消暂存、提交栏和 index 标记；不能靠伪造 indexStatus 隐藏它们。状态色沿用蓝色操作、绿红增删、琥珀待复审；Open/Merged/Closed 是平台事实，与人工及 Agent 状态分开。窄窗口允许折叠文件列表和元信息，Diff 保持可读；键盘可访问打开、筛选、文件、意见和关闭操作。

「版本详情」展示目标提交 baseOid、来源提交 headOid、共同祖先 mergeBaseOid、捕获与远程核对时间；正常界面用“旧侧 / PR 新侧”，避免用当前仓库 HEAD 描述 PR。PR 合并后仍审查其记录的变更，不拿 merge commit 替代 head。

## 身份与适用性

引入 ReviewTarget（审查目标），工作区和 GitHub PR 为两种目标。Repository 继续只代表本地工作区，不把 PR 伪装成带假 root 的 Repository。

- 工作区目标身份依赖现有 repoId；PR 目标由 github.com、GitHub base repository 数字 ID、PR number 派生。标题、分支名、owner/repo 显示名称不能作为唯一身份。另记录 GitHub PR ID 校验返回对象。
- Snapshot 是一次冻结记录，有 targetId；PR 版本保留 baseOid、headOid、mergeBaseOid、双方仓库 ID/名称与分支。所有 SHA 必须校验为合法 Git OID，不能用分支名充当固定版本。
- 文件比较身份覆盖 targetId、新路径、旧路径映射、双侧的存在状态、模式和内容摘要。明确区分 absent、text（含空串）、unavailable；两个 unavailable 不证明内容等价。仅普通文本文件可标记/交给 Agent。
- 人工结论在同一目标、同一路径、双侧比较材料及模式未变时保留，即使只因目标分支前进而 baseOid 改变。rename 不迁移结论，新路径 pending；同路径有旧判断而材料改变则 recheck。跨 PR、跨工作区不继承。
- Agent 匹配使用同一目标及其实际输入材料的指纹（包含 previousPath、双侧模式、内容与 patch）。提示词不携带未进入指纹的版本相关上下文。版本变化但输入完全相同可沿用；任一输入变化即 stale。此为 PR 政策，现有工作区 HEAD 保守政策按 ADR 0002 保持。
- 人工标记与 Agent 采纳均核对 snapshot 属于 target、file 属于 snapshot，以及最新已发布快照的材料仍匹配；禁止跨目标套用 ID。PR 保存不读取本地 liveIdentity，也不要求本地 root。
- 无后台轮询：标签为「基于 head abc123；远程核对于…」，不声称实时最新。人工保存可离线写入已核对快照；刷新或发起新 Agent run 前核对远程版本。run 运行中 PR 更新不改变其冻结输入，完成后按最新快照匹配。
- 缺失目标文件不回退为 stale=false；历史意见和已移出范围文件保留为历史，只可查看。切换快照后禁止把旧稿静默重绑；显示旧版本并允许复制，直接采用要求材料匹配。

PR 快照与材料需要持久化，重启后历史报告可看到原始双侧上下文；离线可查看已缓存版本并明确“未核对远程”。默认只加载缓存摘要，打开具体 PR 时校验版本。缓存删除作为显式清理操作，保留元信息后应明确原上下文不可用。

## 数据获取方案

首轮采用本机 `gh api`，复用 gh 的认证与代理配置。主进程使用参数数组、固定 github.com 和 GET，工作目录为应用控制目录；gh 不是 renderer 提供的任意命令。配置只保存可执行路径，不复制认证文件。固定 API 版本需在实施时验证并锁定。

读取步骤：

1. 编号先只读解析当前仓库 remote 的 HTTPS/SSH GitHub 地址；不执行 remote helper，不信任仓库配置里任意主机。多个不同候选提供明确选择。
2. GET `/repos/{owner}/{repo}/pulls/{number}`，记录 ID、title、state、draft、base/head 身份、base/head SHA 和 changed_files。head 仓库已删除、对象无权限等保留元信息，无法获取材料时显示版本不可获取，不回退工作区内容。
3. 以固定 SHA 调 Compare API，取 `merge_base_commit.sha`；fork 使用官方支持的同仓库网络 owner-qualified ref 格式。Compare 的 files 字段不作为文件全集。
4. GET PR files，`per_page=100`，逐页读取，核对唯一文件数与 changed_files。官方上限 3000 文件，超过则明确拒绝构建完整快照；分页重复、计数不符、异常空页均不当作完整。API 返回 patch 不保证完整，不能直接当作完整审查材料。
5. 从 mergeBaseOid 与 headOid 对应 commit/tree 读取每个变更路径（旧侧用 previous_filename）。按目录逐层请求非递归 tree，缓存同一 SHA 的结果，检查 truncated；不使用截断的 recursive tree。通过 mode/type 区分普通 blob、符号链接与 gitlink，不走会解引用符号链接的内容路径。
6. 对普通文件按固定 blob SHA 读取完整内容，验证大小、base64 编码及 Git blob OID；利用现有 diff 库从双侧内容生成完整 patch，保留无尾换行。二进制、LFS 指针、符号链接、子模块、大文件显示具体原因，不隐式拉取 LFS 对象。mode-only 与纯 rename 无文本 patch 也必须可见。
7. 再读 PR 元信息，核对双方仓库、base/head SHA、changed_files；与开始不一致整体重试，最多 3 次。检查 files 中新侧 SHA 与固定 tree 的 blob SHA 一致。构建期间取消或校验失败不能发布半份快照。
8. 原子落盘完整快照，才更新 target 的 latestSnapshotId。标题/状态可随后独立更新，不能覆写冻结版本信息。

首轮资源预算：最多 3000 文件；每侧普通文本 1 MiB、单文件 patch 2 MiB（沿用现有上限）；单快照解码内容与 patch 合计 64 MiB；gh 单请求 30 秒、整次加载 5 分钟、并发内容请求最多 4。总量超限拒绝发布并说明限制；单文件超限可保留不可审阅条目，覆盖计数始终说明跳过。所有限额是产品设计值，需在 fixtures 和真实 PR 验收后记录调整。

取消/退出终止所属请求及后代进程，丢弃未发布快照；超时不伪装成取消。缓存只在 userData 中，以校验后的 ID/OID 为键、原子写入，权限遵循私有数据存储。日志只含请求类型、状态、计数、耗时，不写源码、完整响应或凭据；关闭 GH_DEBUG，不能把任意 stderr 直接展示给用户。

## 接口与工程落点

以下是计划契约，不表示当前 src/shared/contracts.ts 已有这些类型。

```ts
type TargetId = string;
type ReviewTarget =
  | {id: TargetId; kind: 'worktree'; repoId: string}
  | {id: TargetId; kind: 'github-pr'; host: 'github.com'; repositoryId: number;
     pullRequestId: number; owner: string; name: string; number: number};
type PullRequestVersion = {
  baseOid: string; headOid: string; mergeBaseOid: string;
  baseRepositoryId: number; headRepositoryId: number | null;
};
type ContentSide =
  | {kind: 'absent'}
  | {kind: 'text'; oid: string; mode: string; text: string}
  | {kind: 'unavailable'; oid: string | null; mode: string | null; reason: string};
```

共用 Snapshot 增加 targetId，来源以 discriminated union 表达（worktree 保留 repoId/head；github-pr 使用固定版本）；不能给 PR 填假的 repoId/head。共用文件视图可继续适配 ChangeFile 的文本字段，身份来源使用 ContentSide。ReviewRun/人工记录/草稿按 targetId 存储与排队，run 持久化包含版本/快照引用，renderer 不提交任意路径。

拟新增受限方法：

| 方法 | 输入 | 输出/作用 |
| --- | --- | --- |
| getGitHubCapability | 无 | gh 路径、版本、认证诊断，不返回 token |
| setGitHubExecutable | 原生选择对话框，无 renderer 任意路径执行 | 保存验证后的 gh 路径并重新检测 |
| resolvePullRequest | reference、可选已登记 repoId | 规范化链接或 remote 候选；仅解析，不写仓库 |
| startPullRequestLoad | 规范化 reference 或已登记 targetId | operationId，开始可取消加载 |
| onPullRequestLoad | 监听器 | operationId、真实阶段/计数、成功快照引用或错误 |
| cancelPullRequestLoad | operationId | 只取消本次加载 |
| getPullRequestLoad | operationId | 查询阶段及终态，弥补监听竞态 |
| listReviewTargets / getTargetSnapshot | 无 / targetId | 最近目标 / 缓存冻结快照 |

现有 saveReview/saveDraft/listReviewEntries/clearDraft/startReview/listRuns 改为 targetId 范围；stage/unstage/commit 仍只接收已登记本地 repoId。旧接口可由主进程内部兼容适配，但不能允许 renderer 选择任意存储键。load 终态需可查询，避免事件订阅竞态；结果模型沿用 Result。并发刷新按 target 排他，跨目标并发有界；主进程校验操作归属与 sender。

存储 v2 迁移将旧工作区数据映射至确定性 worktree targetId，保留备份，重复启动幂等；历史 run 和草稿一起迁移，旧 snapshot 未持久化的报告显式说明原上下文不可用。迁移失败不覆盖旧文件，保留只读查看与明确错误。不能仅改目录名便宣称完成迁移。

现有实现需特别修改：

| 现有位置 | 必要变化 |
| --- | --- |
| review-service.ts / SnapshotRegistry | target 归属校验、最新快照按目标、PR 保存不走 liveIdentity；缺失文件不默认为仍适用 |
| review-store.ts | 分离 absent/空文本/unknown，目标隔离与原子迁移，按目标串行写入防丢草稿 |
| review-runs.ts | 去掉 PR 对本地 root 的依赖，按 target 排队，保留固定输入与 skipped 范围 |
| agents/report.ts / profiles.ts | schema/prompt/校验同时支持 base/current；旧报告保留 current；删除文件不得假造新侧定位 |
| Workspace.tsx / FileList.tsx / DiffView.tsx | 按 target 渲染，显式写能力开关，意见定位包含 side；新 PR 元信息及版本区 |
| App.tsx / preload / ipc | 独立 PR 入口、加载取消、最近目标、受限 API 与严格输入校验 |

Agent 必须显示「覆盖 6/8，2 项不可审阅」，完整覆盖指本次显式可审阅输入，不是整个 PR 自动通过；不可审阅项单列 skipped。意见只覆盖自身输入材料，不证明关联影响、CI 或测试已验证。

## 错误与恢复

| 情形 | 展示与恢复 |
| --- | --- |
| gh 缺失/不兼容 | 安装或选择路径、重新检测；不阻塞工作区模式 |
| 未认证/401 | 提示在终端执行 gh auth login，再重试 |
| 404 | “PR 不存在或当前账号无访问权限”，不能断言一定不存在 |
| 403/429 | 区分权限与限流；可取得重置时间时显示，禁止无界自动重试 |
| 网络错误/超时 | 独立错误类别，保留已有快照；显示未核对远程 |
| 版本变化 | 最多三次重建，仍变化则提示稍后刷新 |
| 缺 blob/tree 截断/计数不符 | 不能发布完整快照；显示材料不可获取或不完整 |
| 用户取消 | 返回原页面，不显示“零变更/未发现问题” |
| Agent 失败/覆盖不足 | 沿用 failed/invalid_report 等语义，保留历史 |

## 验收门槛

- 输入 URL 无本地克隆也能进入；编号需明确仓库归属；fork SHA 与目标分支前进的三点比较正确。
- 实际读取期间无 checkout/stash/fetch/add/commit/push，临时仓库的 HEAD、index、status、refs、文件内容前后相同。
- 多页文件、中文/空格路径、rename、删除、空文件、mode-only、二进制、符号链接、子模块、LFS、超限均有明确状态。
- 刷新后仅输入变化的人工比较待复审；两个 PR 与工作区状态隔离；未知材料不当相同。
- Agent 旧/新侧定位、草稿、历史固定上下文、取消和退出清理可验证；刷新中旧 run 不混入新快照。
- 真实 Electron 检查打开、加载取消、阅读、人工标记、Agent 意见定位、采纳草稿、刷新、重启与错误恢复；所有测试数据使用 fixture/临时仓库。
- 真实 GitHub 验证另记公开 PR、私有/fork 读取与限流诊断；真实 Agent 调用与 fake CLI 证据分开，不以 fixture 代称真实服务已验证。

## 技术依据

GitHub [Compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits) 支持同网络跨仓库比较，files 最多 300；[PR files API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files) 分页且最多 3000。因此只用 Compare 解析共同祖先，独立核对 PR 文件全集。

[Git trees API](https://docs.github.com/en/rest/git/trees#get-a-tree) 提供对象 mode/type 及 truncated；[Git blobs API](https://docs.github.com/en/rest/git/blobs#get-a-blob) 提供按对象读取材料的接口。[gh api](https://cli.github.com/manual/gh_api) 支持显式 GET 与 hostname；[gh 环境变量](https://cli.github.com/manual/gh_help_environment) 的主机和调试行为需纳入适配测试。
