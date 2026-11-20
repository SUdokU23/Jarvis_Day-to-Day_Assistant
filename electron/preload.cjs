const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', Object.freeze({
  platform: process.platform,
  sendPrompt: async (prompt) => {
    try {
      return await ipcRenderer.invoke('send-prompt', prompt);
    } catch {
      return {
        success: false,
        error: { code: 'IPC_FAILURE', message: 'Could not send the prompt to Jarvis.', retryable: false },
      };
    }
  },
  getServiceStatus: () => ipcRenderer.invoke('service-status:get'),
  onServiceStatus(callback) {
    if (typeof callback !== 'function') throw new TypeError('Expected a service status callback.');
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('service-status:changed', listener);
    return () => ipcRenderer.removeListener('service-status:changed', listener);
  },
}));
