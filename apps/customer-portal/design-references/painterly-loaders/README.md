# Painting Loaders 离线归档

来源：[Painting Loaders](https://painterly.design-tools.workers.dev/)（页面署名 Sasha，2026）。归档日期：2026-10-12。

这里保存了该页面展示的全部 12 个绘画效果，以及页面的开场花朵动画、卡片悬停重绘、全屏切换和主题切换。`index.html` 是可离线运行的完整画廊；`standalone/` 中每个 HTML 单独展示一种绘画效果；`stills/` 是效果完成后的 12 张预览图；`preview.png` 是画廊截图。`original/index.html` 保留下载时的原始页面 HTML。

## 打开方法

直接打开 `index.html` 即可。若浏览器限制本地文件，也可以在此目录运行：

```bash
python3 -m http.server 8765
```

然后访问 `http://localhost:8765/`。每个效果也可以通过 `standalone/<效果名>.html` 打开；这些文件依赖同一归档中的 `vendor/`，移动单个 HTML 时要同时复制 `vendor/`。

## 效果清单

| 文件名 | 画廊名称 |
| --- | --- |
| `impressionism-garden` | Garden |
| `impressionism-dawn` | Dawn |
| `impressionism-willow` | Willow |
| `impressionism-wisteria` | Wisteria |
| `impressionism-orchard` | Orchard |
| `impressionism-irises` | Irises |
| `impressionism-poppies` | Poppies |
| `impressionism-koi` | Koi |
| `impressionism-roses` | Roses |
| `impressionism-oranges` | Oranges |
| `impressionism-sail` | Sail |
| `abstraction-dusk` | Dusk |

## 文件说明

- `engine.js`、`style-*.js`、`gallery.js` 和 `copycode.js`：原站绘画引擎、风格定义和画廊交互。
- `vendor/`：与原站一致的 p5.js 2.3.3、p5.brush 2.2.2 及其许可文件。
- `fonts/`：画廊使用的 Newsreader 字体文件、本地 CSS 和 OFL 许可文件。
- `build-archive.mjs`：根据保存的原始文件重建离线画廊、12 个独立页面和 `manifest.json`。运行需要 Node.js。
- `manifest.json`：文件大小和 SHA-256 校验值。

画廊中的“Copy code”保留原站行为，复制出的代码仍引用在线 CDN；需要离线打开时请使用 `standalone/` 中已改为本地依赖的文件。原站页面未提供自己的授权文件；本归档保留来源和作者署名，仅作为设计参考存档。第三方依赖的许可见 `vendor/`。
