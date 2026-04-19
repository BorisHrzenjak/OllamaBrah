'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
    getUpdateState: () => ipcRenderer.invoke('app:getUpdateState'),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    downloadUpdate: () => ipcRenderer.invoke('app:downloadUpdate'),
    installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    writeClipboard: (text) => ipcRenderer.invoke('app:writeClipboard', text),

    store: {
        get:    (key, def) => ipcRenderer.invoke('store:get', key, def),
        set:    (key, val) => ipcRenderer.invoke('store:set', key, val),
        delete: (key)      => ipcRenderer.invoke('store:delete', key),
        getAll: ()         => ipcRenderer.invoke('store:getAll'),
    },

    tabs: {
        getAll:                () =>            ipcRenderer.invoke('tabs:getAll'),
        create:                (data) =>        ipcRenderer.invoke('tabs:create', data),
        update:                (id, changes) => ipcRenderer.invoke('tabs:update', id, changes),
        remove:                (id) =>          ipcRenderer.invoke('tabs:remove', id),
        reorder:               (ids) =>         ipcRenderer.invoke('tabs:reorder', ids),
        setActiveConversation: (tid, cid) =>    ipcRenderer.invoke('tabs:setActiveConversation', tid, cid),
    },

    db: {
        loadConversations:  (tabId) =>              ipcRenderer.invoke('db:loadConversations', tabId),
        createConversation: (tabId, model, title) => ipcRenderer.invoke('db:createConversation', tabId, model, title),
        updateConversation: (id, changes) =>         ipcRenderer.invoke('db:updateConversation', id, changes),
        deleteConversation: (id) =>                  ipcRenderer.invoke('db:deleteConversation', id),
        loadMessages:       (convId) =>              ipcRenderer.invoke('db:loadMessages', convId),
        appendMessage:      (convId, msg) =>         ipcRenderer.invoke('db:appendMessage', convId, msg),
        deleteMessage:      (id) =>                  ipcRenderer.invoke('db:deleteMessage', id),
        clearMessages:      (convId) =>              ipcRenderer.invoke('db:clearMessages', convId),
        loadModelState:     (tabId, model) =>        ipcRenderer.invoke('db:loadModelState', tabId, model),
        saveModelState:     (tabId, model, s) =>     ipcRenderer.invoke('db:saveModelState', tabId, model, s),
        getDetectedContextLimit: (model) =>          ipcRenderer.invoke('db:getDetectedContextLimit', model),
        saveDetectedContextLimit: (model, limit) =>  ipcRenderer.invoke('db:saveDetectedContextLimit', model, limit),
        getAllDetectedContextLimits: () =>           ipcRenderer.invoke('db:getAllDetectedContextLimits'),
        getDashboardStats:  () =>                    ipcRenderer.invoke('db:getDashboardStats'),
    },

    window: {
        minimize: () => ipcRenderer.invoke('window:minimize'),
        maximize: () => ipcRenderer.invoke('window:maximize'),
        close:    () => ipcRenderer.invoke('window:close'),
    },

    skills: {
        pickFolder: () => ipcRenderer.invoke('skills:pickFolder'),
    },

    workspace: {
        pickFolder: () => ipcRenderer.invoke('workspace:pickFolder'),
    },

    on:  (ch, cb) => ipcRenderer.on(ch, (_e, ...a) => cb(...a)),
    off: (ch, cb) => ipcRenderer.removeListener(ch, cb),
});
