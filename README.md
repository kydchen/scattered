# Scattered / 散点

[在线使用 / Open App](https://kydchen.github.io/scattered/) · [中文](#中文) · [English](#english)

## 中文

散点是一个极简、跨平台的自由思考画布：写卡片、自由移动、连接想法，然后继续思考。没有账户、服务器或强制结构，内容只保存在当前浏览器。

它不是 iPad 专用应用。散点基于标准 Web 技术，并分别适配了触控与手写笔、纯触控、键盘与鼠标三套交互，可在 iPadOS、iOS、Android、Windows、macOS 和 Linux 的现代浏览器中使用，也可以按 PWA 安装。当前主要在 iPad + Apple Pencil 和桌面 Chromium 浏览器上完成实机测试；Android 与 Windows 属于正式支持目标，但尚未覆盖所有设备与浏览器组合。

### 核心操作

- 双击空白处新建卡片；双击卡片编辑
- 自由拖动卡片，拖动连接点建立或取消连线
- 点击连线添加箭头、文字或断开连接
- Pencil 圈选；触控长按进入多选；桌面端 Shift + 点击或拖框多选
- 多选后可一起移动、改色、连接、断线或删除
- 拖动卡片右下角调整长文本宽度
- 双指缩放；触控拖动或桌面端空格 + 拖动平移画布
- 左上角按钮一键居中并显示全部卡片
- 内容自动保存在当前浏览器；右上角菜单可导入或导出 JSON 备份

### 使用与安装

直接打开[在线版本](https://kydchen.github.io/scattered/)即可使用，无需账户或安装。若想像独立应用一样启动，可使用浏览器的“添加到主屏幕”或“安装应用”；HTTPS 下也支持离线缓存。

JSON 备份可以在不同设备和浏览器之间手动迁移画布。当前没有云端同步，同一网址不会自动合并不同设备上的内容。

### 本地开发

```sh
npm start
```

打开 `http://localhost:4173`。运行检查：

```sh
npm test
```

### 灵感与关系

散点受到 [Scapple](https://www.literatureandlatte.com/scapple/overview) 启发。我一直很喜欢它自由放置卡片、按需连接想法的方式，也一直想要一个能自然使用 Apple Pencil、同时适配其他设备的 Web 版本，于是做了这个独立项目。

散点与 Scapple 及 Literature & Latte 没有关联。

## English

Scattered is a minimalist, cross-platform canvas for thinking freely: write notes, move them anywhere, connect ideas when useful, and keep thinking. There are no accounts, servers, or forced structure. Your content stays in the current browser.

It is not an iPad-only app. Scattered uses standard web technologies and provides separate interaction paths for touch + stylus, touch only, and keyboard + mouse. It is designed for modern browsers on iPadOS, iOS, Android, Windows, macOS, and Linux, and can also be installed as a PWA. The current release has been tested primarily on iPad with Apple Pencil and desktop Chromium browsers. Android and Windows are supported targets, but the full device-and-browser matrix has not yet been tested.

### Core interactions

- Double-tap empty space to create a note; double-tap a note to edit it
- Move notes freely and drag a connection handle to connect or disconnect them
- Select a connection to add an arrow, add text, or remove it
- Lasso with a stylus; long-press for touch multi-selection; Shift-click or marquee-select on desktop
- Move, recolor, connect, disconnect, or delete multiple selected notes together
- Drag the lower-right handle to resize long notes
- Pinch to zoom; drag with touch or hold Space and drag on desktop to pan
- Fit all notes into view with the top-left control
- Changes save automatically in the current browser; import or export JSON backups from the top-right menu

### Use and install

Open the [hosted app](https://kydchen.github.io/scattered/) and start immediately—no account or installation required. To launch it like a standalone app, use your browser's Add to Home Screen or Install option. Offline caching is available over HTTPS.

JSON backups can move a canvas between devices and browsers manually. There is currently no cloud sync, so the same URL does not automatically merge content across devices.

### Local development

```sh
npm start
```

Open `http://localhost:4173`. Run checks with:

```sh
npm test
```

### Inspiration and affiliation

Scattered is inspired by [Scapple](https://www.literatureandlatte.com/scapple/overview), a tool I have loved for years. I wanted its freeform note-and-connection flow in a web app that feels natural with Apple Pencil while remaining useful on other devices, so I built this independent project.

Scattered is not affiliated with Scapple or Literature & Latte.

## License / 许可证

The source is publicly visible, but no open-source license has been granted yet. All rights are reserved until a license is added.

源码公开可见，但目前尚未授予开源许可证；添加许可证前保留所有权利。
