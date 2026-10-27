@AGENTS.md

Claude Code 首先阅读 docs/HANDOFF-CLAUDE.md。用户在准备完成后明确要求开工时，执行 BR-001，不要重新做一轮需求访谈。

原型的 Claude CLI 接入未验证通过：本机 Z.AI / opus 映射调用出现 glm-5.3-flash[1m] 无法识别，且原型禁用了用户 settings。不要误报为登录失败或已确认服务端不支持；详见 docs/AGENT-INTEGRATION.md。
