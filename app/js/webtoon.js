// Continuous vertical scrolling for comics, manga and webtoons.
// It plugs into foliate-view as a renderer (like foliate-fxl), so progress, bookmarks,
// the slider and "go to page" all keep working. Pages load as they come near the screen
// and are dropped again when far away, so very long comics stay light on memory.

const LOAD_AHEAD = '150% 0px'   // start loading pages this far above/below the screen
const KEEP = '600% 0px'         // drop page images that are further away than this

export class Webtoon extends HTMLElement {
    static observedAttributes = ['max-width', 'gap']
    #root = this.attachShadow({ mode: 'closed' })
    #scroller
    #strip
    #slots = []
    #known = []          // true once a page's real size is known
    #urls = new Map()    // page index -> object URL of the image
    #jobs = new Map()    // page index -> loading promise
    #gen = []            // bumped on unload so late loads are thrown away
    #near
    #far
    #resize
    #index = -1
    #started = false
    #raf = 0
    #idle = 0
    #lastWidth = 0
    book

    constructor() {
        super()
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(`
            :host { display: block; width: 100%; height: 100%; }
            .scroller { position: relative; width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden; overflow-anchor: none; outline: none; }
            .strip { position: relative; margin: 0 auto; width: 100%; max-width: var(--max, 900px); display: flex; flex-direction: column; gap: var(--gap, 0px); padding-block: var(--gap, 0px); --r: 1.5; }
            .page { position: relative; width: 100%; aspect-ratio: 1 / var(--r); background: rgba(128, 128, 128, .12); flex-shrink: 0; }
            .page.ready { background: none; }
            .page img { display: block; width: 100%; height: 100%; user-select: none; -webkit-user-drag: none; }
            .page .num { position: absolute; inset: 0; display: grid; place-items: center; font: 600 13px system-ui, sans-serif; color: rgba(128, 128, 128, .8); }
            .page.ready .num { display: none; }
            .page.failed .num { color: #c0392b; }
            .end { height: 12vh; display: grid; place-items: center; font: 600 12px system-ui, sans-serif; color: rgba(128, 128, 128, .8); letter-spacing: .08em; text-transform: uppercase; }
        `)
        this.#root.adoptedStyleSheets = [sheet]
        this.#scroller = document.createElement('div')
        this.#scroller.className = 'scroller'
        this.#strip = document.createElement('div')
        this.#strip.className = 'strip'
        this.#scroller.append(this.#strip)
        this.#root.append(this.#scroller)
        this.#scroller.addEventListener('scroll', () => this.#onScroll(), { passive: true })
    }

    attributeChangedCallback(name, _, value) {
        const pos = this.#started ? this.#position() : null
        if (name === 'max-width') this.#strip.style.setProperty('--max', Number(value) > 0 ? `${Number(value)}px` : '100%')
        if (name === 'gap') this.#strip.style.setProperty('--gap', `${Math.max(0, Number(value) || 0)}px`)
        if (pos) requestAnimationFrame(() => this.#restore(pos))
    }

    open(book) {
        this.book = book
        const n = book.sections.length
        this.#gen = new Array(n).fill(0)
        this.#known = new Array(n).fill(false)
        this.#slots = Array.from({ length: n }, (_, i) => {
            const slot = document.createElement('div')
            slot.className = 'page'
            slot.dataset.i = i
            const num = document.createElement('div')
            num.className = 'num'
            num.textContent = String(i + 1)
            slot.append(num)
            return slot
        })
        const end = document.createElement('div')
        end.className = 'end'
        end.textContent = 'End'
        this.#strip.replaceChildren(...this.#slots, end)

        this.#near = new IntersectionObserver(entries => {
            for (const e of entries) if (e.isIntersecting) this.#load(Number(e.target.dataset.i))
        }, { root: this.#scroller, rootMargin: LOAD_AHEAD })
        this.#far = new IntersectionObserver(entries => {
            for (const e of entries) if (!e.isIntersecting) this.#unload(Number(e.target.dataset.i))
        }, { root: this.#scroller, rootMargin: KEEP })
        for (const s of this.#slots) { this.#near.observe(s); this.#far.observe(s) }

        // keep the same spot on the page when the window or page width changes
        this.#resize = new ResizeObserver(() => {
            const w = this.#strip.clientWidth
            if (!this.#started || !this.#lastWidth || w === this.#lastWidth) { this.#lastWidth = w; return }
            const pos = this.#savedPos ?? this.#position()
            this.#lastWidth = w
            this.#restore(pos)
        })
        this.#resize.observe(this.#strip)
    }
    #savedPos = null

    // ---------- loading ----------
    #load(i) {
        if (this.#urls.has(i)) return Promise.resolve()
        if (this.#jobs.has(i)) return this.#jobs.get(i)
        const gen = this.#gen[i]
        const job = (async () => {
            const slot = this.#slots[i]
            try {
                const blob = await this.book.getPageBlob(i)
                if (gen !== this.#gen[i]) return
                const url = URL.createObjectURL(blob)
                const img = new Image()
                img.decoding = 'async'
                img.draggable = false
                img.alt = `Page ${i + 1}`
                img.src = url
                try { await img.decode() } catch { /* draw it anyway */ }
                if (gen !== this.#gen[i]) { URL.revokeObjectURL(url); return }
                const w = img.naturalWidth, h = img.naturalHeight
                if (w && h) this.#steady(() => {
                    slot.style.aspectRatio = `${w} / ${h}`
                    // until their real size is known, other pages are guessed to be shaped like the first one loaded
                    if (!this.#known.some(Boolean)) this.#strip.style.setProperty('--r', String(h / w))
                    this.#known[i] = true
                })
                this.#urls.set(i, url)
                slot.querySelector('img')?.remove()
                slot.append(img)
                slot.classList.add('ready')
                slot.classList.remove('failed')
            } catch (e) {
                console.warn('page failed to load', i, e)
                slot.classList.add('failed')
                slot.querySelector('.num').textContent = `Page ${i + 1} could not be loaded`
            } finally {
                this.#jobs.delete(i)
            }
        })()
        this.#jobs.set(i, job)
        return job
    }
    #unload(i) {
        this.#gen[i]++
        this.#jobs.delete(i)
        const url = this.#urls.get(i)
        if (!url) return
        this.#urls.delete(i)
        const slot = this.#slots[i]
        slot.querySelector('img')?.remove()
        slot.classList.remove('ready')
        URL.revokeObjectURL(url)
        // the slot keeps its real size (aspect-ratio stays set), so nothing jumps
    }

    // change page sizes without the view jumping: keep the same spot on the current page
    #steady(change) {
        const pos = this.#started && !this.#savedPos ? this.#position() : null
        change()
        if (!pos) return
        const want = this.#top(pos.index) + pos.offset * this.#strip.clientWidth
        if (Math.abs(this.#scroller.scrollTop - want) > 0.5) this.#scroller.scrollTop = want
    }

    // ---------- position ----------
    #top(i) { return this.#strip.offsetTop + this.#slots[i].offsetTop }
    #indexAt(y) {
        // last page whose top is at or above y (binary search; pages are in order)
        let lo = 0, hi = this.#slots.length - 1, ans = 0
        while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (this.#top(mid) <= y) { ans = mid; lo = mid + 1 } else hi = mid - 1
        }
        return ans
    }
    #position() {
        const top = this.#scroller.scrollTop
        const index = this.#indexAt(top + this.#scroller.clientHeight * 0.25)
        // measured in page widths, so it survives width changes
        const offset = (top - this.#top(index)) / Math.max(1, this.#strip.clientWidth)
        return { index, offset }
    }
    async #restore({ index, offset }) {
        this.#savedPos = { index, offset }
        await Promise.all([this.#load(index), index > 0 ? this.#load(index - 1) : null])
        this.#scroller.scrollTop = this.#top(index) + offset * this.#strip.clientWidth
        this.#savedPos = null
    }
    get index() { return this.#index }
    get offset() { return this.#started ? this.#position().offset : 0 }

    #onScroll() {
        if (!this.#started) return
        if (!this.#raf) this.#raf = requestAnimationFrame(() => {
            this.#raf = 0
            const { index } = this.#position()
            if (index !== this.#index) { this.#index = index; this.#report('page') }
        })
        clearTimeout(this.#idle)
        this.#idle = setTimeout(() => this.#report('scroll'), 350)
    }
    #report(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: Math.max(0, this.#index), fraction: 0, size: 1 } }))
    }

    // ---------- the renderer API foliate-view uses ----------
    async goTo(target) {
        const resolved = await target
        const index = resolved?.index
        if (!(index >= 0 && index < this.#slots.length)) return
        this.#started = true
        this.#lastWidth = this.#strip.clientWidth
        await this.#restore({ index, offset: Number(resolved.offset) || 0 })
        this.#index = index
        this.#report('page')
    }
    async select(target) { return this.goTo(target) }
    scrollStep(f) {
        this.#scroller.scrollBy({ top: f * this.#scroller.clientHeight, behavior: 'smooth' })
    }
    async next() {
        if (!this.#started) return this.goTo({ index: 0 })
        this.scrollStep(0.85)
    }
    async prev() {
        if (!this.#started) return this.goTo({ index: 0 })
        this.scrollStep(-0.85)
    }
    goToEnd() { return this.goTo({ index: this.#slots.length - 1 }) }
    getContents() { return [] }
    destroy() {
        this.#near?.disconnect()
        this.#far?.disconnect()
        this.#resize?.disconnect()
        clearTimeout(this.#idle)
        cancelAnimationFrame(this.#raf)
        for (const url of this.#urls.values()) URL.revokeObjectURL(url)
        this.#urls.clear()
    }
}

customElements.define('iqra-webtoon', Webtoon)
