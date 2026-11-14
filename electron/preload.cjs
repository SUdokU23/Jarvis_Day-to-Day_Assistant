const { contextBridge } = require('electron');

// Static metadata only. Add individual IPC methods when their issues are implemented.
contextBridge.exposeInMainWorld('jarvis', Object.freeze({ platform: process.platform }));
