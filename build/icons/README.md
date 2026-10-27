# Branchroom 应用图标

设计：深石墨色圆角底板，蓝色 Git 分支结合房间 / 门框轮廓。保持与应用暗色 UI 一致，不用勾选符号表示自动审查通过。

- `icon.png`：生成的方形 PNG 主资源，外部透明。
- `icon.icns`：macOS 应用图标，含 16–1024 px 表示，由系统 `sips` / `iconutil` 导出。
- `icon.iconset/`：用于重建 ICNS 的各尺寸 PNG。
- `prompt.txt`：完整生成提示词；使用内置 image_gen 工具生成。

打包配置位于 `electron-builder.yml` 的 `mac.icon`。重新执行 `bun run package:mac` 后，新应用包使用此图标。
