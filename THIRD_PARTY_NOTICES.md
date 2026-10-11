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
| Viz.js（graphviz 渲染） | MIT（包装层） |
| Graphviz（Viz.js 内置引擎） | EPL-1.0 |
| abcjs | MIT |
| smiles-drawer | MIT |
| Wavedrom | MIT |
| plantuml-encoder | MIT |
| diff-match-patch | Apache-2.0 |

各组件版权归其各自所有者所有。若上游许可证清单有变动，以各项目
仓库内的 LICENSE 文件为准。

## 关于 Graphviz / EPL-1.0 的源码说明

Viz.js（https://github.com/mdaines/viz.js）发行包内嵌经 Emscripten 编译的
Graphviz 引擎，该部分以 EPL-1.0 授权。其对应源码可从上述仓库及其上游
Graphviz 项目（https://graphviz.org）获取。

## 打包附带的许可证文本

安装包内 `resources/licenses/` 目录收录本项目自身 LICENSE、本声明以及
发行包中能找到的各组件 LICENSE 原文（`licenses/third-party/`）。
