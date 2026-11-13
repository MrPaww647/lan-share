const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moneyflow', {
  getConnectionInfo: () => ipcRenderer.invoke('connection-info')
});
