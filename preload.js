'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  readClipboardText: () => ipcRenderer.invoke('read-clipboard-text'),
  copyImageBuffer: (base64) => ipcRenderer.invoke('copy-image-buffer', base64),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openSaveFolder: (kind) => ipcRenderer.invoke('open-save-folder', kind),
  extractJavCode: (text) => ipcRenderer.invoke('extract-jav-code', text),
  searchCover: (input) => ipcRenderer.invoke('search-cover', input)
});
