// Renderer-side view of the data stores owned by the main process.
// Mutations are applied locally at once and sent to main as patches.
const api = window.api
export const data = { library: {}, settings: {}, annotations: {}, stats: {} }
const listeners = new Set()
const queues = {}
let flushTimer

function applyLocal(root, path, value, op) {
    let o = root
    for (let i = 0; i < path.length - 1; i++) {
        const k = path[i]
        if (o[k] == null || typeof o[k] !== 'object') o[k] = {}
        o = o[k]
    }
    const k = path[path.length - 1]
    if (op === 'inc') o[k] = (Number(o[k]) || 0) + value
    else if (value === null || value === undefined) delete o[k]
    else o[k] = value
}
function emit(name, ops, remote) { for (const fn of listeners) fn(name, ops, remote) }
function send() {
    flushTimer = null
    for (const [name, ops] of Object.entries(queues)) {
        delete queues[name]
        api.invoke('db:patch', name, ops)
    }
}

export const db = {
    async init() {
        for (const name of Object.keys(data)) data[name] = (await api.invoke('db:get', name)) ?? {}
        api.on('db:patched', (name, ops) => {
            for (const [p, v, op] of ops) applyLocal(data[name], p, v, op)
            emit(name, ops, true)
        })
        api.on('db:replaced', (name, value) => { data[name] = value; emit(name, null, true) })
    },
    set(name, path, value) { this.patch(name, [[path, value]]) },
    inc(name, path, delta) { this.patch(name, [[path, delta, 'inc']]) },
    patch(name, ops) {
        // structured clone keeps the local copy and the queued copy independent
        for (const [p, v, op] of ops) applyLocal(data[name], p, v == null || typeof v !== 'object' ? v : structuredClone(v), op)
        ;(queues[name] ??= []).push(...ops)
        flushTimer ??= setTimeout(send, 120)
        emit(name, ops, false)
    },
    replace(name, value) {
        data[name] = value
        delete queues[name]
        api.invoke('db:replace', name, value)
        emit(name, null, false)
    },
    flush() { clearTimeout(flushTimer); send(); return api.invoke('db:flush') },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
}
window.addEventListener('beforeunload', () => { clearTimeout(flushTimer); send() })
