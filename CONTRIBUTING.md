# Contributing to Scattered

[简体中文](#简体中文)

Thanks for helping Scattered stay small, calm, and useful. Focused bug fixes and improvements are welcome.

## Before you start

- Open an issue before proposing a new feature or changing an established interaction.
- Keep pull requests focused on one problem.
- If an interaction changes, consider Pencil + touch, touch only, and keyboard + mouse together.

## Design constraints

- Prefer direct manipulation and visual controls over instructions or persistent text.
- Keep the interface minimal, but preserve meaningful accessible names for icon-only controls.
- Keep boards local-first. Note text, connections, and exported files must not leave the browser unless the user explicitly enables a feature that requires it.
- Reuse the existing browser platform and vanilla JavaScript before adding a dependency or build step.

## Develop and test

You need a recent Node.js release and Python 3.

```sh
npm start
```

Open `http://localhost:4173`, then run:

```sh
npm test
```

Before opening a pull request:

- Run `npm test` and include a regression check for changed behavior.
- Smoke-test desktop keyboard and mouse interactions.
- Test touch and Pencil behavior when relevant; if you cannot, say which device path remains untested.
- Bump the cache name in `sw.js` when changing a deployed asset, so installed PWAs receive the update cleanly.
- Changes to optional Drive sync must keep the no-account path free of Drive and broker requests and pass the Drive checks included in `npm test`.

## 简体中文

感谢你帮助 Scattered 保持轻巧、安静而实用。欢迎边界清晰的修复和改进。

### 开始之前

- 如果准备增加功能或改变既有交互，请先提交 Issue 讨论。
- 每个 Pull Request 尽量只解决一个问题。
- 修改交互时，请同时考虑 Pencil + 触控、纯触控、键盘 + 鼠标三种模式。

### 设计约束

- 优先使用直接操作和可视化控件，避免依赖说明文字或持续提示。
- 界面应保持极简，但纯图标按钮仍需保留明确的无障碍名称。
- 画布坚持本地优先；除非用户明确启用需要联网的功能，否则卡片文字、连线和导出文件都不应离开浏览器。
- 添加依赖或构建步骤之前，优先复用现有浏览器能力和原生 JavaScript。

### 开发与测试

需要较新的 Node.js 和 Python 3。

```sh
npm start
```

打开 `http://localhost:4173`，然后运行：

```sh
npm test
```

提交 Pull Request 前：

- 运行 `npm test`，并为行为变化补充回归检查。
- 在桌面端快速检查键盘和鼠标操作。
- 涉及触控或 Pencil 时请做对应测试；如果手边没有设备，请明确说明尚未测试的路径。
- 修改线上资源时同步更新 `sw.js` 的缓存名称，确保已安装的 PWA 能正常获得更新。
- 修改可选的 Drive 同步时，必须保证无账户路径不请求 Drive 或授权中转，并通过 `npm test` 中的 Drive 检查。
