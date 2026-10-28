# 本地 Agent 接入调查与实现要求

## 已验证事实（2026-10-28，BR-004 完成时更新）

- 本机 codex exec（0.164.0）与 claude --print（2.1.302）均存在，auth status 均已登录。
- **Claude 兼容问题已定位并解决**：原型失败的根因方向是 `--setting-sources ''` 清空了用户 settings，导致 Z.AI provider/model 配置未被继承。正式适配器保留用户全部配置，改用 `--restricted` 移除执行类工具；`unrecognized_model: glm-5.3-flash[1m]` 只是 stderr 上的本地诊断警告，不阻塞执行（envelope `is_error:false`、structured_output 正常返回）。未修改用户全局配置。
- 真实审查验证（临时 fixture 仓库，`bun scripts/real-agent-check.ts`，元数据不含代码内容）：
  - codex：succeeded，27 秒，1 文件，2 条 P2 issue，真实发现 fixture 埋的两个缺陷（重试循环被超时中断、timer 未清理）。
  - claude：succeeded，228 秒，1 文件，2 条 P2 issue，发现同样两个缺陷。
- 正式适配器 argv：codex 沿用原型验证过的只读组合；claude 为 `--print --output-format json --json-schema … --permission-mode dontAsk --no-session-persistence --restricted --settings {"disableAllHooks":true}`。
- 假 CLI 自动化测试覆盖慢响应/退出非零/超时/输出上限/取消/进程树清理；真实账号测试由上述脚本单独标记运行，不进入默认测试命令。

不在本仓库保存 settings、token、完整环境、CLI 会话和真实审查结果。

## 正式适配器策略

1. 用户选择现有 CLI，应用负责能力检测与可执行文件路径；不自动安装或改变其全局配置。
2. 分别处理认证/服务地址/模型映射与执行工具权限。不能通过清空全部用户配置实现只读模式。
3. 设置允许 CLI 保持其已有 provider/auth/model 配置的启动方式；工具与工作区权限单独限制。CLI 不支持的 flags 返回兼容性诊断，不猜开关。
4. 捕获固定快照，在应用控制目录发起审查；提示词通过 stdin，而不是可能出现在 ps 或 shell 历史中的长参数。
5. 明确输入覆盖：基线与当前内容、Diff、合法文件身份与行号、实际读取到的参考；不声称读过未提供的网页/PDF/Notion。
6. 文档 Review 与代码 Review 有共同输出结构，但提示目标不同。没有课程原文时将需确认的事实列为 verify；减少重复的“都要核对”泛化意见。
7. structured output 只是第一层；语义校验用 CONTRACTS.md 的约束。空报告要有成功执行与完整覆盖证据。
8. 记录可安全展示的 executable/version/model label/provider host/退出码/错误类别；不要记录凭据或原始完整环境。

## Claude 兼容性调查：BR-004 的必做步骤

先重现用户日常 CLI 的**非交互只读最小调用**，确认同一 provider、认证来源和模型映射。仅做诊断，不自动编辑 ~/.claude。

- 对比普通 CLI 与原型的 argv、cwd、selected env（只看变量名，模型名与 host 允许显示；密钥只显示是否存在）。
- 分清本地 unrecognized_model 诊断、CLI 最终退出、provider HTTP 错误；不能只取最后一条 stderr 判断根因。
- 若需测试不带 [1m] 的模型名，将其作为**单次进程覆盖**并记录理由，不改全局设置，不擅自切换服务商。
- 确认自定义 provider 的结构化输出支持。若无原生 schema flag 能力，用 JSON 文本协议 + 严格本地校验 + 最多一次纠正重试；不得默默转用其他提供者。
- GUI 启动时缺少 shell PATH/env 要明确诊断。允许用户选 CLI 路径；不要运行不受控 login-shell 配置来搜集凭据。

## 生命周期与成本

单仓库一次 run；任务可排队、可停止、可重试。8 分钟超时为原型经验值，正式默认可配置并给出倒计时/已用时。每条输出属于固定进程和 run；输出过量只终止所属进程。

取消/关闭应用等待并清理自己创建的进程树。测试用可控的本地假 CLI 验证慢响应、stderr、退出非零、半个 JSON、超长输出和派生子进程。真实账号测试另行标记，不进入默认 CI。

## 原型到正式版的迁移点

原型只有最后一次报告、Bun 进程 API 和局部参考摘录；正式版不能照搬。接入层返回 ReviewRun、AgentReport 与结构化错误，不返回 HTML 或直接操纵 UI。

[Codex 官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)支持 exec、只读执行和结构化输出。具体参数仍以当前已安装 CLI 的 --help 和能力检测为准，不能把本机版本假定为所有机器版本。
