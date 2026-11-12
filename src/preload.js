const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('yt', {
  // finestra
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
  close: () => ipcRenderer.send('win:close'),
  onOpenDir: (cb) => ipcRenderer.on('app:openDir', (_e, dir) => cb(dir)),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s)),

  // config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (partial) => ipcRenderer.invoke('config:save', partial),
  info: () => ipcRenderer.invoke('app:info'),

  // pty
  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, id, code) => cb(id, code)),

  // dispositivi in rete
  netInterfaces: () => ipcRenderer.invoke('net:interfaces'),
  netScan: (range) => ipcRenderer.invoke('net:scan', range),
  netCancel: () => ipcRenderer.invoke('net:cancel'),
  netModbus: (opts) => ipcRenderer.invoke('net:modbus', opts),
  netRdp: (ip) => ipcRenderer.invoke('net:rdp', ip),
  onNetProgress: (cb) => ipcRenderer.on('net:progress', (_e, p) => cb(p)),
  onNetDevice: (cb) => ipcRenderer.on('net:device', (_e, d) => cb(d)),

  // aggiornamenti
  updateGet: () => ipcRenderer.invoke('update:get'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, s) => cb(s)),

  // pannelli tra finestre
  detachPane: (payload) => ipcRenderer.invoke('pane:detach', payload),
  adoptInfo: () => ipcRenderer.invoke('pane:adoptInfo'),
  adopted: (id) => ipcRenderer.send('pane:adopted', id),

  // archivi e progetti
  loadStore: (name) => ipcRenderer.invoke('store:load', name),
  saveStore: (name, data) => ipcRenderer.invoke('store:save', name, data),
  detectProject: (dir) => ipcRenderer.invoke('project:detect', dir),

  // fs
  list: (dir, showHidden) => ipcRenderer.invoke('fs:list', dir, showHidden),
  walkDirs: (root, depth, limit) => ipcRenderer.invoke('fs:walkDirs', root, depth, limit),
  drives: () => ipcRenderer.invoke('fs:drives'),
  isDir: (p) => ipcRenderer.invoke('fs:isDir', p),
  resolve: (base, rel) => ipcRenderer.invoke('fs:resolve', base, rel),
  parent: (p) => ipcRenderer.invoke('fs:parent', p),
  openPath: (p) => ipcRenderer.invoke('fs:openExternal', p),
  showInFolder: (p) => ipcRenderer.invoke('fs:showInFolder', p),
  pathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),

  openUrl: (u) => ipcRenderer.invoke('shell:openUrl', u),

  // appunti
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (t) => ipcRenderer.send('clipboard:write', t)
});
