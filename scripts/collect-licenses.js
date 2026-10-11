// 打包前收集第三方许可证原文到 licenses/third-party/（extraResources 打进安装包）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'licenses', 'third-party');

const SOURCES = [
  ['vditor', 'node_modules/vditor/LICENSE'],
  ['highlight.js', 'node_modules/vditor/dist/js/highlight.js/LICENSE'],
  ['mathjax', 'node_modules/vditor/dist/js/mathjax/LICENSE'],
  ['wavedrom', 'node_modules/vditor/dist/js/wavedrom/LICENSE.WaveDrom'],
  ['diff-match-patch', 'node_modules/diff-match-patch/LICENSE'],
  // Vditor dist 里未附 LICENSE 的组件（katex/mermaid/echarts/lute/markmap/
  // abcjs/smiles-drawer/flowchart.js/graphviz/plantuml-encoder），其许可证
  // 名称与出处见 THIRD_PARTY_NOTICES.md，通用文本在 licenses/ 下另附。
];

// electron-updater 及其传递依赖——逐个找 LICENSE* 文件
const RUNTIME_DEPS = [
  'electron-updater', 'builder-util-runtime', 'fs-extra', 'js-yaml',
  'argparse', 'semver', 'lazy-val', 'lodash.escaperegexp', 'lodash.isequal',
  'tiny-typed-emitter', 'sax', 'debug', 'ms', 'graceful-fs', 'jsonfile',
  'universalify'
];
for (const dep of RUNTIME_DEPS) {
  const dir = path.join(root, 'node_modules', dep);
  if (!fs.existsSync(dir)) continue;
  const lic = fs.readdirSync(dir).find(f => /^(licen[sc]e|copying)/i.test(f));
  if (lic) SOURCES.push([dep, 'node_modules/' + dep + '/' + lic]);
}

fs.rmSync(path.join(root, 'licenses'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [name, rel] of SOURCES) {
  const src = path.join(root, rel);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(out, name + '.txt'));
    console.log('copied', rel);
  } else {
    console.log('missing', rel);
  }
}
console.log('done -> licenses/third-party/');
