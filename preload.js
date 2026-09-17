const { contextBridge, ipcRenderer } = require('electron');

// The renderer stays sandboxed: it gets a fixed set of named functions, not
// ipcRenderer itself.
contextBridge.exposeInMainWorld('api', {
  onMenuAction: callback => {
    ipcRenderer.on('menu-action', (_event, action) => callback(action));
  },
  // Native dialogs live in main. Doing this from the renderer via a hidden file
  // input breaks when triggered from a menu, because Chromium requires transient
  // user activation and a native menu click never grants it.
  openFile: intent => ipcRenderer.invoke('dialog:open', intent),
  saveFile: options => ipcRenderer.invoke('dialog:save', options),
  message: options => ipcRenderer.invoke('dialog:message', options),
  setTitle: title => ipcRenderer.invoke('window:title', title),
  onCloseRequest: callback => { ipcRenderer.on('app-close-request', () => callback()); },
  confirmClose: ok => ipcRenderer.invoke('window:close-confirmed', ok),
  readAsset: name => ipcRenderer.invoke('asset:read', name),
  printPdf: options => ipcRenderer.invoke('print:pdf', options),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: cb => { ipcRenderer.on('update-progress', (_e, p) => cb(p)); },
  getConfig: () => ipcRenderer.invoke('config:get'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  dataFolder: () => ipcRenderer.invoke('app:data-folder'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  setConfig: patch => ipcRenderer.invoke('config:set', patch),
  testPath: dir => ipcRenderer.invoke('config:test-path', dir),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  indexRebuild: () => ipcRenderer.invoke('index:rebuild'),
  identity: () => ipcRenderer.invoke('identity:get'),
  publishSidecar: entry => ipcRenderer.invoke('sidecar:publish', entry),
  indexStats: () => ipcRenderer.invoke('index:stats'),
  indexFlagMissing: id => ipcRenderer.invoke('index:flag-missing', id),
  indexPurgeMissing: () => ipcRenderer.invoke('index:purge-missing'),
  indexIdTaken: (packageId, file) =>
    ipcRenderer.invoke('index:id-taken', { packageId, file }),
  onIndexProgress: cb => { ipcRenderer.on('index-progress', (_e, p) => cb(p)); },
  resolveSource: query => ipcRenderer.invoke('source:resolve', query),
  readPackage: file => ipcRenderer.invoke('package:read', file),
  packageStamp: file => ipcRenderer.invoke('package:stamp', file),
  lockAcquire: file => ipcRenderer.invoke('lock:acquire', file),
  lockRelease: () => ipcRenderer.invoke('lock:release'),
  onLockLost: cb => { ipcRenderer.on('lock-lost', (_e, file) => cb(file)); },
  recoverySave: payload => ipcRenderer.invoke('recovery:save', payload),
  recoveryCheck: () => ipcRenderer.invoke('recovery:check'),
  recoveryLoad: () => ipcRenderer.invoke('recovery:load'),
  recoveryClear: () => ipcRenderer.invoke('recovery:clear'),
  recentsList: () => ipcRenderer.invoke('recents:list'),
  recentsAdd: entry => ipcRenderer.invoke('recents:add', entry),
  recentsRemove: file => ipcRenderer.invoke('recents:remove', file),
  recentsClear: () => ipcRenderer.invoke('recents:clear'),
  searchPackages: (q, opts) => ipcRenderer.invoke('index:search', q, opts),
  printDialog: opts => ipcRenderer.invoke('print:dialog', opts),
  printPdfBytes: opts => ipcRenderer.invoke('print:pdfBytes', opts),
  pickWorkbook: () => ipcRenderer.invoke('xlsx:pick'),
  appendWorkbook: payload => ipcRenderer.invoke('xlsx:append', payload)
});
