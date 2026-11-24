// Focus sessions and ambient sound. Every sound is made live with Web Audio (no recordings),
// so it works offline and adds nothing to the download.
import { data, db } from './db.js'
import { h, $, icon, iconBtn, toast, dayKey, clamp } from './ui.js'
import { S } from './settings.js'

const SOUNDS = {
    rain: { name: 'Rain', icon: 'cloud-rain' },
    wind: { name: 'Harmattan wind', icon: 'wind' },
    waves: { name: 'Ocean waves', icon: 'waves' },
    fire: { name: 'Fireplace', icon: 'flame' },
    train: { name: 'Night train', icon: 'train-front' },
    brown: { name: 'Deep hum', icon: 'audio-lines' },
}

// ---------- the sound engine ----------
let ctx = null, master = null
const voices = {}
function audio() {
    if (!ctx) {
        ctx = new AudioContext()
        master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') ctx.resume()
    return ctx
}
function noiseBuffer(kind, seconds = 6) {
    const c = audio(), n = c.sampleRate * seconds, buf = c.createBuffer(2, n, c.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch)
        let last = 0, b0 = 0, b1 = 0, b2 = 0
        for (let i = 0; i < n; i++) {
            const w = Math.random() * 2 - 1
            if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5 }
            else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11 }
            else d[i] = w * 0.5
        }
        // fade the ends so the loop has no click
        for (let i = 0; i < 2000; i++) { const f = i / 2000; d[i] *= f; d[n - 1 - i] *= f }
    }
    return buf
}
const buffers = {}
function loop(kind) {
    const c = audio()
    const src = c.createBufferSource()
    src.buffer = buffers[kind] ??= noiseBuffer(kind)
    src.loop = true
    src.loopStart = 0.1; src.loopEnd = src.buffer.duration - 0.1
    src.start(0, Math.random() * 3)
    return src
}
const filt = (type, freq, q = 0.7) => { const f = audio().createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f }
const gain = v => { const g = audio().createGain(); g.gain.value = v; return g }
const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1] }
function burst(out, { len = 0.01, freq = 3000, type = 'highpass', q = 1, vol = 0.3, at = 0, buf = 'white' }) {
    const c = audio(), s = c.createBufferSource()
    s.buffer = buffers[buf] ??= noiseBuffer(buf)
    const g = c.createGain(), f = filt(type, freq, q)
    const t = c.currentTime + at
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + Math.min(0.004, len / 3)); g.gain.exponentialRampToValueAtTime(0.0001, t + len)
    chain(s, f, g, out)
    s.start(t, Math.random() * 4, len + 0.05)
}
const BUILD = {
    rain(out) {
        const bed = chain(loop('pink'), filt('highpass', 500), filt('lowpass', 7000), gain(0.55), out)
        const low = chain(loop('brown'), filt('lowpass', 400), gain(0.25), out)
        const timer = setInterval(() => { for (let i = 0; i < 6; i++) if (Math.random() < 0.6) burst(out, { len: 0.012 + Math.random() * 0.02, freq: 2500 + Math.random() * 5000, type: 'bandpass', q: 2, vol: 0.05 + Math.random() * 0.12, at: Math.random() * 0.25 }) }, 250)
        return () => { clearInterval(timer); bed.disconnect(); low.disconnect() }
    },
    wind(out) {
        const c = audio()
        const bp = filt('bandpass', 500, 0.9), g = gain(0.6)
        chain(loop('pink'), bp, g, out)
        const hiss = chain(loop('white'), filt('highpass', 3000), gain(0.04), out)
        let alive = true
        const gust = () => {
            if (!alive) return
            const t = c.currentTime, d = 3 + Math.random() * 5
            bp.frequency.linearRampToValueAtTime(250 + Math.random() * 900, t + d)
            g.gain.linearRampToValueAtTime(0.25 + Math.random() * 0.75, t + d)
            setTimeout(gust, d * 1000)
        }
        gust()
        return () => { alive = false; g.disconnect(); hiss.disconnect() }
    },
    waves(out) {
        const c = audio()
        const lp = filt('lowpass', 500), g = gain(0.1)
        chain(loop('brown'), lp, g, out)
        const spray = gain(0.0); chain(loop('pink'), filt('highpass', 1200), spray, out)
        let alive = true
        const wave = () => {
            if (!alive) return
            const t = c.currentTime, rise = 2.5 + Math.random() * 2, fall = 3.5 + Math.random() * 3, peak = 0.5 + Math.random() * 0.5
            g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t)
            g.gain.linearRampToValueAtTime(peak, t + rise); g.gain.linearRampToValueAtTime(0.1, t + rise + fall)
            lp.frequency.setValueAtTime(lp.frequency.value, t); lp.frequency.linearRampToValueAtTime(1400, t + rise); lp.frequency.linearRampToValueAtTime(400, t + rise + fall)
            spray.gain.setValueAtTime(0, t); spray.gain.linearRampToValueAtTime(0.06 * peak, t + rise + 0.3); spray.gain.linearRampToValueAtTime(0, t + rise + fall * 0.8)
            setTimeout(wave, (rise + fall - 0.6) * 1000)
        }
        wave()
        return () => { alive = false; g.disconnect(); spray.disconnect() }
    },
    fire(out) {
        const bed = chain(loop('brown'), filt('lowpass', 600), gain(0.5), out)
        const hiss = chain(loop('white'), filt('bandpass', 2500, 0.6), gain(0.015), out)
        let alive = true
        const crackle = () => {
            if (!alive) return
            const n = Math.random() < 0.15 ? 4 + Math.random() * 6 : 1
            for (let i = 0; i < n; i++) burst(out, { len: 0.004 + Math.random() * 0.02, freq: 800 + Math.random() * 4000, type: 'bandpass', q: 1.5, vol: 0.1 + Math.random() * 0.35, at: i * (0.01 + Math.random() * 0.05) })
            setTimeout(crackle, 60 + Math.random() * 500)
        }
        crackle()
        return () => { alive = false; bed.disconnect(); hiss.disconnect() }
    },
    train(out) {
        const rumble = chain(loop('brown'), filt('lowpass', 160), gain(0.9), out)
        const air = chain(loop('pink'), filt('bandpass', 900, 0.5), gain(0.07), out)
        let alive = true
        const clack = () => {
            if (!alive) return
            // two wheels over each rail joint: clack-clack ... clack-clack
            for (const at of [0, 0.13, 0.62, 0.75]) burst(out, { len: 0.07, freq: 260 + Math.random() * 60, type: 'bandpass', q: 3, vol: 0.55, at, buf: 'brown' })
            setTimeout(clack, 1250 + Math.random() * 80)
        }
        clack()
        return () => { alive = false; rumble.disconnect(); air.disconnect() }
    },
    brown(out) {
        const n = chain(loop('brown'), filt('lowpass', 900), gain(0.8), out)
        return () => n.disconnect()
    },
}
const mix = () => ({ ...(data.study.ambient ?? {}) })
function setVoice(id, vol) {
    const c = audio()
    let v = voices[id]
    if (vol > 0 && !v) {
        const out = c.createGain(); out.gain.value = 0; out.connect(master)
        v = voices[id] = { out, stop: BUILD[id](out) }
    }
    if (!v) return
    v.out.gain.setTargetAtTime(vol * vol, c.currentTime, 0.4)
    if (vol <= 0) {
        const vv = v; delete voices[id]
        setTimeout(() => { vv.stop(); vv.out.disconnect() }, 1500)
    }
}
export const ambient = {
    get playing() { return Object.keys(voices).length > 0 },
    set(id, vol) { db.set('study', ['ambient', id], vol || null); setVoice(id, vol) },
    resume() { for (const [id, v] of Object.entries(mix())) if (v > 0) setVoice(id, v) },
    stopAll() { for (const id of Object.keys(voices)) setVoice(id, 0) },
    toggle() { this.playing ? this.stopAll() : (Object.keys(mix()).length ? this.resume() : this.set('rain', 0.6)); focus.drawPill() },
}

// ---------- chime at the end of a session ----------
function chime() {
    const c = audio()
    ;[523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + i * 0.18
        o.type = 'sine'; o.frequency.value = f
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8)
        o.connect(g); g.connect(master); o.start(t); o.stop(t + 2)
    })
}

// ---------- focus session ----------
const state = { end: 0, total: 0, timer: null, paused: 0 }
const left = () => state.paused || Math.max(0, state.end - Date.now())
const fmt = ms => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
export const focus = {
    get active() { return !!state.total },
    start(min) {
        state.total = min * 60000; state.end = Date.now() + state.total; state.paused = 0
        clearInterval(state.timer); state.timer = setInterval(() => this.tick(), 1000)
        if (S.app.focusSounds !== false && !ambient.playing && Object.keys(mix()).length) ambient.resume()
        document.documentElement.classList.add('focusing')
        this.drawPill()
    },
    pause() {
        if (!state.total) return
        if (state.paused) { state.end = Date.now() + state.paused; state.paused = 0 } else state.paused = left()
        this.drawPill()
    },
    stop(done) {
        const minutes = Math.round((state.total - left()) / 60000)
        clearInterval(state.timer)
        if (minutes >= 1) {
            db.inc('study', ['focus', 'minutes'], minutes)
            db.inc('study', ['focus', 'days', dayKey()], minutes)
            if (done) db.inc('study', ['focus', 'sessions'], 1)
        }
        state.total = 0; state.paused = 0
        document.documentElement.classList.remove('focusing')
        if (done) { chime(); this.celebrate(minutes) }
        this.drawPill()
    },
    tick() {
        if (state.paused) return
        if (left() <= 0) return this.stop(true)
        this.drawPill()
    },
    celebrate(minutes) {
        const sessions = data.study.focus?.sessions ?? 1
        const el = h('div.focus-done', h('div.fd-stamp', h('small', 'session'), h('b', `${minutes} min`), h('small', `no. ${sessions}`)),
            h('p', 'Nicely done. Stretch, drink some water, then go again?'),
            h('div.btnrow', h('button.btn', { onclick: () => el.remove() }, 'Done for now'), h('button.btn.primary', { onclick: () => { el.remove(); this.start(Math.round(state.lastMin ?? 25)) } }, 'Another round')))
        document.body.append(el)
        setTimeout(() => el.remove(), 30000)
    },
    drawPill() {
        let pill = $('#focus-pill')
        if (!state.total && !ambient.playing) return pill?.remove()
        if (!pill) { pill = h('div', { id: 'focus-pill' }); document.body.append(pill) }
        const pct = state.total ? 1 - left() / state.total : 0
        pill.replaceChildren(
            state.total ? h('div.fp-ring', { style: { '--p': pct } }) : null,
            state.total ? h('b.fp-time', { title: 'Time left in this focus session' }, fmt(left())) : h('small.fp-label', 'sounds on'),
            state.total ? iconBtn(state.paused ? 'play' : 'pause', state.paused ? 'Resume' : 'Pause', () => this.pause()) : null,
            iconBtn(ambient.playing ? 'volume-2' : 'volume-x', ambient.playing ? 'Mute sounds' : 'Play sounds', () => ambient.toggle()),
            iconBtn('sliders-horizontal', 'Sounds and session', e => this.panel(e.currentTarget)),
            state.total ? iconBtn('square', 'End session', () => this.stop(false)) : null)
        pill.classList.toggle('paused', !!state.paused)
    },
    panel(anchor) {
        $('.focus-panel')?.remove()
        const m = mix()
        const close = () => { panel.remove(); document.removeEventListener('mousedown', outside, true) }
        const outside = e => { if (!panel.contains(e.target) && !e.target.closest?.('#focus-pill, [title^="Focus"]')) close() }
        const lastMin = S.app.focusMinutes ?? 25
        const panel = h('div.focus-panel',
            h('header', h('b', 'Focus'), iconBtn('x', 'Close', close)),
            state.total
                ? h('div.fp-running', h('p', `${fmt(left())} left in this session`), h('div.btnrow', h('button.btn.small', { onclick: () => { this.pause(); close() } }, state.paused ? 'Resume' : 'Pause'), h('button.btn.small', { onclick: () => { this.stop(false); close() } }, 'End session')))
                : h('div.fp-start', h('p.muted.small', 'Read without stopping for a while. A soft chime tells you when time is up.'),
                    h('div.fp-times', [15, 25, 45, 60].map(n => h('button.btn', { class: n === lastMin ? 'primary' : '', onclick: () => { S.setApp('focusMinutes', n); state.lastMin = n; this.start(n); close() } }, h('b', String(n)), h('small', 'min'))))),
            h('h4', 'Sounds'),
            h('div.fp-sounds', Object.entries(SOUNDS).map(([id, s]) => {
                const vol = m[id] ?? 0
                const input = h('input', { type: 'range', min: 0, max: 1, step: 0.02, value: vol, oninput: () => { ambient.set(id, +input.value); row.classList.toggle('on', +input.value > 0); this.drawPill() } })
                const row = h('label.fp-sound', { class: vol > 0 && voices[id] ? 'on' : '' }, icon(s.icon, 16), h('span', s.name), input)
                return row
            })),
            h('div.fp-foot', h('small.muted', (() => { const f = data.study.focus ?? {}; return `${f.sessions ?? 0} sessions · ${Math.round((f.minutes ?? 0) / 60 * 10) / 10} hours focused` })()),
                h('button.link', { onclick: () => { ambient.stopAll(); db.set('study', ['ambient'], null); close(); this.drawPill() } }, 'Silence all')))
        document.body.append(panel)
        const r = anchor?.getBoundingClientRect?.()
        if (r) {
            const pr = panel.getBoundingClientRect()
            panel.style.left = `${clamp(r.right - pr.width, 8, innerWidth - pr.width - 8)}px`
            panel.style.top = `${r.bottom + pr.height + 8 > innerHeight ? Math.max(8, r.top - pr.height - 8) : r.bottom + 8}px`
        }
        setTimeout(() => document.addEventListener('mousedown', outside, true))
    },
}
