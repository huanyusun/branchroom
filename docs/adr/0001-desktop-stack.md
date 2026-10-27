# ADR 0001 · 桌面技术方案

日期：2026-10-28。状态：建议方案，BR-001 开始时做一次可启动验证后确认；不是用户要求的技术栈。

## 选择

Electron + React + TypeScript。主进程负责原生窗口、仓库选择和本地服务协调；preload 暴露窄的类型化 API；renderer 负责状态和 UI。Git 使用本机 git，Agent 使用本机 CLI。重任务放入 utility process 或专属任务进程，应用不经常驻 HTTP 服务器向 renderer 暴露系统能力。

Bun 用于开发工具、参考测试，不作为产品安装后的外部先决条件。正式 Node 服务代码使用 Node 标准 API，不依赖 Bun.spawn / Bun.serve。

## 理由与代价

已有原型为 HTML/TS，Agent 适配层、进程管理和测试可以保持同一种语言。相比 Tauri + Rust，首版迁移成本较小；相比 Bun HTTP 页面，更符合独立桌面客户端的原生选择目录、进程生命周期和打包目标。代价是安装包体积、内存占用较大，需要限制渲染与进程开销。

优先支持当前 macOS 场景，模块保持跨平台。Windows 可执行文件发现、进程树终止和编码必须显式测试，不能因 API 相同就宣称已支持。

## 开工时锁定

BR-001（2026-10-28）锁定并验证的组合：Electron 45.0.0、electron-vite 6.0.0、Vite 8.3.5、@vitejs/plugin-react 6.1.2、React 19.3.1、TypeScript 5.9.3、Vitest 5.0.5、@playwright/test 1.64.1、electron-builder 26.18.0，开发环境 Node 22.22.0 + Bun 1.3.11（macOS 15 x86_64）。TypeScript 已发布 7.0（原生编译器），但生态工具链仍以 5.x 为受支持基线，故锁定 5.9，待下游确认后再升级。安装注意：Bun 默认拦截依赖的 postinstall，Electron 二进制需要 `trustedDependencies: ["electron"]` 后重新安装（或手动执行 `node node_modules/electron/install.js`）；受限网络下可用 `ELECTRON_MIRROR` 指定镜像。本文不构成对未来版本兼容性的保证。

## 官方依据

[Electron 进程隔离与 IPC 边界](https://www.electronjs.org/docs/latest/tutorial/security/)、[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)。utilityProcess 的 stdin 配置不能像普通 child_process 一样用于传入提示词：worker 经消息端口收到任务后，再用 Node spawn 启动真正 CLI，并写入该 CLI 的 stdin。
