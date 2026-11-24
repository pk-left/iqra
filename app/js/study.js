// Study tools: highlight review cards (spaced repetition), saved words with a quiz, the Want-to-read list,
// Anki export and quote cards. Everything lives in the "study" store.
import { data, db } from './db.js'
import { h, $, icon, iconBtn, modal, toast, confirmBox, promptBox, dayKey, uid, fmtDate, relTime, esc, select, segmented } from './ui.js'
import { lib, importer } from './store.js'
import { S } from './settings.js'

const api = window.api
let navigate = () => {}
let openBookFn = () => {}
export function initStudy({ nav, openBook }) { navigate = nav; openBookFn = openBook }

// ---------- spaced repetition (a small SM-2: again / hard / good / easy) ----------
const DAY = 86400000
const today = () => dayKey()
const addDays = (n) => dayKey(new Date(Date.now() + n * DAY))
export function schedule(card, grade) {
    // grade: 0 again, 1 hard, 2 good, 3 easy
    const c = { ease: 2.5, interval: 0, reps: 0, lapses: 0, ...card }
    if (grade === 0) { c.lapses++; c.reps = 0; c.interval = 0; c.ease = Math.max(1.3, c.ease - 0.2) }
    else {
        c.reps++
        if (c.reps === 1) c.interval = grade === 1 ? 1 : grade === 2 ? 1 : 3
        else if (c.reps === 2) c.interval = grade === 1 ? 3 : grade === 2 ? 4 : 7
        else c.interval = Math.round(c.interval * (grade === 1 ? 1.2 : grade === 2 ? c.ease : c.ease * 1.35))
        c.ease = Math.min(3.2, Math.max(1.3, c.ease + (grade === 1 ? -0.15 : grade === 3 ? 0.15 : 0)))
    }
    c.due = grade === 0 ? today() : addDays(c.interval)
    c.last = Date.now()
    return c
}
const intervalLabel = (card, grade) => {
    const n = schedule(card, grade).interval
    return grade === 0 ? 'today' : n <= 1 ? '1 day' : n < 30 ? `${n} days` : n < 365 ? `${Math.round(n / 30)} mo` : `${(n / 365).toFixed(1)} yr`
}
function logReview() {
    db.inc('study', ['log', today()], 1)
}
export function studyStreak() {
    const log = data.study.log ?? {}
    let n = 0, d = new Date()
    if (!log[dayKey(d)]) d = new Date(Date.now() - DAY)
    while (log[dayKey(d)]) { n++; d = new Date(d.getTime() - DAY) }
    return n
}

// ---------- highlight cards ----------
const STOP = new Set('the a an and or but if then of to in on at by for with from as is are was were be been being that this these those it its he she they them his her their we our you your i me my not no so than too very can will would should could has have had do does did just about into over after before because while which who whom what when where why how all any each more most other some such only own same also there here out up down off again once'.split(' '))
// the word hidden in a review card: the most distinctive word of the highlight
export function clozeIndex(text) {
    const words = text.split(/(\s+)/)
    let best = -1, score = 0
    words.forEach((w, i) => {
        const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
        if (core.length < 4 || STOP.has(core.toLowerCase())) return
        const sc = core.length + (/^\p{Lu}/u.test(core) && i > 0 ? 1.5 : 0) + (/\d/.test(core) ? 2 : 0)
        if (sc > score) { score = sc; best = i }
    })
    return best
}
export function addToReview(bookId, hlId, quiet) {
    const key = `${bookId}:${hlId}`
    if (data.study.cards?.[key]) return false
    const a = data.annotations[bookId]?.highlights?.[hlId]
    if (!a) return false
    db.set('study', ['cards', key], { bookId, hlId, added: Date.now(), due: today(), ease: 2.5, interval: 0, reps: 0, lapses: 0, cloze: clozeIndex(a.text ?? '') })
    if (!quiet) toast('Added to Review')
    return true
}
function cardList() {
    const out = []
    for (const [key, c] of Object.entries(data.study.cards ?? {})) {
        const a = data.annotations[c.bookId]?.highlights?.[c.hlId]
        const b = lib.get(c.bookId)
        if (!a || !b || b.removed) continue
        out.push({ key, c, a, b })
    }
    return out
}
export const dueCards = () => cardList().filter(x => !x.c.suspended && (x.c.due ?? '') <= today())
export const dueWords = () => wordList().filter(w => !w.suspended && (w.due ?? '') <= today())

// ---------- saved words ----------
export function saveWord({ word, def, pos, context, bookId }) {
    const key = word.toLowerCase()
    if (data.study.words?.[key]) return false
    db.set('study', ['words', key], { word, def: def ?? '', pos: pos ?? '', context: context ?? '', bookId, added: Date.now(), due: addDays(1), ease: 2.5, interval: 0, reps: 0, lapses: 0 })
    toast(`Saved “${word}” to your words`, { ms: 1800 })
    return true
}
function wordList() { return Object.values(data.study.words ?? {}).sort((a, b) => b.added - a.added) }

// ---------- want to read ----------
export function addWish(item) {
    const id = item.id ?? uid()
    if (Object.values(data.study.wishlist ?? {}).some(w => w.title.toLowerCase() === item.title.toLowerCase())) { toast('Already on your Want to read list'); return null }
    db.set('study', ['wishlist', id], { id, added: Date.now(), ...item })
    toast(`“${item.title}” is on your Want to read list`, { ms: 2200 })
    return id
}
export const isWished = title => Object.values(data.study.wishlist ?? {}).some(w => w.title.toLowerCase() === String(title).toLowerCase())
export const wishCount = () => Object.keys(data.study.wishlist ?? {}).length + lib.books.filter(b => b.want).length

// ---------- pages ----------
const blank = (text, idx) => {
    const parts = text.split(/(\s+)/)
    if (idx < 0 || idx >= parts.length) return { html: [text], answer: '' }
    const core = parts[idx].match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u)
    return { before: parts.slice(0, idx).join('') + core[1], answer: core[2], after: core[3] + parts.slice(idx + 1).join('') }
}

let reviewState = null
export function renderReview(el) {
    const cards = cardList()
    const due = dueCards()
    if (reviewState?.active) return drawSession(el)
    const books = [...new Map(cards.map(x => [x.b.id, x.b])).values()]
    const byBook = id => cards.filter(x => x.b.id === id)
    const log = data.study.log ?? {}
    const week = Array.from({ length: 14 }, (_, i) => { const d = dayKey(new Date(Date.now() - (13 - i) * DAY)); return [d, log[d] ?? 0] })
    const max = Math.max(5, ...week.map(w => w[1]))
    el.replaceChildren(h('div.study-page',
        h('section.study-hero',
            h('div', h('h2', due.length ? `${due.length} card${due.length === 1 ? '' : 's'} to review` : cards.length ? 'All caught up' : 'Your review deck is empty'),
                h('p.muted', cards.length ? 'Highlights come back just before you would forget them. One word is hidden: say it, then check yourself.'
                    : 'Highlight something while reading, then press “Review” on it (or “Review all” in the Highlights panel). It will come back here on a schedule.'),
                h('div.btnrow',
                    h('button.btn.primary', { disabled: !due.length, onclick: () => { reviewState = { active: true, queue: due.map(x => x.key).sort(() => Math.random() - 0.5), done: 0, shown: false }; renderReview(el) } }, icon('play', 15), ' Start review'),
                    h('button.btn', { disabled: !cards.length, onclick: () => exportAnki('highlights') }, icon('download', 15), ' Export to Anki'))),
            h('div.study-stats',
                h('div.sstat', h('b', String(cards.length)), h('small', 'cards')),
                h('div.sstat', h('b', String(studyStreak())), h('small', 'day streak')),
                h('div.spark', { title: 'Reviews over the last two weeks' }, week.map(([d, n]) => h('i', { title: `${d}: ${n}`, style: { height: `${8 + (n / max) * 92}%` }, class: n ? 'on' : '' }))))),
        books.length ? h('h3.study-h', 'Cards by book') : '',
        h('div.deck-list', books.map(b => {
            const list = byBook(b.id)
            const nDue = list.filter(x => (x.c.due ?? '') <= today()).length
            return h('details.deck', h('summary', h('b', b.title), h('small', `${list.length} card${list.length === 1 ? '' : 's'}${nDue ? ` · ${nDue} due` : ''}`)),
                list.map(x => h('div.deck-card', h('q', x.a.text.slice(0, 220)), h('small', x.c.reps ? `next ${x.c.due}` : 'new'),
                    iconBtn('trash-2', 'Remove from review', () => { db.set('study', ['cards', x.key], null); renderReview(el) }))))
        }))))
}
function drawSession(el) {
    const st = reviewState
    const exit = () => { reviewState = null; renderReview(el) }
    const key = st.queue[0]
    const x = key && cardList().find(y => y.key === key)
    if (!x) {
        return el.replaceChildren(h('div.study-page', h('section.session.done-card',
            h('div.done-stamp', 'Done'), h('h2', `${st.done} card${st.done === 1 ? '' : 's'} reviewed`),
            h('p.muted', 'Come back tomorrow for the next ones.'), h('button.btn.primary', { onclick: exit }, 'Back to the deck'))))
    }
    const { a, b, c } = x
    const parts = blank(a.text, c.cloze ?? clozeIndex(a.text))
    const quote = parts.answer
        ? h('blockquote.cloze', parts.before, h('span.gap', { class: st.shown ? 'shown' : '' }, st.shown ? parts.answer : '·'.repeat(Math.min(12, parts.answer.length))), parts.after)
        : h('blockquote.cloze', a.text)
    const grade = g => {
        db.set('study', ['cards', key], schedule(c, g))
        logReview()
        st.queue.shift()
        if (g === 0) st.queue.splice(Math.min(st.queue.length, 3), 0, key) // see it again soon
        else st.done++
        st.shown = false
        drawSession(el)
    }
    const onKey = e => {
        if (!el.isConnected || !reviewState) return removeEventListener('keydown', onKey)
        if (e.target.closest?.('input, textarea')) return
        if (!st.shown && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); removeEventListener('keydown', onKey); st.shown = true; drawSession(el) }
        else if (st.shown && '1234'.includes(e.key)) { removeEventListener('keydown', onKey); grade(+e.key - 1) }
    }
    addEventListener('keydown', onKey)
    el.replaceChildren(h('div.study-page', h('section.session',
        h('header.session-top', h('button.btn.small', { onclick: () => { removeEventListener('keydown', onKey); exit() } }, icon('arrow-left', 14), ' Stop'),
            h('div.session-bar', h('i', { style: { width: `${(st.done / (st.done + st.queue.length)) * 100}%` } })), h('small', `${st.queue.length} left`)),
        h('div.card-face', quote, h('div.card-src', h('b', b.title), b.author ? ` · ${b.author}` : '', a.chapter ? h('small.block', a.chapter) : ''),
            a.note ? h('p.card-note', { hidden: !st.shown }, icon('notebook-pen', 14), ' ', a.note) : null),
        st.shown
            ? h('div.grades', [['Forgot', 0], ['Hard', 1], ['Good', 2], ['Easy', 3]].map(([label, g]) => h('button.btn', { class: `g${g}`, onclick: () => { removeEventListener('keydown', onKey); grade(g) } }, h('b', label), h('small', intervalLabel(c, g)), h('kbd', String(g + 1)))))
            : h('div.grades', h('button.btn.primary.reveal', { onclick: () => { removeEventListener('keydown', onKey); st.shown = true; drawSession(el) } }, 'Show the hidden word', h('kbd', 'Space'))),
        h('div.card-tools', h('a.link', { onclick: () => { removeEventListener('keydown', onKey); reviewState = null; openBookFn(b) } }, 'Open in the book'),
            h('a.link', { onclick: () => { db.set('study', ['cards', key, 'cloze'], (c.cloze ?? 0) + 2 >= a.text.split(/(\s+)/).length ? 0 : nextWordIndex(a.text, c.cloze)); drawSession(el) } }, 'Hide a different word'),
            h('a.link', { onclick: () => { db.set('study', ['cards', key, 'suspended'], true); st.queue.shift(); drawSession(el) } }, 'Stop showing this card')))))
}
function nextWordIndex(text, cur) {
    const parts = text.split(/(\s+)/)
    for (let i = (cur ?? -2) + 2; i < parts.length; i += 2) if (parts[i].replace(/[^\p{L}]/gu, '').length >= 4) return i
    return 0
}

let wordQuiz = null
export function renderWords(el) {
    const words = wordList()
    if (wordQuiz) return drawQuiz(el)
    const due = dueWords()
    let filter = ''
    const listEl = h('div.word-list')
    const draw = () => listEl.replaceChildren(...words.filter(w => !filter || w.word.toLowerCase().includes(filter) || w.def.toLowerCase().includes(filter)).map(w => {
        const b = w.bookId && lib.get(w.bookId)
        return h('div.word-card', h('div.wc-top', h('b', w.word), w.pos ? h('i', w.pos) : null,
            iconBtn('trash-2', 'Forget this word', () => { db.set('study', ['words', w.word.toLowerCase()], null); renderWords(el) })),
            h('p', w.def || '—'), w.context ? h('q', w.context) : null,
            h('small', [b?.title, relTime(w.added), w.reps ? `next ${w.due}` : 'not quizzed yet'].filter(Boolean).join(' · ')))
    }))
    const input = h('input', { type: 'search', placeholder: 'Find a word…', oninput: () => { filter = input.value.trim().toLowerCase(); draw() } })
    draw()
    el.replaceChildren(h('div.study-page',
        h('section.study-hero',
            h('div', h('h2', words.length ? `${words.length} saved word${words.length === 1 ? '' : 's'}` : 'No saved words yet'),
                h('p.muted', words.length ? 'Words you looked up while reading, each with the sentence you found it in.' : 'Select a word while reading, press Define, then “Save word”. The definition works offline for English.'),
                h('div.btnrow',
                    h('button.btn.primary', { disabled: !words.length, onclick: () => startQuiz(el, due.length ? due : words) }, icon('play', 15), due.length ? ` Quiz ${due.length} due` : ' Practise all'),
                    h('button.btn', { disabled: !words.length, onclick: () => exportAnki('words') }, icon('download', 15), ' Export to Anki'))),
            h('div.study-stats', h('div.sstat', h('b', String(due.length)), h('small', 'due today')), h('div.sstat', h('b', String(words.filter(w => w.interval >= 21).length)), h('small', 'learned')))),
        words.length ? h('div.word-tools', input) : '', listEl))
}
function startQuiz(el, list) {
    wordQuiz = { queue: [...list].sort(() => Math.random() - 0.5).slice(0, 20).map(w => w.word.toLowerCase()), right: 0, total: 0 }
    renderWords(el)
}
function drawQuiz(el) {
    const q = wordQuiz
    const exit = () => { wordQuiz = null; renderWords(el) }
    const all = wordList()
    const w = data.study.words?.[q.queue[0]]
    if (!w) return el.replaceChildren(h('div.study-page', h('section.session.done-card', h('div.done-stamp', `${q.right}/${q.total}`),
        h('h2', q.right === q.total ? 'Perfect!' : 'Quiz finished'), h('p.muted', 'Words you missed come back sooner.'), h('button.btn.primary', { onclick: exit }, 'Back to my words'))))
    // four choices when there are enough words, otherwise a flip card
    const others = all.filter(x => x.word !== w.word && x.def).sort(() => Math.random() - 0.5).slice(0, 3)
    const multi = others.length >= 3 && w.def
    const answer = ok => {
        q.total++; if (ok) q.right++
        db.set('study', ['words', q.queue[0]], schedule(w, ok ? 2 : 0))
        logReview()
        q.queue.shift()
        setTimeout(() => drawQuiz(el), ok ? 650 : 1500)
    }
    const ctx = w.context ? w.context.replace(new RegExp(`\\b${w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*`, 'gi'), '_____') : ''
    let body
    if (multi) {
        const opts = [...others.map(o => ({ def: o.def, ok: false })), { def: w.def, ok: true }].sort(() => Math.random() - 0.5)
        body = h('div.choices', opts.map(o => {
            const btn = h('button.choice', { onclick: () => {
                if (btn.parentElement.classList.contains('answered')) return
                btn.parentElement.classList.add('answered'); btn.classList.add(o.ok ? 'right' : 'wrong')
                btn.parentElement.querySelectorAll('.choice').forEach((b, i) => { if (opts[i].ok) b.classList.add('right') })
                answer(o.ok)
            } }, o.def.length > 160 ? o.def.slice(0, 160) + '…' : o.def)
            return btn
        }))
    } else {
        const back = h('div.flip-back', { hidden: true }, h('p', w.def || '(no definition saved)'),
            h('div.grades', h('button.btn.g0', { onclick: () => answer(false) }, 'Didn’t know'), h('button.btn.g2', { onclick: () => answer(true) }, 'Knew it')))
        body = h('div', h('button.btn.primary', { onclick: e => { e.currentTarget.remove(); back.hidden = false } }, 'Show meaning'), back)
    }
    el.replaceChildren(h('div.study-page', h('section.session',
        h('header.session-top', h('button.btn.small', { onclick: exit }, icon('arrow-left', 14), ' Stop'), h('div.session-bar', h('i', { style: { width: `${(q.total / (q.total + q.queue.length)) * 100}%` } })), h('small', `${q.right} right`)),
        h('div.card-face.word-face', h('h2', w.word), w.pos ? h('i.muted', w.pos) : null, ctx ? h('q', ctx) : null),
        body)))
}

export function renderWishlist(el) {
    const wishes = Object.values(data.study.wishlist ?? {}).sort((a, b) => b.added - a.added)
    const owned = lib.books.filter(b => b.want)
    const have = new Map(lib.books.map(b => [b.title.toLowerCase(), b]))
    const card = w => {
        const inLib = have.get(w.title.toLowerCase())
        const remove = () => { db.set('study', ['wishlist', w.id], null); renderWishlist(el) }
        return h('div.book.wish', { class: inLib ? 'owned' : '' },
            h('div.cover', w.cover ? h('img', { src: w.cover, alt: '', loading: 'lazy' }) : h('div.gen-cover', { style: { '--h': w.title.length * 37 % 360 } }, h('span.gt', w.title), w.author ? h('span.ga', w.author) : null),
                h('span.wish-stamp', inLib ? 'got it' : 'wanted')),
            h('div.meta', h('div.t', w.title), h('div.a', w.author || ''),
                h('div.wish-actions',
                    inLib ? h('button.btn.small.primary', { onclick: () => openBookFn(inLib) }, 'Read')
                        : w.epub ? h('button.btn.small.primary', { onclick: async e => {
                            const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Getting…'
                            try {
                                const folder = S.app.downloadFolder || `${importer.folders()[0]}\\Iqra Books`
                                const f = await api.invoke('download', w.epub, folder, `${w.title.slice(0, 90)} - ${(w.author || 'Unknown').slice(0, 40)}.epub`)
                                await importer.addPaths([f.path]); toast(`Added “${w.title}”`); renderWishlist(el)
                            } catch { btn.disabled = false; btn.textContent = 'Try again' }
                        } }, 'Get it free')
                        : h('button.btn.small', { title: 'Look for a free copy', onclick: () => { sessionStorage.setItem('iqra-disc-q', w.title); navigate('discover') } }, 'Find free'),
                    iconBtn('x', 'Remove from Want to read', remove))))
    }
    el.replaceChildren(h('div.study-page',
        h('section.study-hero', h('div', h('h2', 'Want to read'),
            h('p.muted', 'Books you mean to get to: ones already in your library, and ones you don’t have yet. Add free classics from Free books, or note down any title.'),
            h('div.btnrow', h('button.btn.primary', { onclick: async () => {
                const t = (await promptBox('Want to read', 'Title (and author, after a dash: “Things Fall Apart - Chinua Achebe”)'))?.trim()
                if (!t) return
                const [title, author] = t.split(/\s+[-–—]\s+/)
                addWish({ title: title.trim(), author: author?.trim() ?? '', source: 'manual' }); renderWishlist(el)
            } }, icon('plus', 15), ' Add a title'), h('button.btn', { onclick: () => navigate('discover') }, icon('compass', 15), ' Browse free books')))),
        owned.length ? h('h3.study-h', 'In your library') : '',
        owned.length ? h('div.grid', owned.map(b => h('div.book.wish', { onclick: () => openBookFn(b) },
            h('div.cover', lib.coverURL(b) ? h('img', { src: lib.coverURL(b), alt: '' }) : h('div.gen-cover', { style: { '--h': b.title.length * 37 % 360 } }, h('span.gt', b.title)), h('span.wish-stamp', 'on the shelf')),
            h('div.meta', h('div.t', b.title), h('div.a', b.author || ''), h('div.wish-actions', iconBtn('x', 'Remove from Want to read', e => { e.stopPropagation(); lib.update(b.id, { want: null }); renderWishlist(el) })))))) : '',
        wishes.length ? h('h3.study-h', 'Not in your library yet') : '',
        h('div.grid', wishes.map(card)),
        !wishes.length && !owned.length ? h('div.empty', icon('bookmark', 36), h('h3', 'Nothing here yet'), h('p', 'Right-click a book and choose “Want to read”, or add a title above.')) : ''))
}

// ---------- Anki export (tab-separated text that Anki imports directly) ----------
async function exportAnki(kind) {
    const clean = s => String(s ?? '').replace(/\t/g, ' ').replace(/\r?\n+/g, '<br>')
    let lines, name
    if (kind === 'highlights') {
        lines = ['#separator:tab', '#html:true', '#notetype:Cloze', '#tags column:3']
        for (const { a, b, c } of cardList()) {
            const p = blank(a.text, c.cloze ?? clozeIndex(a.text))
            const text = p.answer ? `${esc(p.before)}{{c1::${esc(p.answer)}}}${esc(p.after)}` : esc(a.text)
            const extra = `<i>${esc(b.title)}${b.author ? ' · ' + esc(b.author) : ''}</i>${a.note ? '<br>' + esc(a.note) : ''}`
            lines.push([clean(text), clean(extra), `iqra ${b.title.replace(/\W+/g, '_').slice(0, 40)}`].join('\t'))
        }
        name = 'iqra-highlights-anki.txt'
    } else {
        lines = ['#separator:tab', '#html:true', '#notetype:Basic', '#tags column:3']
        for (const w of wordList()) lines.push([clean(esc(w.word)), clean(`${w.pos ? `<i>${esc(w.pos)}</i> ` : ''}${esc(w.def)}${w.context ? `<br><br>“${esc(w.context)}”` : ''}`), 'iqra vocabulary'].join('\t'))
        name = 'iqra-words-anki.txt'
    }
    const p = await api.invoke('dialog:save', { title: 'Export for Anki', defaultPath: name, filters: [{ name: 'Anki text import', extensions: ['txt'] }] }, lines.join('\n'))
    if (p) toast('Saved. In Anki choose File → Import and pick this file.', { ms: 5000 })
}

// ---------- quote cards ----------
const CARD_STYLES = {
    riso: { name: 'Riso', bg: '#f3ecdc', fg: '#3255a4', accent: '#ff48b0', font: 'Fraunces', meta: 'Courier Prime' },
    manuscript: { name: 'Manuscript', bg: '#f1e4c6', fg: '#2a2140', accent: '#b8862b', font: 'EB Garamond', meta: 'Cinzel' },
    indigo: { name: 'Indigo', bg: '#16224f', fg: '#f2efe6', accent: '#8fb3ff', font: 'DM Serif Display', meta: 'Archivo' },
    kente: { name: 'Kente', bg: '#141210', fg: '#f6d66b', accent: '#2f8a3b', font: 'Archivo Black', meta: 'Archivo' },
    broadsheet: { name: 'Broadsheet', bg: '#ebe7de', fg: '#151515', accent: '#151515', font: 'Playfair Display', meta: 'Old Standard TT' },
    train: { name: 'Night train', bg: '#1f1424', fg: '#f3dcb2', accent: '#e0a84c', font: 'Limelight', meta: 'Space Mono' },
    zellige: { name: 'Zellige', bg: '#0f4b57', fg: '#fdf8ee', accent: '#e9b949', font: 'Reem Kufi', meta: 'Reem Kufi' },
}
const SIZES = { square: [1080, 1080, 'Square'], portrait: [1080, 1350, 'Post'], story: [1080, 1920, 'Story'] }

function wrapLines(ctx, text, width) {
    const words = text.split(/\s+/), lines = []
    let line = ''
    for (const w of words) {
        const t = line ? line + ' ' + w : w
        if (ctx.measureText(t).width > width && line) { lines.push(line); line = w } else line = t
    }
    if (line) lines.push(line)
    return lines
}
async function drawCard(canvas, { style, size, text, title, author }) {
    const st = CARD_STYLES[style] ?? CARD_STYLES.riso
    const [W, H] = SIZES[size] ?? SIZES.portrait
    canvas.width = W; canvas.height = H
    const ctx = canvas.getContext('2d')
    const arabic = /[؀-ۿ]/.test(text)
    const font = arabic ? 'Amiri' : st.font
    await Promise.all([document.fonts.load(`700 60px "${font}"`, text), document.fonts.load(`400 30px "${st.meta}"`), document.fonts.load('400 60px "Amiri"', 'ب')]).catch(() => {})
    ctx.fillStyle = st.bg; ctx.fillRect(0, 0, W, H)
    const rnd = (() => { let s = text.length * 9301 + 49297; return () => (s = (s * 9301 + 49297) % 233280) / 233280 })()
    // background ornament per style
    if (style === 'riso') {
        ctx.fillStyle = st.accent
        for (let y = 0; y < H; y += 14) for (let x = (y / 14) % 2 ? 7 : 0; x < W; x += 14) { const d = Math.hypot(x - W * 0.82, y - H * 0.18); const r = Math.max(0, 4.5 - d / 120); if (r > 0.3) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill() } }
        ctx.strokeStyle = st.fg; ctx.lineWidth = 6; ctx.strokeRect(50, 50, W - 100, H - 100)
    } else if (style === 'manuscript') {
        ctx.strokeStyle = st.accent; ctx.lineWidth = 10; ctx.strokeRect(46, 46, W - 92, H - 92); ctx.lineWidth = 3; ctx.strokeRect(70, 70, W - 140, H - 140)
        for (const [x, y] of [[70, 70], [W - 70, 70], [70, H - 70], [W - 70, H - 70]]) { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillStyle = '#2f4fa8'; ctx.fillRect(-16, -16, 32, 32); ctx.fillStyle = st.accent; ctx.fillRect(-8, -8, 16, 16); ctx.restore() }
    } else if (style === 'indigo') {
        ctx.strokeStyle = 'rgba(242,239,230,.13)'; ctx.lineWidth = 3
        for (let i = 0; i < 26; i++) { const x = rnd() * W, y = rnd() * H, r = 30 + rnd() * 70; for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(x, y, r - k * 12, 0, 7); ctx.stroke() } }
    } else if (style === 'kente') {
        const cols = ['#f6d66b', '#2f8a3b', '#c8372d', '#141210', '#f6d66b', '#1f4fa0']
        for (const yy of [0, H - 90]) for (let x = 0, i = 0; x < W; x += 45, i++) { ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(x, yy, 45, 90); ctx.fillStyle = cols[(i + 2) % cols.length]; for (let k = 8; k < 90; k += 20) ctx.fillRect(x + 8, yy + k, 29, 6) }
    } else if (style === 'broadsheet') {
        ctx.fillStyle = st.fg; ctx.fillRect(70, 150, W - 140, 6); ctx.fillRect(70, 166, W - 140, 2)
        ctx.font = `700 46px "${st.font}"`; ctx.textAlign = 'center'; ctx.fillText('The Daily Reader', W / 2, 130)
        ctx.fillRect(70, H - 160, W - 140, 2)
    } else if (style === 'train') {
        const g = ctx.createRadialGradient(W * 0.8, H * 0.12, 10, W * 0.8, H * 0.12, W * 0.9)
        g.addColorStop(0, 'rgba(224,168,76,.45)'); g.addColorStop(1, 'rgba(224,168,76,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
        ctx.strokeStyle = st.accent; ctx.lineWidth = 3; ctx.beginPath(); ctx.roundRect(60, 60, W - 120, H - 120, 40); ctx.stroke()
    } else if (style === 'zellige') {
        ctx.strokeStyle = 'rgba(233,185,73,.35)'; ctx.lineWidth = 3
        const s = 120
        for (let y = -s; y < H + s; y += s) for (let x = -s; x < W + s; x += s) {
            ctx.beginPath()
            for (let k = 0; k < 16; k++) { const ang = k * Math.PI / 8, r = k % 2 ? s * 0.26 : s * 0.5; ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r) }
            ctx.closePath(); ctx.stroke()
        }
        ctx.fillStyle = st.bg; ctx.beginPath(); ctx.roundRect(90, 160, W - 180, H - 320, 30); ctx.fill()
        ctx.strokeStyle = st.accent; ctx.lineWidth = 4; ctx.stroke()
    }
    // the quote, sized to fit
    const box = { x: style === 'zellige' ? 150 : 120, w: W - (style === 'zellige' ? 300 : 240), top: style === 'broadsheet' ? 230 : 190, bottom: H - (style === 'kente' ? 300 : 260) }
    let fs = 84, lines
    ctx.direction = arabic ? 'rtl' : 'ltr'
    for (; fs > 26; fs -= 3) {
        ctx.font = `${style === 'broadsheet' || style === 'manuscript' ? 'italic ' : ''}${style === 'kente' || style === 'train' || style === 'indigo' ? 400 : 700} ${fs}px "${font}"`
        lines = wrapLines(ctx, `“${text.trim()}”`, box.w)
        if (lines.length * fs * 1.28 <= box.bottom - box.top) break
    }
    const lh = fs * 1.28
    let y = box.top + (box.bottom - box.top - lines.length * lh) / 2 + fs
    ctx.textAlign = arabic ? 'right' : 'left'
    const x0 = arabic ? box.x + box.w : box.x
    for (const ln of lines) {
        if (style === 'riso') { ctx.fillStyle = st.accent; ctx.globalAlpha = 0.85; ctx.fillText(ln, x0 + 4, y + 3); ctx.globalAlpha = 1 }
        ctx.fillStyle = st.fg; ctx.fillText(ln, x0, y); y += lh
    }
    // source
    ctx.textAlign = 'center'; ctx.direction = 'ltr'
    ctx.fillStyle = style === 'riso' || style === 'zellige' ? st.accent : st.fg
    ctx.font = `400 ${style === 'manuscript' ? 30 : 32}px "${st.meta}"`
    const src = `${title}${author ? ' · ' + author : ''}`
    ctx.fillText(src.length > 60 ? src.slice(0, 58) + '…' : src, W / 2, H - (style === 'kente' ? 150 : style === 'broadsheet' ? 115 : 130))
    ctx.globalAlpha = 0.55; ctx.font = `400 22px "${st.meta}"`; ctx.fillText('read with Iqra', W / 2, H - (style === 'kente' ? 112 : 80)); ctx.globalAlpha = 1
}
export function quoteCard(rec, a) {
    const opts = { style: S.app.quoteStyle || 'riso', size: S.app.quoteSize || 'portrait', text: a.text.slice(0, 600), title: rec.title, author: rec.author }
    const canvas = h('canvas.quote-canvas')
    const redraw = () => { S.setApp('quoteStyle', opts.style); S.setApp('quoteSize', opts.size); drawCard(canvas, opts) }
    const styles = h('div.quote-styles', Object.entries(CARD_STYLES).map(([id, s]) => h('button', { class: id === opts.style ? 'on' : '', title: s.name, style: { background: s.bg, color: s.fg, borderColor: s.accent }, onclick: e => {
        styles.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); opts.style = id; redraw()
    } }, h('b', 'Aa'), h('small', s.name))))
    const textBox = h('textarea', { rows: 3, value: opts.text, oninput: () => { opts.text = textBox.value; redraw() } })
    textBox.style.fontFamily = 'inherit'
    const png = () => canvas.toDataURL('image/png').split(',')[1]
    modal({
        title: 'Quote card', wide: true, cls: 'quote-modal',
        body: h('div.quote-wrap', h('div.quote-preview', canvas),
            h('div.quote-side', h('label.field', h('span', 'Style')), styles,
                h('label.field', h('span', 'Shape')), segmented(Object.entries(SIZES).map(([id, s]) => [id, s[2]]), opts.size, v => { opts.size = v; redraw() }),
                h('label.field', h('span', 'Words on the card'), textBox))),
        actions: [
            { label: 'Copy image', run: async () => {
                try { const blob = await new Promise(r => canvas.toBlob(r, 'image/png')); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied. Paste it into WhatsApp, Instagram or anywhere.') } catch { toast('Could not copy the image', { type: 'error' }) }
                return false
            } },
            { label: 'Save as PNG…', primary: true, run: async () => {
                const name = `${rec.title.replace(/[<>:"/\\|?*]/g, ' ').slice(0, 50)} - quote.png`
                const p = await api.invoke('dialog:save', { title: 'Save quote card', defaultPath: name, filters: [{ name: 'PNG image', extensions: ['png'] }] }, png(), 'base64')
                if (p) toast('Quote card saved')
                return !!p
            } },
        ],
    })
    redraw()
}
