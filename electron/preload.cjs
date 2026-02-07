const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gcElectron', {
  compileLatex: (req) => ipcRenderer.invoke('latex:compile', req ?? {}),
  pickLatexProject: () => ipcRenderer.invoke('latex:pick-project'),
  listLatexProjectFiles: (req) => ipcRenderer.invoke('latex:list-project-files', req ?? {}),
  readLatexProjectFile: (req) => ipcRenderer.invoke('latex:read-project-file', req ?? {}),
  writeLatexProjectFile: (req) => ipcRenderer.invoke('latex:write-project-file', req ?? {}),
});
