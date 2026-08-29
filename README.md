# Scattered

[Open Scattered](https://kydchen.github.io/scattered/) · [简体中文](README.zh-CN.md)

Scattered is a minimalist, cross-platform canvas for thinking freely. Write a note, move it anywhere, connect it only when useful, and keep thinking.

![A Scattered canvas with freely arranged and connected notes](docs/scattered-canvas.png)

There are no accounts, servers, templates, or forced hierarchy. Your boards stay in the current browser and remain available offline after the app has been loaded once.

## Install it like an app

You can use Scattered directly in a browser, but installing the web app gives it its own icon and standalone window without requiring an App Store download.

- **Chrome on Windows, macOS, or Linux:** open Scattered, then choose **More → Cast, save, and share → Install page as app**. Some Chrome versions also show an install icon in the address bar. [Chrome instructions](https://support.google.com/chrome/answer/9658361?co=genie.platform%3DDesktop&hl=en)
- **Chrome on Android:** choose **More → Install and create shortcut → Install**. [Chrome Android instructions](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en)
- **Safari on iPhone or iPad:** choose **Share → Add to Home Screen**, turn on **Open as Web App**, then tap **Add**. [Apple iPhone instructions](https://support.apple.com/guide/iphone/iphea86e5236/ios) · [Apple iPad instructions](https://support.apple.com/guide/ipad/ipad8f1f7a29/ipados)

## What it can do

- Create and edit notes with a double-click or double-tap
- Move notes freely and resize long notes
- Connect notes, cycle arrow direction, and label connections
- Lasso, marquee-select, or long-press to select multiple notes
- Move, recolor, duplicate, connect, disconnect, or delete a selection together
- Keep multiple local boards and switch between them from the Scattered mark
- Recover the most recently cleared, imported-over, or deleted board
- Search note text and jump between matches
- Undo, redo, fit the whole board into view, and switch between light and dark modes
- Export JSON backups, SVG vector images, or Mermaid Markdown

## Input modes

Scattered uses the same model across devices, with controls adapted to each input style:

| Input | Selection and navigation | Fast actions |
| --- | --- | --- |
| Apple Pencil + touch | Lasso with Pencil; pan and pinch with fingers | Use the visual selection bar; Pencil can write into search with Scribble |
| Touch only | Long-press a note to enter multi-select; drag to pan and pinch to zoom | Use the visual selection bar and top-right menu |
| Keyboard + mouse | Shift-click or drag a marquee; hold Space and drag to pan | `Cmd/Ctrl+A`, `C`, `V`, `D`, `F`, `Z`; Delete/Backspace |

## Local data and privacy

Boards, recovery copies, and preferences are stored locally in the browser. Scattered has no account system and no cloud sync. Clearing site data or browser storage can remove local boards, so export a JSON backup for anything important or when moving to another browser or device.

Cloudflare Web Analytics is enabled for basic traffic measurement. Scattered's application code does not send note text, board structure, or exported files to an analytics service.

## Import and export

- **JSON** preserves an editable board and is the format to use when moving between devices or browsers.
- **SVG** exports the complete board as a lightweight vector image, automatically fitted to its content.
- **Mermaid Markdown** turns notes and connections into a diagram that can be used in Markdown documents and AI-assisted workflows.

## Browser support

Scattered is designed for modern browsers on iPadOS, iOS, Android, Windows, macOS, and Linux. The current release is tested most heavily on iPad with Apple Pencil and desktop Chromium browsers. Android, Windows, and other modern browsers are supported targets, but the full device-and-browser matrix is still growing.

## Local development

```sh
npm start
```

Open `http://localhost:4173`, then run the regression checks with:

```sh
npm test
```

## Inspiration

Scattered is inspired by [Scapple](https://www.literatureandlatte.com/scapple/overview), a tool I have loved for years. I wanted its freeform note-and-connection flow in a web app that feels natural with Apple Pencil while remaining useful on other devices, so I built this independent project.

Scattered is not affiliated with Scapple or Literature & Latte.

## License

Scattered is open source under the [MIT License](LICENSE). Issues and focused pull requests are welcome.
