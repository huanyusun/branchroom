# 原型参考

这些文件来自本次 Open Design 项目 `branchroom-git-review-083172d5`，归档时间 2026-10-28。它们是设计与行为参考，不是生产实现。

| 目录 | 用途 | 运行 |
| --- | --- | --- |
| design/ | IDEA 风格暗色演示、工作区/审查/历史、模拟 Agent 修复 | 根目录 `bun run prototype:design`，端口 7458 |
| prototype/ | 真实 Git 只读读取、内容审查记录、Codex/Claude 适配入口 | 设置 BRANCHROOM_REPO 后 `bun run prototype:live`，端口 7457 |

## 可以保留的经验

布局、信息密度、双栏逐行对齐、新文档单栏、Diff/全文切换、意见定位、反馈草稿、人工审查与 Agent 意见分离、内容变化复审。

## 不要直接迁移

- prototype/ 页面含 fde-study 场景文案；server 已改为显式传入仓库，尚不是正式的选择目录流程。
- HTTP API / 全局 DOM / Bun 专用 API；正式应用按 [架构](../docs/ARCHITECTURE.md) 重写。
- 原型只保留最后一个 Agent 报告，内容指纹还包含状态/patch 表示，可能因 stage 变化误失效。
- 原型逐次 git/文件读取尚不保证一致快照，也未完善 rename/未初始化 HEAD/大仓库处理。
- “相对上次审查”用首尾对齐近似，多个分散变化会扩大区间；正式版需要真正 diff。
- Agent 局部参考摘录不是事实核验；Claude 模型/配置兼容问题尚未解决。

`.review-data/` 会在运行时产生，已忽略，归档中没有包含真实运行数据。8 个参考测试只证明相应原型行为，不可替代正式产品的测试。
