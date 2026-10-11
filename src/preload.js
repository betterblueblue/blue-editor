// preload：contextBridge 白名单暴露——只允许下列通道，杜绝任意 IPC 调用
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_INVOKE = new Set([
  'setting.get', 'setting.put', 'recent.get',
  'dir.list', 'dir.watch',
  'file.watch', 'file.move', 'file.openDialog', 'file.read', 'file.save', 'file.saveAs',
  'fs.createFile', 'fs.createDir', 'fs.rename', 'fs.trash',
  'asset.save',
  'draft.save', 'draft.clear',
  'export.pdf', 'export.html', 'export.png', 'export.cssBundle',
  'find', 'find.stop',
  'shell.openExternal',
  'app.confirmClose', 'app.closeNow',
  'pandoc.isValid', 'pandoc.import', 'pandoc.export'
]);

contextBridge.exposeInMainWorld('bridge', {
  invoke: (channel, ...args) => {
    if (!ALLOWED_INVOKE.has(channel)) {
      return Promise.reject(new Error('blocked ipc channel: ' + channel));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  onMenuAction: (cb) => ipcRenderer.on('menu:action', (e, m) => cb(m.action, m.payload)),
  onDirChanged: (cb) => ipcRenderer.on('dir:changed', () => cb()),
  onFindResult: (cb) => ipcRenderer.on('find:result', (e, r) => cb(r)),
  onFileChanged: (cb) => ipcRenderer.on('file:changed', (e, p) => cb(p))
});
