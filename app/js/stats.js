// Reading stats: time tracking while a book is open, streaks, goals, and the stats page.
import { h, icon, fmtDuration, dayKey, slider } from './ui.js'
import { data, db } from './db.js'
import { lib } from './store.js'
import { S } from './settings.js'

const days = () => data.stats.days ?? {}
export const todayStats = () => ({ sec: days()[dayKey()]?.sec ?? 0, loc: days()[dayKey()]?.loc ?? 0 })
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const ACTIVE = 60 // a day counts toward the streak after one minute of reading

export function streak() {
    let n = 0, d = new Date()
    if ((days()[dayKey(d)]?.sec ?? 0) < ACTIVE) d = addDays(d, -1) // today not read yet does not break the streak
    while ((days()[dayKey(d)]?.sec ?? 0) >= ACTIVE) { n++; d = addDays(d, -1) }
    return n
}
function bestStreak() {
    const keys = Object.keys(days()).filter(k => days()[k].sec >= ACTIVE).sort()
    let best = 0, run = 0, prev = null
    for (const k of keys) {
        run = prev && dayKey(addDays(new Date(prev + 'T12:00'), 1)) === k ? run + 1 : 1
        best = Math.max(best, run); prev = k
    }
    return best
}
// personal pace in "locations" (about a page of text) per minute; falls back to an average reader
export function pace() {
    const t = data.stats.total ?? {}
    return t.sec > 1200 && t.loc > 20 ? Math.min(3, Math.max(0.2, t.loc / (t.sec / 60))) : 1.07
}

export const tracker = {
    bookId: null, last: 0, pending: 0, pendingLoc: 0, timer: null, speaking: false,
    start(bookId) {
        this.stop()
        this.bookId = bookId; this.last = Date.now()
        this.timer = setInterval(() => {
            const active = !document.hidden && (this.speaking || (document.hasFocus() && Date.now() - this.last < 120000))
            if (active) this.pending += 5
            if (this.pending >= 30) this.flush()
        }, 5000)
    },
    activity() { this.last = Date.now() },
    progress(deltaLoc) { if (deltaLoc > 0 && deltaLoc < 12) this.pendingLoc += deltaLoc },
    flush() {
        if (!this.bookId || (!this.pending && !this.pendingLoc)) return
        const k = dayKey(), ops = []
        if (this.pending) ops.push([['days', k, 'sec'], this.pending, 'inc'], [['days', k, 'books', this.bookId], this.pending, 'inc'], [['total', 'sec'], this.pending, 'inc'])
        if (this.pendingLoc) ops.push([['days', k, 'loc'], this.pendingLoc, 'inc'], [['total', 'loc'], this.pendingLoc, 'inc'])
        db.patch('stats', ops)
        this.pending = 0; this.pendingLoc = 0
    },
    stop() { this.flush(); clearInterval(this.timer); this.timer = null; this.bookId = null },
}

export function renderStats(el) {
    const d = days()
    const today = new Date()
    const year = today.getFullYear()
    const goals = S.goals
    const secOn = date => d[dayKey(date)]?.sec ?? 0
    let week = 0
    for (let i = 0; i < 7; i++) week += secOn(addDays(today, -i))
    const totalSec = Object.values(d).reduce((s, x) => s + (x.sec ?? 0), 0)
    const totalLoc = Object.values(d).reduce((s, x) => s + (x.loc ?? 0), 0)
    const finished = Object.entries(data.stats.finished ?? {})
    const finishedYear = finished.filter(([, day]) => day.startsWith(String(year)))
    const goalDays = Object.values(d).filter(x => x.sec >= goals.dailyMinutes * 60).length
    const stat = (ic, value, label, sub) => h('div.stat', icon(ic, 20), h('b', value), h('span', label), sub ? h('small', sub) : null)

    // last 30 days
    const last30 = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29))
    const max = Math.max(goals.dailyMinutes * 60, ...last30.map(secOn), 60)
    const bars = h('div.bars', { style: { '--goal': `${(goals.dailyMinutes * 60 / max) * 100}%` } },
        h('div.goal-line', h('span', `Goal ${goals.dailyMinutes} min`)),
        last30.map(date => {
            const s = secOn(date)
            return h('div.barcol', { title: `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${s ? fmtDuration(s) : 'no reading'}` },
                h('i', { class: s >= goals.dailyMinutes * 60 ? 'met' : '', style: { height: `${Math.max(s ? 2 : 0, (s / max) * 100)}%` } }),
                h('small', date.getDate() === 1 || date.getDay() === 1 ? String(date.getDate()) : ''))
        }))

    // year heatmap
    const start = addDays(new Date(year, 0, 1), -new Date(year, 0, 1).getDay())
    const cells = []
    for (let dt = new Date(start); dt.getFullYear() <= year && !(dt.getFullYear() === year && dt > addDays(new Date(year, 11, 31), 0)); dt = addDays(dt, 1)) {
        const s = secOn(dt), inYear = dt.getFullYear() === year
        const lvl = !s ? 0 : s < 600 ? 1 : s < 1800 ? 2 : s < 3600 ? 3 : 4
        cells.push(h('i', { class: `l${lvl}${inYear ? '' : ' out'}${dt > today ? ' future' : ''}`, title: `${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${s ? fmtDuration(s) : 'no reading'}` }))
    }

    // most-read books
    const perBook = {}
    for (const x of Object.values(d)) for (const [id, s] of Object.entries(x.books ?? {})) perBook[id] = (perBook[id] ?? 0) + s
    const top = Object.entries(perBook).map(([id, s]) => [lib.get(id), s]).filter(([b]) => b).sort((a, b) => b[1] - a[1]).slice(0, 8)
    const topMax = top[0]?.[1] ?? 1
    const genreCount = {}
    for (const [id] of finished) for (const g of lib.get(id)?.genres ?? []) genreCount[g] = (genreCount[g] ?? 0) + 1
    const genres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
    const gMax = genres[0]?.[1] ?? 1

    el.replaceChildren(h('div.stats-page',
        h('div.stat-row',
            stat('clock', fmtDuration(secOn(today), true), 'Today', `Goal: ${goals.dailyMinutes} min`),
            stat('calendar-days', fmtDuration(week, true), 'Last 7 days', `${fmtDuration(week / 7, true)} a day on average`),
            stat('flame', String(streak()), 'Day streak', `Best: ${bestStreak()} days`),
            stat('trophy', `${finishedYear.length} / ${goals.yearlyBooks}`, `Books finished in ${year}`, `${finished.length} finished overall`),
            stat('book-open', fmtDuration(totalSec, true), 'Total reading time', `About ${Math.round(totalLoc)} pages · goal met on ${goalDays} days`)),
        h('section.panel', h('h2', 'Last 30 days'), bars),
        h('section.panel', h('h2', `${year} at a glance`), h('div.heat', cells),
            h('div.legend', 'Less ', h('i.l0'), h('i.l1'), h('i.l2'), h('i.l3'), h('i.l4'), ' More')),
        h('div.two',
            h('section.panel', h('h2', 'Most-read books'), top.length ? top.map(([b, s]) => h('div.hbar', h('span.name', b.title), h('div.track', h('i', { style: { width: `${(s / topMax) * 100}%` } })), h('span.val', fmtDuration(s, true)))) : h('p.muted', 'Open a book and your reading time shows up here.')),
            h('section.panel', h('h2', 'Finished by genre'), genres.length ? genres.map(([g, n]) => h('div.hbar', h('span.name', g), h('div.track', h('i', { style: { width: `${(n / gMax) * 100}%` } })), h('span.val', String(n)))) : h('p.muted', 'Finish a book to see which genres you read most.'))),
        h('section.panel', h('h2', 'Goals'),
            h('div.row', h('div.row-label', h('span', 'Daily reading goal')), h('div.row-ctl', slider({ min: 5, max: 180, step: 5, value: goals.dailyMinutes, onchange: v => db.set('settings', ['goals', 'dailyMinutes'], v), fmt: v => v + ' min' }))),
            h('div.row', h('div.row-label', h('span', 'Books to finish this year')), h('div.row-ctl', slider({ min: 1, max: 150, value: goals.yearlyBooks, onchange: v => db.set('settings', ['goals', 'yearlyBooks'], v), fmt: v => v + ' books' }))))))
}
