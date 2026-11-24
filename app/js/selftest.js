// Test harness (only loaded when IQRA_TEST is set). Runs steps from <test>/plan.json.
import * as ui from './ui.js'
import { data, db } from './db.js'
import * as store from './store.js'
import * as settings from './settings.js'
import * as reader from './reader.js'

const api = window.api
const sleep = ms => new Promise(r => setTimeout(r, ms))
export async function run(dir) {
    window.__t = { ui, data, db, store, settings, reader, sleep }
    const plan = JSON.parse(await api.invoke('file:readText', dir + '/plan.json'))
    const log = []
    for (const step of plan) {
        try {
            if (step.wait) await sleep(step.wait)
            if (step.until) { const fn = new Function('t', `return (${step.until})`); for (let i = 0; i < 100 && !(await fn(window.__t)); i++) await sleep(200) }
            if (step.route) { location.hash = '#/' + step.route; await sleep(step.after ?? 900) }
            if (step.open) {
                const b = store.lib.books.find(x => x.title.toLowerCase().includes(step.open.toLowerCase()))
                if (!b) throw new Error('no book ' + step.open)
                location.hash = '#/read/' + b.id; await sleep(step.after ?? 3000)
            }
            if (step.eval) { const fn = new (Object.getPrototypeOf(async function () {}).constructor)('t', step.eval); const r = await fn(window.__t); if (r !== undefined) log.push({ eval: step.name ?? step.eval.slice(0, 40), r }) }
            if (step.shot) { await sleep(step.settle ?? 400); await api.invoke('test:shot', `${dir}/${step.shot}.png`) }
        } catch (e) { log.push({ step, error: String(e?.stack ?? e) }) }
    }
    await db.flush()
    await api.invoke('test:done', { log })
}
