// Small UI toolkit: element builder, icons, toasts, modals, menus, formatters
import { ICONS } from './icons.js'

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export function h(tag, props, ...children) {
    const [name, ...classes] = tag.split('.')
    const el = document.createElement(name || 'div')
    if (classes.length) el.className = classes.join(' ')
    if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
        children.unshift(props); props = null
    }
    for (const [k, v] of Object.entries(props ?? {})) {
        if (v == null || v === false) continue
        if (k === 'class') el.className += (el.className ? ' ' : '') + v
        else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv) }
        else if (k === 'dataset') Object.assign(el.dataset, v)
        else if (k === 'html') el.innerHTML = v
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
        else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v } catch { el.setAttribute(k, v) } }
        else el.setAttribute(k, v === true ? '' : v)
    }
    append(el, children)
    return el
}
function append(el, children) {
    for (const c of children) {
        if (c == null || c === false) continue
        if (Array.isArray(c)) append(el, c)
        else el.append(c instanceof Node ? c : String(c))
    }
}

export function icon(name, size = 18) {
    const span = document.createElement('span')
    span.className = 'icon'
    span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`
    return span
}
export const iconBtn = (name, title, onclick, cls = '') =>
    h('button.icon-btn', { class: cls, title, 'aria-label': title, onclick }, icon(name))

export const debounce = (fn, ms = 250) => {
    let t
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
    d.flush = (...a) => { clearTimeout(t); fn(...a) }
    return d
}
export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
export function hashStr(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)
}

export function fmtDuration(sec, short) {
    sec = Math.max(0, Math.round(sec))
    const hrs = Math.floor(sec / 3600), min = Math.floor((sec % 3600) / 60)
    if (hrs >= 1) return short ? `${hrs}h ${min}m` : `${hrs} hr ${min} min`
    if (min >= 1) return short ? `${min}m` : `${min} min`
    return short ? `${sec}s` : 'under a minute'
}
export const fmtDate = t => t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
export const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB'
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export function relTime(t) {
    if (!t) return ''
    const d = (Date.now() - t) / 1000
    if (d < 90) return 'just now'
    if (d < 3600) return `${Math.round(d / 60)} min ago`
    if (d < 86400) return `${Math.round(d / 3600)} hr ago`
    if (d < 86400 * 7) return `${Math.round(d / 86400)} days ago`
    return fmtDate(t)
}

// ---------- toast ----------
export function toast(msg, { type = '', ms = 3200, action } = {}) {
    let host = $('#toasts')
    if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host) }
    const el = h('div.toast', { class: type }, h('span', msg),
        action ? h('button.link', { onclick: () => { action.run(); el.remove() } }, action.label) : null)
    host.append(el)
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300) }, ms)
    return el
}

// ---------- modal ----------
export function modal({ title, body, actions = [], wide, onClose, cls = '' }) {
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose?.() }
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    const box = h('div.modal', { class: (wide ? 'wide ' : '') + cls, role: 'dialog' },
        h('header', h('h2', title), iconBtn('x', 'Close', () => close())),
        h('div.modal-body', body),
        actions.length ? h('footer', actions.map(a =>
            h('button', { class: a.primary ? 'btn primary' : a.danger ? 'btn danger' : 'btn', onclick: async () => { if ((await a.run?.()) !== false) close() } }, a.label))) : null)
    const back = h('div.modal-back', { onmousedown: e => { if (e.target === back) close() } }, box)
    document.body.append(back)
    document.addEventListener('keydown', onKey, true)
    setTimeout(() => box.querySelector('input,textarea,select,button.primary')?.focus(), 30)
    return { close, box }
}
export const confirmBox = (title, text, okLabel = 'OK', danger) => new Promise(resolve => {
    let done = false
    modal({
        title, body: h('p', text), onClose: () => { if (!done) resolve(false) },
        actions: [{ label: 'Cancel' }, { label: okLabel, primary: !danger, danger, run: () => { done = true; resolve(true) } }],
    })
})
export const promptBox = (title, label, value = '', multiline) => new Promise(resolve => {
    let done = false
    const input = multiline ? h('textarea', { rows: 6, value }) : h('input', { type: 'text', value })
    const ok = () => { done = true; resolve(input.value) }
    if (!multiline) input.addEventListener('keydown', e => { if (e.key === 'Enter') { ok(); m.close() } })
    const m = modal({
        title, body: h('label.field', h('span', label), input), onClose: () => { if (!done) resolve(null) },
        actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, run: ok }],
    })
})

// ---------- popup menu ----------
export function menu(x, y, items) {
    closeMenus()
    const el = h('div.menu', { role: 'menu' }, items.filter(Boolean).map(it => it === '-'
        ? h('hr')
        : h('button', { class: (it.danger ? 'danger ' : '') + (it.checked ? 'checked' : ''), disabled: it.disabled, onclick: e => { e.stopPropagation(); closeMenus(); it.run?.() } },
            it.icon ? icon(it.icon, 16) : h('span.icon'), h('span', it.label), it.hint ? h('kbd', it.hint) : null)))
    document.body.append(el)
    const r = el.getBoundingClientRect()
    el.style.left = clamp(x, 6, innerWidth - r.width - 6) + 'px'
    el.style.top = clamp(y, 6, innerHeight - r.height - 6) + 'px'
    setTimeout(() => {
        document.addEventListener('mousedown', outside, true)
        document.addEventListener('keydown', escKey, true)
    })
    return el
}
const outside = e => { if (!e.target.closest('.menu')) closeMenus() }
const escKey = e => { if (e.key === 'Escape') closeMenus() }
export function closeMenus() {
    $$('.menu').forEach(m => m.remove())
    document.removeEventListener('mousedown', outside, true)
    document.removeEventListener('keydown', escKey, true)
}
export const menuAt = (el, items) => { const r = el.getBoundingClientRect(); return menu(r.left, r.bottom + 4, items) }

// ---------- form controls used by settings panels ----------
export function segmented(options, value, onchange) {
    const el = h('div.seg', options.map(o => {
        const [val, label, ic] = Array.isArray(o) ? o : [o, o]
        return h('button', { class: val === value ? 'on' : '', title: label, onclick: e => {
            $$('button', el).forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); onchange(val)
        } }, ic ? icon(ic, 16) : label)
    }))
    return el
}
export function slider({ min, max, step = 1, value, onchange, fmt = v => v }) {
    const out = h('output', fmt(value))
    const input = h('input', { type: 'range', min, max, step, value, oninput: () => { out.textContent = fmt(+input.value); onchange(+input.value) } })
    return h('div.slider', input, out)
}
export const toggle = (value, onchange) => {
    const input = h('input', { type: 'checkbox', checked: !!value, onchange: () => onchange(input.checked) })
    return h('label.switch', input, h('i'))
}
export const row = (label, control, hint) => h('div.row', h('div.row-label', h('span', label), hint ? h('small', hint) : null), h('div.row-ctl', control))
export const select = (options, value, onchange) => {
    const el = h('select', { onchange: () => onchange(el.value) }, options.map(o => {
        const [val, label] = Array.isArray(o) ? o : [o, o]
        return h('option', { value: val, selected: val === value }, label)
    }))
    return el
}
