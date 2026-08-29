# Scattered / 散点

[在线使用](https://kydchen.github.io/scattered/) · [English](README.md)

Scattered 是一个极简、本地优先的自由思考画布，适配 Pencil、触控和键鼠。写下一张卡片，把它放到任何位置，只在需要时连接，然后继续思考。

![自由放置并连接卡片的 Scattered 画布](docs/scattered-canvas.png)

它不需要账户或应用后端，也没有模板或强制层级。画布保存在当前浏览器中，首次加载后也可以离线使用。

## 像普通 App 一样安装

Scattered 可以直接在浏览器中使用，也可以安装成网页 App，获得独立图标和窗口，不需要经过应用商店。

- **Windows、macOS 或 Linux 的 Chrome：**打开 Scattered，选择**更多 → 投放、保存和分享 → 将网页安装为应用**。部分 Chrome 版本也会在地址栏显示安装图标。[Chrome 官方说明](https://support.google.com/chrome/answer/9658361?co=genie.platform%3DDesktop&hl=zh-Hans)
- **Android Chrome：**选择**更多 → 安装和创建快捷方式 → 安装**。[Chrome Android 官方说明](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=zh-Hans)
- **iPhone 或 iPad 的 Safari：**选择**分享 → 添加到主屏幕**，开启**作为网页 App 打开**，然后点**添加**。[Apple iPhone 官方说明](https://support.apple.com/zh-cn/guide/iphone/iphea86e5236/ios) · [Apple iPad 官方说明](https://support.apple.com/zh-cn/guide/ipad/ipad8f1f7a29/ipados)

## 能做什么

- 双击或双点空白处创建卡片，双击卡片编辑
- 自由移动卡片，并调整长文本卡片的宽度
- 建立连线、循环切换箭头方向，并为连线添加文字
- 使用 Pencil 圈选、鼠标框选或触控长按进行多选
- 集体移动、改色、复制、连接、断线或删除所选卡片
- 在本地保存多个画布，通过左上角 Scattered 标志切换
- 清空时保留当前画布及标题；删除则移除整张画布，两种操作都会留下本地恢复副本
- 清空后可以立即撤销，也可以恢复最近一次清空、导入覆盖或删除前的副本
- 搜索卡片文字并依次跳转到结果
- 撤销、重做、一键显示完整画布，并切换明暗模式
- 导出 JSON 备份、SVG 矢量图或 Mermaid Markdown

## 三种输入模式

不同设备使用同一套画布模型，但入口会按照输入方式适配：

| 输入方式 | 选择与移动 | 快速操作 |
| --- | --- | --- |
| Apple Pencil + 触控 | Pencil 圈选；手指平移和双指缩放 | 使用可视化多选栏；也可以用 Scribble 在卡片和搜索框中手写输入 |
| 纯触控 | 长按卡片进入多选；拖动平移、双指缩放 | 使用可视化多选栏和右上角菜单 |
| 键盘 + 鼠标 | Shift 点击或鼠标拖框多选；按住空格拖动画布 | `Cmd/Ctrl` + `A/C/V/D/F/Z`；Delete/Backspace |

## 本地数据与隐私

画布、恢复副本和偏好设置都保存在当前浏览器中。Scattered 没有账户系统，也没有云端同步。清除网站数据或浏览器存储可能删除本地画布，因此重要内容或跨设备迁移时请导出 JSON 备份。

网站启用了 Cloudflare Web Analytics 来了解基本访问量。Scattered 的应用代码不会把卡片文字、画布结构或导出文件发送给分析服务。

## 导入与导出

- **JSON：**保留可继续编辑的完整画布，适合在设备和浏览器之间迁移。
- **SVG：**把完整画布导出为轻量矢量图，并按照全部内容自动适配画布范围。
- **Mermaid Markdown：**把卡片和连线转换成可用于 Markdown 文档及 AI 协作流程的图表。

## 浏览器支持

Scattered 面向 iPadOS、iOS、Android、Windows、macOS 和 Linux 的现代浏览器。当前版本主要在 iPad + Apple Pencil 和桌面 Chromium 浏览器上完成实机测试。Android、Windows 及其他现代浏览器属于正式支持目标，但设备与浏览器组合仍在继续补充测试。

## 本地开发

```sh
npm start
```

打开 `http://localhost:4173`，运行回归检查：

```sh
npm test
```

## 灵感

Scattered 受到 [Scapple](https://www.literatureandlatte.com/scapple/overview) 启发。我一直很喜欢它自由放置卡片、按需连接想法的方式，也一直想要一个能自然使用 Apple Pencil、同时适配其他设备的 Web 版本，于是做了这个独立项目。

Scattered 与 Scapple 及 Literature & Latte 没有关联。

## 许可证

Scattered 以 [MIT License](LICENSE) 开源，欢迎提交问题以及边界清晰的 Pull Request；参见 [CONTRIBUTING.md](CONTRIBUTING.md)。
