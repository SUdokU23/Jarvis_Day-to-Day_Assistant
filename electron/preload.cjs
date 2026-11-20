const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', Object.freeze({
  platform: process.platform,
  getServiceStatus: () => ipcRenderer.invoke('service-status:get'),
  onServiceStatus(callback) {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('service-status:changed', listener);
    return () => ipcRenderer.removeListener('service-status:changed', listener);
  },
}));
