const { contextBridge, ipcRenderer, webUtils } = require('electron')

const CHANNELS = new Set(['db:get', 'db:patch', 'db:replace', 'db:flush', 'app:info', 'scan', 'stat', 'exists:many',
    'walk:any', 'cover:save', 'cover:delete', 'dialog:open', 'dialog:save', 'file:readText', 'shell:show', 'shell:open',
    'net:fetch', 'download', 'archive:extract', 'doc:text', 'cache:clear', 'win:new', 'win:fullscreen', 'win:onTop',
    'win:overlay', 'win:title', 'win:close', 'test:done', 'test:shot'])
const EVENTS = new Set(['db:patched', 'db:replaced', 'open-files', 'fullscreen'])

contextBridge.exposeInMainWorld('api', {
    invoke: (channel, ...args) => {
        if (!CHANNELS.has(channel)) throw new Error(`Unknown channel ${channel}`)
        return ipcRenderer.invoke(channel, ...args)
    },
    on: (channel, fn) => {
        if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`)
        ipcRenderer.on(channel, (e, ...args) => fn(...args))
    },
    pathForFile: file => webUtils.getPathForFile(file),
})
