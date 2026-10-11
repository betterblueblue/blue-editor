# Third-Party Notices

Blue Editor 包含以下第三方组件。本文件列出其名称、许可证与出处；
完整的许可证文本见各上游仓库及打包产物内的 LICENSE 文件。

## 直接依赖

| 组件 | 版本 | 许可证 | 说明 |
|---|---|---|---|
| Electron | ^44.7.0 | MIT | 桌面应用运行时 |
| Vditor | ^4.0.0 | MIT | 所见即所得 Markdown 编辑器内核（B3log / Vanessa219） |
| electron-builder | ^26.15.3 | MIT | 打包工具（开发依赖） |

## Vditor 发行包内捆绑的组件（node_modules/vditor/dist/js/）

Blue Editor 打包时随 Vditor 发行包包含下列库，各自保留其许可证：

| 组件 | 许可证（据其上游声明） |
|---|---|
| Lute（Markdown 引擎，Go → JS） | MulanPSL-2.0 |
| KaTeX | MIT |
| MathJax | Apache-2.0 |
| highlight.js | BSD-3-Clause |
| mermaid | MIT |
| Apache ECharts | Apache-2.0 |
| markmap | MIT |
| flowchart.js | MIT |
| graphviz / Viz.js | MIT |
| abcjs | MIT |
| smiles-drawer | MIT |
| Wavedrom | BSD-3-Clause |
| plantuml-encoder | MIT |
| diff-match-patch | Apache-2.0 |

各组件版权归其各自所有者所有。若上游许可证清单有变动，以各项目
仓库内的 LICENSE 文件为准。
