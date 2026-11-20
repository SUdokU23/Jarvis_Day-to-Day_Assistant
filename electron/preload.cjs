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
}));
