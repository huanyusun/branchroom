# 首个桌面切片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 执行方式服从用户指示。本轮仅准备；用户后续要求 Claude Code 开工时，默认当前会话逐项执行 BR-001，不为执行方式再开一轮确认，也不默认启用多个实现代理。

**Goal:** 交付可启动、原生选择仓库并展示真实仓库身份的独立桌面工程，为后续真实 Diff 与 Agent 审查建立边界。

**Architecture:** Electron main 协调 Git/仓库与生命周期；preload 只暴露 docs/CONTRACTS.md 中的窄 API；React renderer 展示界面。Git 和进程逻辑使用 Node 标准 API，Bun 仅为开发工具。

**Tech Stack:** 建议 Electron、React、TypeScript、electron-vite、Vitest、Playwright Electron 测试。开工时用受支持的组合锁定实际版本。

## Global Constraints

- 独立桌面 Git 客户端；IDEA 风格暗色方向已确认。
- 不使用 brainstorming 技能，不重新发起产品需求访谈。
- 仅 BR-001 是本计划的实现范围；BR-002 至 BR-010 见 docs/BACKLOG.md，不能一起宣称完成。
- 不修改被审查仓库进行测试；只用临时 Git 仓库。
- contextIsolation=true、nodeIntegration=false、sandbox=true；无任意 renderer shell/readFile API。
- 正式运行时不要求外部 Bun；不能硬编码开发者路径、fde-study 或固定端口。
- 现有参考原型保持可运行；不要搬入 .review-data 或认证配置。
- Node.js 开发基线 >=22.22.0；当前准备脚本使用 Bun >=1.3.11。

## 任务 1：锁定正式工程与可启动窗口

**Files:** 创建 electron.vite.config.ts、tsconfig.json、src/main/index.ts、src/preload/index.ts、src/renderer/index.html、src/renderer/main.tsx、src/renderer/App.tsx、src/renderer/styles/app.css、src/shared/contracts.ts；修改 package.json、README.md、AGENTS.md。

**Interfaces:** 使用 CONTRACTS.md 的 Result、Repository、BranchroomAPI 名称。BR-001 只暴露 chooseRepository、listRepositories；其余方法暂不暴露或有显式 capability，不返回伪造结果。

- [ ] 核对当前 Electron/构建工具支持范围；选择兼容 Node 基线的版本，用 `--exact` 安装并提交 lockfile。

```sh
bun add --exact react react-dom
bun add -d --exact electron electron-vite vite @vitejs/plugin-react typescript @types/node @types/react @types/react-dom vitest @playwright/test electron-builder
```

如果注册表版本不兼容 Node 基线，应选受支持组合并记录，而不是关闭引擎检查。

- [ ] 在 package scripts 加入下列真实入口，保留参考命令：

```json
{
  "dev": "electron-vite dev",
  "build": "electron-vite build",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:e2e": "playwright test",
  "package:mac": "bun run build && electron-builder --mac --dir"
}
```

- [ ] Vitest 仅发现 `tests/**/*.test.ts`，排除 `reference/**` 的 Bun 专用测试；参考测试继续由 `test:reference` 单独运行。
- [ ] 创建独立 main/preload/renderer 入口，BrowserWindow 显式使用上述隔离配置；用本地自定义协议加载打包页面，开发服务器只在开发模式使用。
- [ ] renderer 实现暗色的仓库空状态和“打开本地仓库”按钮；不先画假的文件、测试通过状态或 Agent 结果。
- [ ] 运行 build/typecheck 并实际打开窗口；验证无 renderer Node 能力。先完成窗口启动，再接真实 Git。

## 任务 2：真实仓库身份与原生目录选择

**Files:** 创建 src/main/services/repositories.ts、src/main/ipc/handlers.ts、src/shared/schemas.ts、tests/integration/repositories.test.ts；修改 preload、App。

**Interfaces:** `openRepository(root: string): Promise<Repository>`；`chooseRepository(): Promise<Result<Repository | null>>`；`listRepositories(): Promise<Result<Repository[]>>`。只登记经系统选择的根路径，以 repo ID 供后续调用。

- [ ] 先写并运行下列临时 Git 仓库测试，观察未实现导致的失败：

```ts
import { beforeEach, afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { openRepository } from '../../src/main/services/repositories';
const exec = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'branchroom-中文 仓库-'));
  await exec('git', ['init', '-q', root]);
});
afterEach(async () => { await rm(root, {recursive: true, force: true}); });
test('opens a repository without an initial commit', async () => {
  const repo = await openRepository(root);
  expect(repo.head).toBeNull();
  expect(repo.root).toContain('branchroom-中文 仓库-');
  expect(repo.gitDir).not.toBe('');
  expect(repo.id).not.toBe('');
});
test('rejects a non-Git directory', async () => {
  const other = await mkdtemp(join(tmpdir(), 'branchroom-not-git-'));
  try { await expect(openRepository(other)).rejects.toThrow(); }
  finally { await rm(other, {recursive: true, force: true}); }
});
```

- [ ] 使用 `execFile('git', args, {cwd})`、真实路径及 Git 的 git-dir/common-dir 命令识别；无 HEAD 是合法情况，其他命令失败不得吞成空仓库。
- [ ] 补充 linked worktree 与 detached HEAD fixture，断言工作区 ID 不同、commonGitDir 可相同。fixture 在临时目录，必要 Git 作者信息只用单次 `git -c`，不改全局配置。
- [ ] 主进程原生目录选择：取消返回 ok/null；非 Git 给出可理解错误；有效仓库显示真实名称、路径、分支/分离状态、HEAD/尚无提交。
- [ ] preload 只用 `contextBridge.exposeInMainWorld` 暴露具体方法，不暴露 ipcRenderer 或原始 invoke。handler 做 sender 与参数校验。
- [ ] 保存最近仓库列表到 app userData；检查已删除路径并给出重新打开/移除入口。

## 任务 3：桌面验证与本地打包

**Files:** 创建 playwright.config.ts、tests/e2e/open-repository.spec.ts；修改构建配置、README.md；更新 docs/adr/0001-desktop-stack.md 与 docs/BACKLOG.md 的证据。

**Interfaces:** e2e 用正式 main 入口启动 Electron；测试中替换系统目录对话框返回临时路径，不向生产 renderer 增加测试后门。

- [ ] e2e 验证启动空状态、取消选择不报错、打开有效仓库显示身份、非 Git 目录错误、中文路径显示、renderer 无 require/process 系统入口。
- [ ] 实际执行并记录：

```sh
bun run typecheck
bun run test
bun run test:e2e
bun run build
bun run package:mac
bun run check:prep
bun run test:reference
```

- [ ] 从生成的本地 .app 启动一次，验证能打开仓库、关闭、重开。未签名/公证可以明确标为本地开发构建，不进行分发。
- [ ] 把已创建的 dev/build/test 命令、依赖版本与实际验证写入 README/AGENTS；确认 BR-001 完成，再把 BR-002 从 backlog 推为 ready。
- [ ] 完成一轮代码审查，修复重要问题；输出真实完成项、产物路径和限制。BR-001 不包含 Diff、Agent Review 或 Git 写操作，不能将参考原型能力算作正式实现。

## 后续切片的进入条件

BR-002：依照 BACKLOG、CONTRACTS 建立一致快照和 Diff；先搬测试意图而不是复制 Bun 服务。
BR-003：人工记录与草稿，用内容身份取代原型的 status/patch 身份。
BR-004：独立 Agent 适配器与配置诊断，先解决 Claude 的已知失败；保留 run 历史。
BR-005：连接意见、反馈、外部修复与增量复审，运行 ACCEPTANCE 的三轮真实试用。

本计划到 BR-001 为止具备开工与验收定义。后续任务开始时按其已记录范围细化实现步骤，不在当前准备轮引入未经验证的大量代码。
