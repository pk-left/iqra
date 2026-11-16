// The reader: opens a book in the reading engine and adds everything around it
// (contents, search, highlights, notes, bookmarks, lookup, translate, read aloud, speed reading, themes).
import '../vendor/foliate-js/view.js'
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import * as CFI from '../vendor/foliate-js/epubcfi.js'
import { FootnoteHandler } from '../vendor/foliate-js/footnotes.js'
import { h, $, $$, icon, iconBtn, menuAt, modal, toast, promptBox, debounce, clamp, uid, fmtDuration, fmtDate, esc, toggle, row } from './ui.js'
import { data, db } from './db.js'
import { lib } from './store.js'
import { openBook, FIXED } from './formats.js'
import { S, resolveReaderTheme, readerControls, HIGHLIGHTS, BUNDLED_FONTS, LANGS, KEY_ACTIONS, isDark, setOverlay, applyAppTheme } from './settings.js'
import { tracker, pace } from './stats.js'

const api = window.api
let current = null
export const readerOpen = () => !!current
export const currentReader = () => current
export async function openReader(id, onClose) {
    await closeReader()
    current = new Reader(id, onClose)
    await current.open()
    return current
}
export async function closeReader() {
    const r = current
    current = null
    await r?.destroy()
}

const FONT_FILES = { 'Literata': 'literata', 'Merriweather': 'merriweather', 'Lora': 'lora', 'Inter': 'inter', 'Atkinson Hyperlegible': 'atkinson-hyperlegible', 'OpenDyslexic': 'opendyslexic', 'JetBrains Mono': 'jetbrains-mono' }
function fontFaces(family) {
    const slug = FONT_FILES[family]
    if (!slug) return ''
    return [[400, 'normal'], [400, 'italic'], [700, 'normal'], [700, 'italic']].map(([w, s]) =>
        `@font-face{font-family:"${family}";font-weight:${w};font-style:${s};font-display:swap;src:url("app://iqra/fonts/${slug}-latin-${w}-${s}.woff2") format("woff2")}`).join('\n')
}
function getCSS(r, theme) {
    const generic = BUNDLED_FONTS.find(f => f[0] === r.font)?.[2] ?? 'serif'
    const family = `"${r.font}", ${generic}`
    const imp = r.overrideColors ? ' !important' : ''
    return `
@namespace epub "http://www.idpf.org/2007/ops";
${fontFaces(r.font)}
html { color-scheme: ${theme.dark ? 'dark' : 'light'}; color: ${theme.fg}${imp}; background: ${theme.bg}${imp}; font-size: ${r.fontSize}px !important; }
body { font-family: ${family} !important; font-weight: ${r.weight}; letter-spacing: ${r.letterSpacing}em; word-spacing: ${r.wordSpacing}em; ${r.overrideColors ? `color: ${theme.fg} !important; background: transparent !important;` : ''} }
${r.overrideFonts ? `body *:not(pre):not(code):not(kbd):not(samp):not(tt) { font-family: ${family} !important; }` : ''}
${r.overrideColors ? `body *:not(a):not(mark) { color: inherit !important; background-color: transparent !important; border-color: color-mix(in srgb, currentColor 30%, transparent) !important; }` : ''}
a:any-link { color: ${theme.link}${imp}; }
p, li, blockquote, dd, div { line-height: ${r.lineHeight} !important; }
p, li, blockquote, dd { text-align: ${r.justify ? 'justify' : 'start'}${r.justify ? '' : ' !important'}; hyphens: ${r.hyphenate ? 'auto' : 'manual'}; -webkit-hyphens: ${r.hyphenate ? 'auto' : 'manual'}; hyphenate-limit-chars: 6 3 2; widows: 2; orphans: 2; }
[align="left"] { text-align: left; } [align="right"] { text-align: right; } [align="center"] { text-align: center; }
${r.paraSpacing >= 0 ? `p { margin-top: 0 !important; margin-bottom: ${r.paraSpacing}em !important; }` : ''}
${r.indent >= 0 ? `p { text-indent: ${r.indent}em !important; }` : ''}
pre { white-space: pre-wrap !important; }
${theme.dark && r.dimImages ? 'img, svg image { filter: brightness(.8) contrast(1.05); }' : ''}
::selection { background: color-mix(in srgb, ${theme.link} 32%, transparent); }
::highlight(ink-tts) { background-color: color-mix(in srgb, ${theme.link} 34%, transparent); }
${r.customCSS ?? ''}
`
}

const keyOf = e => (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey && (e.key.length > 1 || e.key === ' ') ? 'Shift+' : '') + (e.key.length === 1 ? e.key.toLowerCase() : e.key)

class Reader {
    constructor(id, onClose) {
        this.id = id; this.onClose = onClose
        this.docs = new Map()
        this.relocs = 0
        this.sideTab = 'toc'
        this.perBook = !!data.settings.perBook?.[id]
        this.onKey = this.onKey.bind(this)
        this.saveProgress = debounce(() => this.#save(), 700)
    }
    get rec() { return lib.get(this.id) }
    get r() { return this.perBook ? S.readerFor(this.id) : S.reader }
    get ann() { return data.annotations[this.id] ?? {} }
    get scrolled() { return !this.fixed && this.r.flow === 'scrolled' }

    // ---------- DOM ----------
    build() {
        const root = this.root = $('#reader')
        root.hidden = false
        root.className = 'rd'
        this.titleEl = h('div.rd-title', h('b', this.rec.title), h('span'))
        this.bmBtn = iconBtn('bookmark', 'Bookmark this page (B)', () => this.toggleBookmark())
        this.top = h('div.rd-top',
            iconBtn('arrow-left', 'Back to library (Esc)', () => this.close()),
            iconBtn('list', 'Contents, notes and bookmarks (T)', () => this.toggleSide('toc')),
            this.titleEl,
            iconBtn('search', 'Search in book (Ctrl+F)', () => this.toggleSide('search')),
            this.bmBtn,
            iconBtn('volume-2', 'Read aloud (R)', () => this.tts.toggle()),
            iconBtn('zap', 'Speed reading (Ctrl+R)', () => this.speedRead()),
            iconBtn('type', 'Reading settings (S)', () => this.toggleSettings()),
            iconBtn('maximize', 'Full screen (F11)', () => api.invoke('win:fullscreen')),
            iconBtn('ellipsis', 'More', e => this.moreMenu(e.currentTarget)))
        this.side = h('aside.rd-side', { hidden: true })
        this.settingsEl = h('aside.rd-settings', { hidden: true })
        this.dim = h('div.rd-dim'); this.warm = h('div.rd-warm')
        this.rulerEl = h('div.rd-ruler', { hidden: true }, h('i'), h('i'))
        this.loading = h('div.rd-loading', h('div.spinner'), h('p', 'Opening book…'))
        this.stage = h('div.rd-stage', this.loading, this.dim, this.warm, this.rulerEl,
            h('button.rd-nav.left', { title: 'Previous page', onclick: () => this.view?.goLeft() }, icon('chevron-left', 22)),
            h('button.rd-nav.right', { title: 'Next page', onclick: () => this.view?.goRight() }, icon('chevron-right', 22)))
        this.slider = h('input', { type: 'range', min: 0, max: 1, step: 'any', value: 0,
            oninput: () => { this.tip.textContent = `${Math.round(this.slider.value * 100)}%`; this.tip.hidden = false },
            onchange: () => { this.tip.hidden = true; this.view?.goToFraction(parseFloat(this.slider.value)) } })
        this.tip = h('span.rd-tip', { hidden: true })
        this.footL = h('span.rd-chapter'); this.footR = h('button.rd-pos', { title: 'Go to page or percent', onclick: () => this.goToPrompt() })
        this.clock = h('span.rd-clock')
        this.bottom = h('div.rd-bottom', this.footL, h('div.rd-slider', this.slider, this.tip), this.footR, this.clock)
        this.popups = h('div.rd-popups')
        root.replaceChildren(this.top, h('div.rd-body', this.side, this.stage, this.settingsEl), this.bottom, this.popups)
        this.stage.addEventListener('wheel', e => this.onWheel(e), { passive: false })
        this.stage.addEventListener('mousemove', e => this.onMouse(e.clientX, e.clientY))
        root.addEventListener('mousemove', e => this.edgeReveal(e.clientY))
        document.addEventListener('keydown', this.onKey)
        const t0 = resolveReaderTheme(this.r)
        root.style.setProperty('--rd-bg', t0.bg); root.style.setProperty('--rd-fg', t0.fg); root.style.setProperty('--rd-link', t0.link)
        root.dataset.dark = t0.dark ? '1' : ''
        setOverlay(t0.bg, !!t0.dark)
        this.clockTimer = setInterval(() => this.tickClock(), 20000)
        this.tickClock()
    }
    tickClock() { this.clock.textContent = this.r.showClock ? new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '' }

    async open() {
        const rec = this.rec
        this.build()
        api.invoke('win:title', `${rec.title} - Iqra`)
        if (rec.missing) return this.showError(new Error('FILE_MISSING'))
        try {
            this.book = await openBook(rec)
        } catch (e) { console.error(e); return this.showError(e) }
        if (current !== this) return this.book.destroy?.()
        const book = this.book
        this.fixed = book.rendition?.layout === 'pre-paginated'
        this.root.classList.toggle('fixed', this.fixed)
        if (this.fixed && this.r.pdfSpread === 'none') book.rendition.spread = 'none'
        const view = this.view = document.createElement('foliate-view')
        view.setAttribute('autohide-cursor', '')
        this.stage.prepend(view)
        try { await view.open(book) } catch (e) { console.error(e); return this.showError(e) }
        view.addEventListener('load', e => this.onLoad(e.detail))
        view.addEventListener('relocate', e => this.onRelocate(e.detail))
        view.addEventListener('external-link', e => { e.preventDefault(); api.invoke('shell:open', e.detail.href_ ?? e.detail.a?.href) })
        view.addEventListener('create-overlay', e => this.drawSection(e.detail.index))
        view.addEventListener('draw-annotation', e => {
            const { draw, annotation } = e.detail
            const fn = Overlayer[annotation.style] ?? Overlayer.highlight
            draw(fn, { color: HIGHLIGHTS[annotation.color] ?? annotation.color ?? HIGHLIGHTS.yellow, width: 2 })
        })
        view.addEventListener('show-annotation', e => this.showAnnotation(e.detail))
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            detail.data = Promise.resolve(detail.data).catch(err => { console.warn('resource failed', detail.name, err); return '' })
        })
        // footnotes open in a small popup instead of jumping away
        this.footnotes = new FootnoteHandler()
        this.footnotes.addEventListener('before-render', e => e.detail.view.renderer.setStyles?.(getCSS({ ...this.r, fontSize: Math.max(13, this.r.fontSize - 2) }, resolveReaderTheme(this.r))))
        this.footnotes.addEventListener('render', e => this.showFootnote(e.detail))
        view.addEventListener('link', e => {
            if (this.fixed) return
            try { this.footnotes.handle(book, e)?.catch(err => { console.warn(err); view.goTo(e.detail.href) }) } catch { /* plain link */ }
        })
        this.applySettings()
        this.unsub = db.onChange(name => { if (name === 'settings' && current === this) this.applySettings() })
        try {
            await view.init({ lastLocation: rec.location || null })
        } catch (e) { console.warn('could not restore position', e); await view.renderer.next?.() }
        this.loading.remove()
        tracker.start(this.id)
        const meta = book.metadata ?? {}
        if (!rec.pages && this.fixed) lib.update(this.id, { pages: book.sections.length })
        this.lang = (Array.isArray(meta.language) ? meta.language[0] : meta.language) || rec.language || 'en'
        this.renderSide()
    }

    showError(e) {
        const msg = String(e?.message ?? e)
        const missing = /FILE_MISSING|404/.test(msg)
        const rec = this.rec
        this.loading?.remove()
        this.stage.prepend(h('div.rd-error', icon('info', 40),
            h('h2', missing ? 'This file has moved or been deleted' : 'This book could not be opened'),
            h('p', missing ? rec.path : 'The file may be damaged, copy-protected (DRM), or in a format variation Iqra does not understand yet.'),
            missing ? null : h('p.muted.small', msg),
            h('div.actions', h('button.btn.primary', { onclick: () => this.close() }, 'Back to library'),
                missing ? null : h('button.btn', { onclick: () => api.invoke('shell:show', rec.path) }, 'Show in folder'))))
        if (missing && !rec.missing) lib.update(this.id, { missing: true })
    }

    // ---------- settings ----------
    applySettings() {
        const view = this.view
        if (!view?.renderer) return
        const r = this.r, theme = resolveReaderTheme(r), rn = view.renderer
        this.theme = theme
        const root = this.root
        root.style.setProperty('--rd-bg', theme.bg); root.style.setProperty('--rd-fg', theme.fg); root.style.setProperty('--rd-link', theme.link)
        root.dataset.dark = theme.dark ? '1' : ''
        setOverlay(theme.bg, !!theme.dark)
        if (this.fixed) {
            rn.setAttribute('zoom', r.pdfZoom)
            view.style.filter = r.pdfTheme && theme.dark ? 'invert(0.9) hue-rotate(180deg)' : ''
            this.stage.style.background = r.pdfTheme ? theme.bg : (theme.dark ? '#1e1f22' : '#e9e7e2')
        } else {
            rn.setAttribute('flow', r.flow)
            rn.setAttribute('gap', r.gap + '%')
            rn.setAttribute('margin', r.margin + 'px')
            rn.setAttribute('max-inline-size', r.maxWidth + 'px')
            rn.setAttribute('max-column-count', String(r.columns))
            r.animated ? rn.setAttribute('animated', '') : rn.removeAttribute('animated')
            rn.setStyles?.(getCSS(r, theme))
            this.stage.style.background = theme.bg
        }
        this.dim.style.opacity = String((100 - r.brightness) / 100 * 0.85)
        this.warm.style.opacity = String(r.warmth / 100)
        this.rulerEl.hidden = !r.ruler
        this.rulerEl.style.setProperty('--rh', `${Math.round(r.rulerHeight * r.fontSize * r.lineHeight)}px`)
        root.classList.toggle('autohide', !!r.autoHideBars)
        this.tickClock()
        if (this.loc) this.updateFooter()
    }
    setSetting(k, v) {
        if (this.perBook) db.set('settings', ['perBook', this.id, k], v)
        else S.setReader(k, v)
        this.applySettings()
        if (k === 'pdfSpread') toast('Reopen the book to change the page spread')
    }
    toggleSettings(force) {
        const show = force ?? this.settingsEl.hidden
        this.settingsEl.hidden = !show
        if (!show) return
        const draw = () => this.settingsEl.replaceChildren(
            h('header', h('h3', 'Reading settings'), iconBtn('x', 'Close', () => this.toggleSettings(false))),
            row('Only for this book', toggle(this.perBook, v => {
                this.perBook = v
                if (!v) db.set('settings', ['perBook', this.id], null)
                else db.set('settings', ['perBook', this.id], { ...S.reader })
                this.applySettings(); draw()
            }), this.perBook ? 'Changes below stay with this book' : 'Changes below apply to every book'),
            readerControls(() => this.r, (k, v) => this.setSetting(k, v), { fixed: this.fixed, tab: this.settingsTab ?? (this.fixed ? 'layout' : 'text'), onTab: t => this.settingsTab = t }),
            this.fixed ? row('Two pages side by side', toggle(this.r.pdfSpread !== 'none', v => this.setSetting('pdfSpread', v ? 'auto' : 'none')), 'When the window is wide') : '')
        draw()
    }

    // ---------- events from book pages ----------
    onLoad({ doc, index }) {
        this.docs.set(doc, index)
        doc.addEventListener('keydown', this.onKey)
        doc.addEventListener('pointerdown', () => { this.hidePopups(); tracker.activity() })
        doc.addEventListener('pointerup', () => setTimeout(() => this.checkSelection(doc, index), 20))
        doc.addEventListener('click', e => this.onDocClick(e, doc))
        doc.addEventListener('wheel', e => this.onWheel(e), { passive: false })
        doc.addEventListener('mousemove', e => { const p = this.toScreen(doc, e.clientX, e.clientY); this.onMouse(p.x, p.y); this.edgeReveal(p.y) })
        doc.addEventListener('dblclick', e => { if (e.target.closest?.('img, svg')) this.zoomImage(e.target.closest('img, svg')) })
    }
    frameOf(doc) { return doc.defaultView?.frameElement }
    toScreen(doc, x, y) {
        const frame = this.frameOf(doc)
        if (!frame) return { x, y, sx: 1, sy: 1 }
        const fr = frame.getBoundingClientRect()
        const sx = fr.width / (frame.offsetWidth || fr.width) || 1, sy = fr.height / (frame.offsetHeight || fr.height) || 1
        return { x: fr.left + x * sx, y: fr.top + y * sy, sx, sy }
    }
    rangeRect(range) {
        const doc = range.startContainer.ownerDocument
        const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
        const b = rects.length ? { left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)), top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)) } : range.getBoundingClientRect()
        const a = this.toScreen(doc, b.left, b.top), c = this.toScreen(doc, b.right, b.bottom)
        return { left: a.x, top: a.y, right: c.x, bottom: c.y }
    }
    onMouse(x, y) {
        tracker.activity()
        if (!this.rulerEl.hidden) {
            const sr = this.stage.getBoundingClientRect()
            this.rulerEl.style.setProperty('--ry', `${y - sr.top}px`)
        }
    }
    edgeReveal(y) {
        if (!this.root.classList.contains('autohide')) return
        const hgt = innerHeight
        const near = y < 56 || y > hgt - 64
        this.root.classList.toggle('bars-show', near || this.barsPinned)
    }
    toggleBars() {
        if (!this.root.classList.contains('autohide')) return
        this.barsPinned = !this.barsPinned
        this.root.classList.toggle('bars-show', this.barsPinned)
    }
    onDocClick(e, doc) {
        if (e.target.closest?.('a[href]')) return
        const sel = doc.getSelection?.()
        if (sel && !sel.isCollapsed) return
        if (this.popups.childElementCount) return this.hidePopups()
        const ov = this.view.renderer.getContents().find(c => c.doc === doc)?.overlayer
        try { if (ov?.hitTest(e)?.[0]) return } catch { /* no overlay */ }
        const p = this.toScreen(doc, e.clientX, e.clientY)
        const sr = this.stage.getBoundingClientRect()
        const rel = (p.x - sr.left) / sr.width
        if (this.r.clickZones && !this.scrolled && rel < 0.28) this.view.goLeft()
        else if (this.r.clickZones && !this.scrolled && rel > 0.72) this.view.goRight()
        else this.toggleBars()
    }
    onWheel(e) {
        if (e.ctrlKey) {
            e.preventDefault()
            if (Date.now() - (this.lastZoom ?? 0) < 120) return
            this.lastZoom = Date.now()
            return this.act(e.deltaY < 0 ? 'fontUp' : 'fontDown')
        }
        if (this.scrolled || !this.r.wheelTurn) return
        if (this.fixed && this.r.pdfZoom !== 'fit-page') return
        e.preventDefault()
        if (Math.abs(e.deltaY) < 4 || Date.now() - (this.lastWheel ?? 0) < 220) return
        this.lastWheel = Date.now()
        e.deltaY > 0 ? this.view.next() : this.view.prev()
    }
    onKey(e) {
        if (current !== this) return
        const t = e.target
        if (t?.closest?.('input, textarea, select, .modal, [contenteditable]')) {
            if (e.key === 'Escape' && t.closest('.rd')) { t.blur(); this.hidePopups() }
            return
        }
        if ($('.modal-back')) return
        if (this.speed) return this.speed.key(e)
        const k = keyOf(e)
        const keys = S.keys
        const action = Object.keys(keys).find(a => keys[a]?.includes(k))
        if (!action) return
        if (this.scrolled && (k === ' ' || k === 'Shift+ ')) return
        e.preventDefault()
        this.act(action)
    }
    act(action) {
        const v = this.view
        tracker.activity()
        switch (action) {
            case 'next': return v?.next()
            case 'prev': return v?.prev()
            case 'nextSection': return v?.renderer.nextSection ? v.renderer.nextSection() : v?.next()
            case 'prevSection': return v?.renderer.prevSection ? v.renderer.prevSection() : v?.prev()
            case 'back':
                if (this.popups.childElementCount) return this.hidePopups()
                if (!this.settingsEl.hidden) return this.toggleSettings(false)
                if (!this.side.hidden) return this.toggleSide()
                if (this.isFull) return api.invoke('win:fullscreen', false)
                return this.close()
            case 'toc': return this.toggleSide('toc')
            case 'search': return this.toggleSide('search', true)
            case 'bookmark': return this.toggleBookmark()
            case 'settings': return this.toggleSettings()
            case 'fullscreen': return api.invoke('win:fullscreen')
            case 'tts': return this.tts.toggle()
            case 'fontUp': return this.fixed ? this.zoomBy(1.15) : this.setSetting('fontSize', clamp(this.r.fontSize + 1, 10, 40))
            case 'fontDown': return this.fixed ? this.zoomBy(1 / 1.15) : this.setSetting('fontSize', clamp(this.r.fontSize - 1, 10, 40))
            case 'flow': return this.fixed ? null : this.setSetting('flow', this.r.flow === 'paginated' ? 'scrolled' : 'paginated')
            case 'theme': {
                const list = S.themes, r = this.r
                const key = r.followApp ? (isDark() ? 'darkTheme' : 'lightTheme') : 'theme'
                const pool = r.followApp ? list.filter(t => !!t.dark === isDark()) : list
                const i = pool.findIndex(t => t.id === r[key])
                this.setSetting(key, pool[(i + 1) % pool.length].id)
                return toast(`Theme: ${pool[(i + 1) % pool.length].name}`, { ms: 1200 })
            }
            case 'historyBack': return v?.history.back()
            case 'speed': return this.speedRead()
            case 'ruler': return this.setSetting('ruler', !this.r.ruler)
            case 'bars': return this.toggleBars()
        }
    }
    zoomBy(f) {
        const z = this.r.pdfZoom
        const cur = isNaN(parseFloat(z)) ? 1 : parseFloat(z)
        this.setSetting('pdfZoom', String(clamp(Math.round(cur * f * 100) / 100, 0.4, 5)))
    }

    // ---------- progress ----------
    onRelocate(detail) {
        const prev = this.loc
        this.loc = detail
        this.relocs++
        const { fraction, tocItem, section, location } = detail
        if (prev) tracker.progress(this.fixed ? (section?.current ?? 0) - (prev.section?.current ?? 0) : (location?.current ?? 0) - (prev.location?.current ?? 0))
        tracker.activity()
        if (document.activeElement !== this.slider) this.slider.value = fraction ?? 0
        this.titleEl.lastChild.textContent = tocItem?.label ?? ''
        this.updateFooter()
        this.updateBookmarkBtn()
        if (this.sideTab === 'toc' && !this.side.hidden) this.markTOC()
        this.saveProgress()
    }
    updateFooter() {
        const d = this.loc, r = this.r
        if (!d) return
        const pct = `${Math.round((d.fraction ?? 0) * 100)}%`
        const page = this.fixed ? `Page ${(d.section?.current ?? 0) + 1} of ${d.section?.total ?? '?'}` : `${(d.location?.current ?? 0) + 1} of ${d.location?.total ?? '?'}`
        const leftLoc = Math.max(0, (d.location?.total ?? 0) - (d.location?.current ?? 0))
        const mins = this.fixed ? ((d.section?.total ?? 0) - (d.section?.current ?? 0) - 1) / pace() : leftLoc / pace()
        const chapMins = (d.time?.section ?? 0) * (1.07 / pace())
        const text = { percent: pct, page, time: `${fmtDuration(mins * 60, true)} left in book`, chapter: this.fixed ? page : `${fmtDuration(chapMins * 60, true)} left in chapter`, none: '' }[r.footer] ?? pct
        this.footR.textContent = text
        this.footR.title = `${pct} · ${page} · about ${fmtDuration(mins * 60, true)} left. Click to jump.`
        this.footL.textContent = d.tocItem?.label ?? ''
    }
    #save() {
        const d = this.loc, rec = this.rec
        if (!d || !rec) return
        const fraction = this.fixed ? ((d.section?.current ?? 0) + 1) / Math.max(1, d.section?.total ?? 1) : (d.fraction ?? 0)
        const patch = { progress: fraction, location: d.cfi, lastReadAt: Date.now() }
        const atEnd = fraction >= 0.995
        if (atEnd && rec.status !== 'finished' && this.relocs > 1) {
            lib.update(this.id, patch)
            lib.setStatus(this.id, 'finished')
            if (rec.kind !== 'document') toast(`Finished “${rec.title}”`, { ms: 4000 })
            return
        }
        if (rec.status === 'unread' && this.relocs > 1) patch.status = 'reading'
        if (rec.status === 'finished') delete patch.progress
        lib.update(this.id, patch)
    }
    async goToPrompt() {
        const d = this.loc
        const total = this.fixed ? d?.section?.total : null
        const v = await promptBox('Go to', total ? `Page number (1 to ${total}) or a percentage like 40%` : 'Percentage (0 to 100)', '')
        if (v == null || !v.trim()) return
        const n = parseFloat(v)
        if (isNaN(n)) return
        if (total && !v.includes('%')) this.view.goTo(clamp(Math.round(n) - 1, 0, total - 1))
        else this.view.goToFraction(clamp(n / 100, 0, 1))
    }

    // ---------- side panel: contents / notes / bookmarks / search ----------
    toggleSide(tab, focus) {
        const same = !this.side.hidden && (!tab || tab === this.sideTab)
        if (same && !focus) { this.side.hidden = true; return }
        if (tab) this.sideTab = tab
        this.side.hidden = false
        this.renderSide()
        if (this.sideTab === 'search') setTimeout(() => $('input', this.side)?.focus(), 30)
    }
    renderSide() {
        if (!this.side || this.side.hidden) return
        const tabs = [['toc', 'Contents'], ['notes', 'Highlights'], ['bookmarks', 'Bookmarks'], ['search', 'Search']]
        const body = h('div.side-body')
        this.side.replaceChildren(
            h('div.seg.tabs', tabs.map(([id, label]) => h('button', { class: id === this.sideTab ? 'on' : '', onclick: () => { this.sideTab = id; this.renderSide() } }, label))),
            body)
        if (this.sideTab === 'toc') {
            const toc = this.book?.toc ?? []
            const build = (items, depth) => items.map(it => [
                h('a.toc-item', { dataset: { href: it.href ?? '' }, style: { paddingLeft: `${10 + depth * 14}px` }, onclick: () => it.href != null && this.view.goTo(it.href) }, (it.label ?? '').trim() || 'Untitled'),
                it.subitems?.length ? build(it.subitems, depth + 1) : null])
            body.append(...(toc.length ? build(toc, 0).flat(Infinity).filter(Boolean) : [h('p.muted', this.fixed ? `This file has no table of contents. Use the slider or click the page number to jump.` : 'This book has no table of contents.')]))
            this.markTOC()
        } else if (this.sideTab === 'notes') this.renderNotes(body)
        else if (this.sideTab === 'bookmarks') this.renderBookmarks(body)
        else this.renderSearch(body)
    }
    markTOC() {
        const href = this.loc?.tocItem?.href
        let on
        $$('.toc-item', this.side).forEach(a => { const m = href != null && a.dataset.href === String(href); a.classList.toggle('on', m); if (m) on = a })
        on?.scrollIntoView({ block: 'nearest' })
    }
    sortedHighlights() {
        return Object.values(this.ann.highlights ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || (() => { try { return CFI.compare(a.value, b.value) } catch { return 0 } })())
    }
    renderNotes(body) {
        const list = this.sortedHighlights()
        if (this.fixed) body.append(h('p.muted.small', 'Highlighting works in reflowable books (EPUB, MOBI, FB2, TXT, DOCX). In PDFs and comics you can still select text to copy, define or translate it, and add bookmarks.'))
        if (!list.length) return body.append(h('p.muted', 'Select text in the book and pick a color to highlight it. Your highlights and notes collect here.'))
        body.append(h('div.side-actions', h('button.btn.small', { onclick: () => this.exportNotes() }, icon('download', 14), ' Export')))
        for (const a of list) body.append(h('div.note', { style: { '--c': HIGHLIGHTS[a.color] ?? a.color }, onclick: () => this.view.goTo(a.value) },
            a.chapter ? h('small', a.chapter) : null, h('q', a.text?.slice(0, 400)), a.note ? h('p', a.note) : null,
            h('div.note-actions', iconBtn('pencil', 'Edit note', e => { e.stopPropagation(); this.editNote(a.id) }), iconBtn('trash-2', 'Delete', e => { e.stopPropagation(); this.deleteHighlight(a.id) }))))
    }
    renderBookmarks(body) {
        const list = Object.values(this.ann.bookmarks ?? {}).sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
        if (!list.length) return body.append(h('p.muted', 'Press B or the bookmark button to mark a page.'))
        for (const b of list) body.append(h('div.note', { onclick: () => this.view.goTo(b.cfi) }, h('small', `${Math.round((b.fraction ?? 0) * 100)}% · ${fmtDate(b.created)}`), h('p', b.label || 'Bookmark'),
            h('div.note-actions', iconBtn('trash-2', 'Delete', e => { e.stopPropagation(); db.set('annotations', [this.id, 'bookmarks', b.id], null); this.renderSide(); this.updateBookmarkBtn() }))))
    }
    renderSearch(body) {
        const results = h('div.results')
        const status = h('p.muted.small')
        const input = h('input', { type: 'search', placeholder: 'Find in this book…', value: this.lastQuery ?? '' })
        const run = async () => {
            const query = input.value.trim()
            this.lastQuery = query
            const token = this.searchToken = uid()
            results.replaceChildren(); this.view.clearSearch()
            if (!query) { status.textContent = ''; return }
            let count = 0
            if (this.book.getPageText) {
                // PDFs: search the text of each page
                const q = query.toLowerCase(), n = this.book.sections.length
                this.pageTexts ??= []
                for (let i = 0; i < n && count < 500; i++) {
                    if (this.searchToken !== token || current !== this) return
                    let text
                    try { text = (this.pageTexts[i] ??= await this.book.getPageText(i)) } catch { continue }
                    const low = text.toLowerCase()
                    for (let pos = low.indexOf(q), per = 0; pos !== -1 && per < 4; pos = low.indexOf(q, pos + q.length), per++) {
                        count++
                        results.append(h('a.result', { onclick: () => this.view.goTo(i) }, h('b', `p. ${i + 1}  `), text.slice(Math.max(0, pos - 40), pos), h('mark', text.slice(pos, pos + q.length)), text.slice(pos + q.length, pos + q.length + 70)))
                    }
                    if (i % 8 === 0) { status.textContent = `Searching… page ${i + 1} of ${n}`; await new Promise(r => setTimeout(r)) }
                }
                status.textContent = count ? `${count}${count >= 500 ? '+' : ''} result${count === 1 ? '' : 's'}` : 'No results (scanned pages without a text layer cannot be searched)'
                return
            }
            status.textContent = 'Searching…'
            try {
                for await (const res of this.view.search({ query, matchDiacritics: false, matchCase: false, drawOptions: { color: this.theme?.link } })) {
                    if (this.searchToken !== token) return
                    if (res === 'done') break
                    if (res.progress != null) { status.textContent = `Searching… ${Math.round(res.progress * 100)}%`; continue }
                    const items = res.subitems ?? [res]
                    if (res.label) results.append(h('h4', res.label))
                    for (const it of items) {
                        if (!it.cfi) continue
                        count++
                        if (count > 600) continue
                        const ex = it.excerpt ?? {}
                        results.append(h('a.result', { onclick: () => this.view.goTo(it.cfi) }, ex.pre ?? '', h('mark', ex.match ?? ''), ex.post ?? ''))
                    }
                }
                status.textContent = count ? `${count} result${count === 1 ? '' : 's'}${count > 600 ? ' (showing the first 600)' : ''}` : 'No results'
            } catch (e) { console.warn(e); status.textContent = this.fixed ? 'Search is not available for this file.' : 'Search failed.' }
        }
        input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); e.stopPropagation() })
        input.addEventListener('search', () => { if (!input.value) run() })
        body.append(h('div.searchbox', input, iconBtn('search', 'Search', run)), status, results)
        if (this.fixed && this.rec.format !== 'pdf') status.textContent = 'These pages are images, so there is no text to search.'
    }

    // ---------- highlights ----------
    drawSection(index) {
        for (const a of Object.values(this.ann.highlights ?? {})) {
            if (a.index === index) this.view.addAnnotation(a).catch?.(() => {})
        }
    }
    checkSelection(doc, index) {
        const sel = doc.getSelection?.()
        if (!sel || sel.isCollapsed || !sel.rangeCount) return
        const text = sel.toString().trim()
        if (!text) return
        this.showSelection(sel.getRangeAt(0).cloneRange(), index, text)
    }
    place(el, rect, below) {
        this.popups.append(el)
        const b = el.getBoundingClientRect()
        let top = rect.top - b.height - 10
        if (below || top < 50) top = Math.min(innerHeight - b.height - 10, rect.bottom + 10)
        el.style.top = `${Math.max(8, top)}px`
        el.style.left = `${clamp((rect.left + rect.right) / 2 - b.width / 2, 8, innerWidth - b.width - 8)}px`
    }
    hidePopups() { this.popups.replaceChildren() }
    showSelection(range, index, text) {
        this.hidePopups()
        const rect = this.rangeRect(range)
        const canMark = !this.fixed
        const mark = color => {
            const a = { id: uid(), value: this.view.getCFI(index, range), color, style: this.r.highlightStyle, text: text.slice(0, 2000), note: '', created: Date.now(), index, chapter: this.loc?.tocItem?.label ?? '' }
            db.set('annotations', [this.id, 'highlights', a.id], a)
            S.setReader('highlightColor', color)
            this.view.addAnnotation(a)
            this.view.deselect(); this.hidePopups()
            if (!this.side.hidden) this.renderSide()
            return a
        }
        const bar = h('div.sel-bar',
            canMark ? Object.entries(HIGHLIGHTS).map(([name, c]) => h('button.dot', { title: `Highlight ${name}`, style: { background: c }, onclick: () => mark(name) })) : null,
            canMark ? h('button.txt', { title: 'Highlight style', onclick: e => menuAt(e.currentTarget, ['highlight', 'underline', 'squiggly', 'strikethrough'].map(s => ({ label: s[0].toUpperCase() + s.slice(1), icon: this.r.highlightStyle === s ? 'check' : null, run: () => S.setReader('highlightStyle', s) }))) }, icon('highlighter', 16)) : null,
            canMark ? h('button.txt', { title: 'Highlight and add a note', onclick: () => { const a = mark(this.r.highlightColor); this.editNote(a.id) } }, icon('notebook-pen', 16), 'Note') : null,
            h('button.txt', { title: 'Copy', onclick: () => { navigator.clipboard.writeText(text); toast('Copied', { ms: 1000 }); this.hidePopups() } }, icon('copy', 16)),
            h('button.txt', { onclick: () => this.lookup(text, rect, 'define') }, icon('book', 16), 'Define'),
            h('button.txt', { onclick: () => this.lookup(text, rect, 'translate') }, icon('languages', 16), 'Translate'),
            h('button.txt', { title: 'Wikipedia', onclick: () => this.lookup(text, rect, 'wiki') }, icon('globe', 16)),
            h('button.txt', { title: 'Read aloud from here', onclick: () => { this.hidePopups(); this.tts.start(range) } }, icon('volume-2', 16)),
            h('button.txt', { title: 'Search the book for this', onclick: () => { this.hidePopups(); this.lastQuery = text.slice(0, 80); this.toggleSide('search', true); setTimeout(() => $('.searchbox .icon-btn', this.side)?.click(), 60) } }, icon('search', 16)))
        this.place(bar, rect)
    }
    showAnnotation({ value, range }) {
        const a = Object.values(this.ann.highlights ?? {}).find(x => x.value === value)
        if (!a) return
        this.hidePopups()
        const set = (k, v) => { db.set('annotations', [this.id, 'highlights', a.id, k], v); this.view.addAnnotation({ ...a, [k]: v }); this.hidePopups(); if (!this.side.hidden) this.renderSide() }
        const bar = h('div.sel-bar', { class: a.note ? 'with-note' : '' },
            a.note ? h('p.note-text', a.note) : null,
            h('div.sel-row',
                Object.entries(HIGHLIGHTS).map(([name, c]) => h('button.dot', { class: a.color === name ? 'on' : '', style: { background: c }, onclick: () => set('color', name) })),
                h('button.txt', { onclick: () => this.editNote(a.id) }, icon('notebook-pen', 16), a.note ? 'Edit note' : 'Add note'),
                h('button.txt', { title: 'Copy', onclick: () => { navigator.clipboard.writeText(a.text); toast('Copied', { ms: 1000 }); this.hidePopups() } }, icon('copy', 16)),
                h('button.txt', { title: 'Delete highlight', onclick: () => this.deleteHighlight(a.id) }, icon('trash-2', 16))))
        this.place(bar, this.rangeRect(range))
    }
    async editNote(id) {
        this.hidePopups()
        const a = this.ann.highlights?.[id]
        if (!a) return
        const note = await promptBox('Note', `“${a.text.slice(0, 140)}${a.text.length > 140 ? '…' : ''}”`, a.note ?? '', true)
        if (note == null) return
        db.set('annotations', [this.id, 'highlights', id, 'note'], note.trim())
        if (!this.side.hidden) this.renderSide()
    }
    deleteHighlight(id) {
        const a = this.ann.highlights?.[id]
        if (!a) return
        this.view.deleteAnnotation(a)
        db.set('annotations', [this.id, 'highlights', id], null)
        this.hidePopups()
        if (!this.side.hidden) this.renderSide()
    }
    async exportNotes() {
        const rec = this.rec, list = this.sortedHighlights()
        let md = `# ${rec.title}\n${rec.author ? `*${rec.author}*\n` : ''}\n`
        let chapter = null
        for (const a of list) {
            if (a.chapter !== chapter) { chapter = a.chapter; if (chapter) md += `\n## ${chapter}\n\n` }
            md += `> ${a.text.replace(/\n+/g, ' ')}\n\n`
            if (a.note) md += `${a.note}\n\n`
        }
        const p = await api.invoke('dialog:save', { title: 'Export highlights', defaultPath: `${rec.title.replace(/[<>:"/\\|?*]/g, ' ').slice(0, 80)} - highlights.md`, filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }] }, md)
        if (p) toast('Highlights exported')
    }

    // ---------- bookmarks ----------
    bookmarkKey(d = this.loc) { return d ? (this.fixed ? `p${d.section?.current}` : `l${d.location?.current}`) : null }
    currentBookmark() { const k = this.bookmarkKey(); return Object.values(this.ann.bookmarks ?? {}).find(b => b.key === k) }
    updateBookmarkBtn() {
        const on = !!this.currentBookmark()
        this.bmBtn.classList.toggle('on', on)
        this.bmBtn.replaceChildren(icon(on ? 'bookmark-check' : 'bookmark'))
    }
    toggleBookmark() {
        const d = this.loc
        if (!d) return
        const have = this.currentBookmark()
        if (have) db.set('annotations', [this.id, 'bookmarks', have.id], null)
        else {
            const id = uid()
            const snippet = d.range?.toString?.().trim().replace(/\s+/g, ' ').slice(0, 90)
            db.set('annotations', [this.id, 'bookmarks', id], { id, key: this.bookmarkKey(), cfi: d.cfi, fraction: d.fraction, created: Date.now(),
                label: [d.tocItem?.label, this.fixed ? `Page ${(d.section?.current ?? 0) + 1}` : snippet].filter(Boolean).join(' · ') })
            toast('Bookmarked', { ms: 1000 })
        }
        this.updateBookmarkBtn()
        if (!this.side.hidden) this.renderSide()
    }

    // ---------- define / translate / wikipedia ----------
    lookup(text, rect, tab) {
        this.hidePopups()
        const body = h('div.lk-body')
        const tabsEl = h('div.seg.tabs')
        const card = h('div.lookup', h('header', h('b', text.length > 60 ? text.slice(0, 60) + '…' : text), iconBtn('x', 'Close', () => this.hidePopups())), tabsEl, body)
        const lang = String(this.lang).slice(0, 2).toLowerCase() || 'en'
        const get = async url => { const r = await api.invoke('net:fetch', url); if (!r.ok) throw new Error(r.status === 0 ? 'offline' : String(r.status)); return JSON.parse(r.text) }
        const fail = e => body.replaceChildren(h('p.muted', e.message === 'offline' ? 'This needs an internet connection.' : 'Nothing found for this.'))
        const loaders = {
            define: async () => {
                const word = text.split(/\s+/).slice(0, 3).join(' ').replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
                try {
                    const d = await get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`)
                    const e0 = d[0]
                    body.replaceChildren(h('div.lk-word', h('b', e0.word), h('span', e0.phonetic ?? e0.phonetics?.find(p => p.text)?.text ?? '')),
                        ...e0.meanings.slice(0, 4).map(m => h('div.lk-meaning', h('i', m.partOfSpeech), h('ol', m.definitions.slice(0, 3).map(df => h('li', df.definition, df.example ? h('small', ` “${df.example}”`) : null))),
                            m.synonyms?.length ? h('small', `Similar: ${m.synonyms.slice(0, 6).join(', ')}`) : null)))
                } catch (err) {
                    if (err.message === 'offline') return fail(err)
                    // other languages and rarer words: Wiktionary
                    try {
                        const d = await get(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`)
                        const groups = Object.values(d).flat().slice(0, 4)
                        if (!groups.length) throw new Error('none')
                        const strip = s => new DOMParser().parseFromString(s ?? '', 'text/html').body.textContent.trim()
                        body.replaceChildren(h('div.lk-word', h('b', word)), ...groups.map(g => h('div.lk-meaning', h('i', `${g.partOfSpeech}${g.language ? ' · ' + g.language : ''}`), h('ol', g.definitions.slice(0, 3).map(df => strip(df.definition)).filter(Boolean).map(t => h('li', t))))))
                    } catch (e2) { fail(e2) }
                }
            },
            translate: async () => {
                const to = this.r.translateTo
                const picker = h('select', { onchange: () => { S.setReader('translateTo', picker.value); loaders.translate() } }, LANGS.map(([c, n]) => h('option', { value: c, selected: c === to }, n)))
                body.replaceChildren(h('p.muted', 'Translating…'))
                try {
                    const d = await get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${encodeURIComponent(text.slice(0, 1800))}`)
                    const out = d[0].map(x => x[0]).join('')
                    const from = LANGS.find(l => l[0].slice(0, 2) === String(d[2]).slice(0, 2))?.[1] ?? d[2]
                    body.replaceChildren(h('div.lk-tr', h('small', `${from} → `), picker), h('p.lk-out', out),
                        h('div.lk-actions', h('button.btn.small', { onclick: () => { navigator.clipboard.writeText(out); toast('Copied', { ms: 1000 }) } }, 'Copy')))
                } catch (e) {
                    try {
                        const d = await get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 450))}&langpair=${lang}|${to.slice(0, 2)}`)
                        body.replaceChildren(h('div.lk-tr', h('small', 'Into '), picker), h('p.lk-out', d.responseData.translatedText))
                    } catch (e2) { fail(e2.message === 'offline' ? e2 : e) }
                }
            },
            wiki: async () => {
                const q = text.split(/\s+/).slice(0, 6).join(' ')
                const tryLang = async l => get(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}?redirect=true`)
                try {
                    let d
                    try { d = await tryLang(lang) } catch (e) { if (lang === 'en' || e.message === 'offline') throw e; d = await tryLang('en') }
                    if (!d.extract) throw new Error('none')
                    body.replaceChildren(d.thumbnail?.source ? h('img.lk-thumb', { src: d.thumbnail.source, alt: '' }) : '', h('b', d.title), d.description ? h('small.block', d.description) : '', h('p', d.extract),
                        h('a.link', { onclick: () => api.invoke('shell:open', d.content_urls?.desktop?.page) }, 'Read more on Wikipedia'))
                } catch (e) { fail(e) }
            },
        }
        const show = t => {
            tabsEl.replaceChildren(...[['define', 'Define'], ['translate', 'Translate'], ['wiki', 'Wikipedia']].map(([id, label]) => h('button', { class: id === t ? 'on' : '', onclick: () => show(id) }, label)))
            body.replaceChildren(h('p.muted', 'Looking it up…'))
            loaders[t]()
        }
        this.place(card, rect, true)
        show(tab)
    }
    showFootnote({ view, href }) {
        this.hidePopups()
        const card = h('div.footnote', h('div.fn-view', view), h('footer', h('a.link', { onclick: () => { this.hidePopups(); this.view.goTo(href) } }, 'Go to note'), iconBtn('x', 'Close', () => this.hidePopups())))
        this.popups.append(card)
    }
    zoomImage(el) {
        let src = el.currentSrc || el.src
        if (!src && el.localName === 'svg') src = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(el)], { type: 'image/svg+xml' }))
        if (!src) return
        const img = h('img', { src })
        let scale = 1
        const back = h('div.imgzoom', { onclick: () => back.remove(), onwheel: e => { e.preventDefault(); scale = clamp(scale * (e.deltaY < 0 ? 1.15 : 0.87), 0.3, 8); img.style.transform = `scale(${scale})` } }, img)
        this.root.append(back)
    }

    // ---------- read aloud ----------
    tts = {
        on: false, paused: false, queue: [], gen: 0,
        toggle: () => { const t = this.tts; if (!t.on) return t.start(); t.paused ? t.resume() : t.pause() },
        start: async range => {
            const t = this.tts
            if (!('speechSynthesis' in window)) return toast('Read aloud is not available on this computer', { type: 'error' })
            try {
                speechSynthesis.cancel()
                await this.view.initTTS('sentence', r => t.highlight(r))
                t.on = true; t.paused = false; tracker.speaking = true
                t.bar()
                t.speak(range ? this.view.tts.from(range) : this.view.tts.start())
            } catch (e) { console.warn(e); toast(this.fixed ? 'This page has no readable text.' : 'Could not start reading aloud', { type: 'error' }); t.stop() }
        },
        highlight: range => {
            try {
                const doc = range.startContainer.ownerDocument, win = doc.defaultView
                win.CSS.highlights.set('ink-tts', new win.Highlight(range))
                this.view.renderer.scrollToAnchor?.(range, true)
            } catch { /* older engines */ }
        },
        parse: ssml => {
            const doc = new DOMParser().parseFromString(ssml, 'application/xml')
            const segs = []
            let cur = { mark: null, text: '' }
            const walk = n => {
                for (const c of n.childNodes) {
                    if (c.nodeType === 3 || c.nodeType === 4) cur.text += c.nodeValue
                    else if (c.nodeType === 1) {
                        if (c.localName === 'mark') { if (cur.text.trim()) segs.push(cur); cur = { mark: c.getAttribute('name'), text: '' } }
                        else if (c.localName === 'break') cur.text += ' '
                        else walk(c)
                    }
                }
            }
            walk(doc.documentElement)
            if (cur.text.trim()) segs.push(cur)
            return { segs, lang: doc.documentElement.getAttribute('xml:lang') }
        },
        speak: ssml => {
            const t = this.tts
            const gen = ++t.gen
            if (!ssml) return t.nextSection(gen)
            const { segs, lang } = t.parse(ssml)
            if (!segs.length) return t.advance(gen)
            const r = this.r
            const voices = speechSynthesis.getVoices()
            const want = String(lang || this.lang || 'en').toLowerCase()
            const voice = voices.find(v => v.name === r.ttsVoice) ?? voices.find(v => v.lang.toLowerCase() === want) ?? voices.find(v => v.lang.toLowerCase().startsWith(want.slice(0, 2)))
            let i = 0
            const next = () => {
                if (gen !== t.gen || !t.on) return
                const seg = segs[i++]
                if (!seg) return t.advance(gen)
                const u = new SpeechSynthesisUtterance(seg.text.replace(/\s+/g, ' ').trim())
                if (voice) { u.voice = voice; u.lang = voice.lang } else u.lang = want
                u.rate = r.ttsRate; u.pitch = r.ttsPitch
                u.onstart = () => { if (seg.mark != null) try { this.view.tts.setMark(seg.mark) } catch { /* mark gone */ } }
                u.onend = next
                u.onerror = ev => { if (ev.error !== 'interrupted' && ev.error !== 'canceled') next() }
                t.current = u // keep a reference so it is not garbage-collected mid-sentence
                speechSynthesis.speak(u)
            }
            next()
        },
        advance: gen => { const t = this.tts; if (gen !== t.gen || !t.on) return; let s; try { s = this.view.tts.next() } catch { s = null } s ? t.speak(s) : t.nextSection(gen) },
        nextSection: async gen => {
            const t = this.tts
            if (gen !== t.gen || !t.on) return
            const before = this.loc?.section?.current
            try {
                if (this.view.renderer.nextSection) await this.view.renderer.nextSection(); else await this.view.next()
                await new Promise(r => setTimeout(r, 350))
                if (this.loc?.section?.current === before) return t.stop()
                await this.view.initTTS('sentence', r => t.highlight(r))
                t.speak(this.view.tts.start())
            } catch { t.stop() }
        },
        skip: dir => { const t = this.tts; if (!t.on) return; speechSynthesis.cancel(); t.paused = false; let s; try { s = dir > 0 ? this.view.tts.next() : this.view.tts.prev() } catch { s = null } if (s) t.speak(s); else if (dir > 0) t.nextSection(++t.gen); t.bar() },
        pause: () => { const t = this.tts; t.paused = true; tracker.speaking = false; speechSynthesis.pause(); t.bar() },
        resume: () => { const t = this.tts; t.paused = false; tracker.speaking = true; speechSynthesis.resume(); if (!speechSynthesis.speaking) { let s; try { s = this.view.tts.resume() } catch { s = null } if (s) t.speak(s) } t.bar() },
        stop: () => {
            const t = this.tts
            t.on = false; t.paused = false; t.gen++; tracker.speaking = false
            try { speechSynthesis.cancel() } catch { /* ignore */ }
            for (const doc of this.docs.keys()) { try { doc.defaultView?.CSS.highlights.delete('ink-tts') } catch { /* closed */ } }
            $('.tts-bar', this.root)?.remove()
        },
        bar: () => {
            const t = this.tts
            $('.tts-bar', this.root)?.remove()
            if (!t.on) return
            const rate = h('select', { title: 'Speed', onchange: () => { S.setReader('ttsRate', +rate.value); if (!t.paused) { speechSynthesis.cancel(); let s; try { s = this.view.tts.resume() } catch { s = null } if (s) t.speak(s) } } },
                [0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5].map(v => h('option', { value: v, selected: Math.abs(v - this.r.ttsRate) < 0.05 }, v + '×')))
            this.root.append(h('div.tts-bar', icon('volume-2', 16),
                iconBtn('skip-back', 'Previous paragraph', () => t.skip(-1)),
                iconBtn(t.paused ? 'play' : 'pause', t.paused ? 'Resume' : 'Pause', () => t.toggle()),
                iconBtn('skip-forward', 'Next paragraph', () => t.skip(1)), rate,
                iconBtn('square', 'Stop', () => t.stop())))
        },
    }

    // ---------- speed reading (one word at a time) ----------
    speedRead() {
        if (this.speed) return this.speed.close()
        if (this.fixed && this.rec.format !== 'pdf') return toast('Speed reading needs text; these pages are images.')
        const getWords = () => {
            const c = this.view.renderer.getContents()[0]
            const doc = c?.doc
            if (!doc?.body) return []
            const range = doc.createRange()
            range.selectNodeContents(doc.body)
            const start = this.loc?.range
            try { if (start && start.startContainer.ownerDocument === doc) range.setStart(start.startContainer, start.startOffset) } catch { /* whole section */ }
            return range.toString().split(/\s+/).filter(Boolean)
        }
        let words = getWords(), i = 0, playing = false, timer
        if (!words.length) return toast('No text found on this page.')
        const wordEl = h('div.sr-word'), info = h('div.sr-info')
        const playBtn = iconBtn('play', 'Play or pause (Space)', () => toggle())
        const el = h('div.speed', h('div.sr-frame', wordEl), info,
            h('div.sr-ctl', iconBtn('skip-back', 'Back 10 words', () => { i = Math.max(0, i - 10); show() }), playBtn,
                iconBtn('minimize', 'Slower', () => setWpm(-20)), h('span.sr-wpm'), iconBtn('maximize', 'Faster', () => setWpm(20)),
                iconBtn('x', 'Close (Esc)', () => close())))
        const wpm = () => this.r.speedWpm
        const setWpm = d => { S.setReader('speedWpm', clamp(wpm() + d, 100, 1200)); show() }
        const show = () => {
            const w = words[i] ?? ''
            const p = Math.min(w.length - 1, Math.max(0, Math.floor((w.length + 2) / 4)))
            wordEl.replaceChildren(h('span.pre', w.slice(0, p)), h('b', w[p] ?? ''), h('span.post', w.slice(p + 1)))
            info.textContent = `${i + 1} / ${words.length} words in this chapter`
            $('.sr-wpm', el).textContent = `${wpm()} wpm`
        }
        const step = async () => {
            if (!playing) return
            if (i >= words.length - 1) {
                const before = this.loc?.section?.current
                if (this.view.renderer.nextSection) await this.view.renderer.nextSection(); else await this.view.next()
                await new Promise(r => setTimeout(r, 300))
                if (this.loc?.section?.current === before) return toggle(false)
                words = getWords(); i = 0
                if (!words.length) return toggle(false)
            } else i++
            show()
            tracker.activity()
            const w = words[i] ?? ''
            const delay = 60000 / wpm() * (/[.!?…]["”’)]?$/.test(w) ? 2.2 : /[,;:]$/.test(w) ? 1.5 : w.length > 9 ? 1.3 : 1)
            timer = setTimeout(step, delay)
        }
        const toggle = force => {
            playing = force ?? !playing
            clearTimeout(timer)
            playBtn.replaceChildren(icon(playing ? 'pause' : 'play'))
            if (playing) timer = setTimeout(step, 300)
        }
        const close = () => { clearTimeout(timer); el.remove(); this.speed = null }
        this.speed = { close, key: e => {
            if (e.key === 'Escape') close()
            else if (e.key === ' ') toggle()
            else if (e.key === 'ArrowUp') setWpm(20)
            else if (e.key === 'ArrowDown') setWpm(-20)
            else if (e.key === 'ArrowLeft') { i = Math.max(0, i - 10); show() }
            else if (e.key === 'ArrowRight') { i = Math.min(words.length - 1, i + 10); show() }
            else return
            e.preventDefault()
        } }
        this.root.append(el)
        show()
        toggle(true)
    }

    moreMenu(anchor) {
        const rec = this.rec
        menuAt(anchor, [
            { label: 'Open another book beside this one', icon: 'columns-2', run: () => api.invoke('win:new', '') },
            { label: 'Keep window on top', icon: 'pin', checked: this.onTop, run: () => { this.onTop = !this.onTop; api.invoke('win:onTop', this.onTop) } },
            { label: this.r.ruler ? 'Hide reading ruler' : 'Show reading ruler', icon: 'rows-3', run: () => this.setSetting('ruler', !this.r.ruler) },
            { label: this.scrolled ? 'Switch to pages' : 'Switch to scrolling', icon: 'scroll-text', disabled: this.fixed, run: () => this.act('flow') },
            '-',
            { label: 'Export highlights…', icon: 'download', run: () => this.exportNotes() },
            { label: 'Mark as finished', icon: 'circle-check', run: () => { lib.setStatus(this.id, 'finished'); toast('Marked as finished') } },
            { label: 'Show file in folder', icon: 'folder', run: () => api.invoke('shell:show', rec.path) },
            { label: 'Keyboard shortcuts', icon: 'keyboard', run: () => modal({ title: 'Keyboard shortcuts', body: h('div.keys', Object.entries(KEY_ACTIONS).map(([a, name]) => h('div.keyrow', h('span', name), h('div', (S.keys[a] ?? []).map(k => h('kbd', k.replace(' ', 'Space').replace('Arrow', '')))))), h('p.muted.small', 'Change any of these in Settings → Shortcuts.')), actions: [{ label: 'Close', primary: true }] }) },
        ])
    }

    close() { this.onClose?.() }
    async destroy() {
        this.saveProgress.flush?.()
        this.tts.stop()
        this.speed?.close()
        tracker.stop()
        this.unsub?.()
        clearInterval(this.clockTimer)
        document.removeEventListener('keydown', this.onKey)
        if (this.isFull) api.invoke('win:fullscreen', false)
        try { this.view?.close() } catch (e) { console.warn(e) }
        try { this.book?.destroy?.() } catch (e) { console.warn(e) }
        this.view?.remove()
        if (this.root) { this.root.replaceChildren(); this.root.hidden = true; this.root.className = '' }
        api.invoke('win:title', 'Iqra')
        api.invoke('win:onTop', false)
        applyAppTheme()
    }
}

api.on('fullscreen', on => { if (current) { current.isFull = on; current.root?.classList.toggle('full', on) } })
