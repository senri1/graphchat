const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gcElectron', {
  compileLatex: (req) => ipcRenderer.invoke('latex:compile', req ?? {}),
});
