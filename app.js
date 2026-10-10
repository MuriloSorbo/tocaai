'use strict';

/* =====================================================================
   toca aí — quiz de música brasileira
   Arquitetura: o "host" (quem cria o jogo) é dono do estado S e aplica
   todas as ações. Num jogo local, host e tela são o mesmo aparelho.
   Online, o convidado recebe S pela sala (MQTT) e manda ações de volta.
   Cada aparelho cuida do próprio áudio (Deezer / YouTube) olhando S.
   ===================================================================== */

/* ===================== dados ===================== */

const CAT_META = {
  rock:      { name: 'Rock Nacional', color: '#E4572E' },
  mpb:       { name: 'MPB',           color: '#2F6F5E' },
  classicos: { name: 'Clássicos',     color: '#C9A227' },
  samba:     { name: 'Samba',         color: '#B5446E' },
  pagode:    { name: 'Pagode',        color: '#F2A541' },
  funk:      { name: 'Funk',          color: '#2B59C3' },
  anos80:    { name: 'Anos 80',       color: '#E86FA8' },
  anos90:    { name: 'Anos 90',       color: '#2E86AB' },
  anos2000:  { name: 'Anos 2000',     color: '#8AA337' },
  axe:       { name: 'Axé',           color: '#F2C230' },
  sertanejo: { name: 'Sertanejo',     color: '#8C5A3C' },
  forro:     { name: 'Forró',         color: '#D9822B' },
  rap:       { name: 'Rap Nacional',  color: '#3A3632' },
  reggae:    { name: 'Reggae',        color: '#4C9A2A' },
  pop:       { name: 'Pop BR',        color: '#C2549E' },
};
const HOME_ORDER = ['rock', 'mpb', 'pagode', 'funk', 'anos2000', 'classicos', 'anos80', 'anos90',
                    'samba', 'axe', 'sertanejo', 'forro', 'rap', 'reggae', 'pop'];

const DB = window.TOCAAI_DB;
const CATS = DB.cats.map((id, i) => ({ id, bit: 1 << i, ...CAT_META[id] }));
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const SONGS = DB.songs.map(r => ({ id: r[0], t: r[1], a: r[2], cover: r[3], rank: r[4], mask: r[5], lrc: r[6], cm: r[7] || 0, yt: r[8] || '' }));
const SONG = new Map(SONGS.map(s => [s.id, s]));

const coverUrl = (s, size = 250) => s && s.cover
  ? `https://cdn-images.dzcdn.net/images/cover/${s.cover}/${size}x${size}-000000-80-0-0.jpg` : '';

/* ===================== utilidades ===================== */

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const uid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('tocaai.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tocaai.' + k, JSON.stringify(v)); } catch { /* sem storage */ } },
};
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#151413' : '#fbf9f5';
}
function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 2600);
}

/* relógio do host: no convidado, Clock.now() estima a hora do host */
const Clock = { offset: 0, best: Infinity, now() { return Date.now() + this.offset; } };

/* --- comparação de respostas --- */
const STOP = new Set(['o', 'a', 'os', 'as', 'e', 'de', 'da', 'do', 'das', 'dos', 'the', 'banda', 'grupo', 'mc', 'and']);
const CANON = { para: 'pra', esta: 'ta', estou: 'to', voce: 'ce', vc: 'ce', estar: 'ta', num: 'nao' };
function nrm(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' e ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function core(s) { return nrm(String(s).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')).split(' ').filter(w => w && !STOP.has(w)).join(' '); }
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);
function matches(input, target) {
  const ci = core(input).replace(/ /g, ''), ct = core(target).replace(/ /g, '');
  if (!ci || !ct) return false;
  if (ci === ct || sim(ci, ct) >= 0.8) return true;
  if (ct.length >= 6 && ct.includes(ci) && ci.length >= ct.length * 0.6) return true;
  const parts = String(target).split(/\s+(?:&|e|x|feat\.?|part\.?)\s+|,\s*/i).filter(p => p !== target);
  return parts.some(p => { const cp = core(p).replace(/ /g, ''); return cp.length >= 5 && (cp === ci || sim(cp, ci) >= 0.85); });
}
function words(s) { return nrm(s).split(' ').filter(Boolean).map(w => CANON[w] || w); }
function wordEq(a, b) {
  if (a === b) return true;
  const d = lev(a, b);
  return (a.length >= 4 && d <= 1) || (a.length >= 7 && d <= 2);
}
function lyricScore(input, hidden) {
  const tgt = words(hidden), inp = words(input), used = [];
  const hits = tgt.map(t => {
    const j = inp.findIndex((w, k) => !used[k] && wordEq(t, w));
    if (j >= 0) { used[j] = true; return true; }
    return false;
  });
  return { ratio: tgt.length ? hits.filter(Boolean).length / tgt.length : 0, hits };
}

/* ===================== rede: Deezer e LRCLIB ===================== */

function jsonp(url, ms = 8000) {
  return new Promise((resolve, reject) => {
    const cb = 'dz_' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const done = () => { clearTimeout(t); window[cb] = () => {}; s.remove(); };
    const t = setTimeout(() => { done(); reject(new Error('timeout')); }, ms);
    window[cb] = data => { done(); resolve(data); };
    s.onerror = () => { done(); reject(new Error('rede')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
    document.head.appendChild(s);
  });
}
const previewCache = new Map(); // id -> {url, at}
async function getPreview(id) {
  const c = previewCache.get(id);
  if (c && Date.now() - c.at < 8 * 60e3) return c.url; // links do Deezer expiram em ~15 min
  const d = await jsonp('https://api.deezer.com/track/' + id);
  if (!d || d.error || !d.preview) throw new Error('sem prévia');
  previewCache.set(id, { url: d.preview, at: Date.now() });
  return d.preview;
}
function loadAudio(url, ms = 10000) {
  return new Promise((resolve, reject) => {
    const a = new Audio();
    a.preload = 'auto';
    const t = setTimeout(() => { cleanup(); a.readyState >= 2 ? resolve(a) : reject(new Error('áudio lento')); }, ms);
    const ok = () => { cleanup(); resolve(a); };
    const bad = () => { cleanup(); reject(new Error('áudio falhou')); };
    function cleanup() { clearTimeout(t); a.removeEventListener('canplaythrough', ok); a.removeEventListener('error', bad); }
    a.addEventListener('canplaythrough', ok);
    a.addEventListener('error', bad);
    a.src = url;
    a.load();
  });
}
async function getLyrics(lrcId) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch('https://lrclib.net/api/get/' + lrcId, { signal: ctrl.signal });
    if (!r.ok) throw new Error('letra ' + r.status);
    const d = await r.json();
    if (!d.syncedLyrics) throw new Error('sem letra sincronizada');
    return d.syncedLyrics;
  } finally { clearTimeout(t); }
}

/* ===================== som (prévias do Deezer) ===================== */

const Sound = {
  vol: store.get('vol', 0.8),
  muted: store.get('muted', false),
  cur: null,
  level() { return this.muted ? 0 : this.vol; },
  apply() {
    document.body.classList.toggle('muted', this.muted);
    if (this.cur) this.cur.volume = this.level();
    YTP.setVolume(this.level());
  },
  async play(audio, at = 0) {
    if (this.cur !== audio) this.stop();
    this.cur = audio;
    try { audio.currentTime = at; } catch { /* ainda sem metadados */ }
    audio.volume = this.level();
    try { await audio.play(); return true; } catch { return false; }
  },
  stop() {
    const a = this.cur; this.cur = null;
    if (!a) return;
    const v0 = a.volume; let i = 0;
    const iv = setInterval(() => {
      if (Sound.cur === a) { clearInterval(iv); a.volume = Sound.level(); return; }
      i++; a.volume = Math.max(0, v0 * (1 - i / 8));
      if (i >= 8) { clearInterval(iv); a.pause(); }
    }, 30);
  },
};

/* ===================== YouTube (música completa no modo letra) ===================== */

const YTP = {
  api: null, player: null, created: null, handlers: {}, ok: false, vid: '',
  loadApi() {
    if (this.api) return this.api;
    this.api = new Promise((res, rej) => {
      if (window.YT && window.YT.Player) return res();
      window.onYouTubeIframeAPIReady = () => res();
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { this.api = null; rej(new Error('yt api')); };
      document.head.appendChild(s);
      setTimeout(() => rej(new Error('yt api timeout')), 10000);
    });
    return this.api;
  },
  async get() {
    await this.loadApi();
    if (this.created) return this.created;
    this.created = new Promise((res, rej) => {
      const p = new YT.Player('ytplayer', {
        width: 200, height: 112,
        host: 'https://www.youtube-nocookie.com',
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => { this.player = p; res(p); },
          onStateChange: e => this.handlers.state && this.handlers.state(e.data),
          onError: e => this.handlers.error && this.handlers.error(e.data),
        },
      });
      setTimeout(() => rej(new Error('yt player timeout')), 12000);
    });
    this.created.catch(() => { this.created = null; });
    return this.created;
  },
  /* carrega o vídeo mudo, espera tocar, pausa no ponto de partida: fica pronto pra dar play na hora certa */
  async prepare(vid, start) {
    const p = await this.get();
    this.ok = false; this.vid = vid;
    await new Promise((res, rej) => {
      let done = false;
      const finish = ok => {
        if (done) return; done = true; clearTimeout(t);
        this.handlers = {};
        ok ? res() : rej(new Error('yt não carregou'));
      };
      const t = setTimeout(() => finish(false), 18000);
      this.handlers.state = st => {
        if (st === 1) { p.pauseVideo(); p.seekTo(start, true); setTimeout(() => finish(true), 250); }
      };
      this.handlers.error = () => finish(false);
      p.mute();
      p.loadVideoById({ videoId: vid, startSeconds: start });
    });
    p.unMute();
    p.setVolume(Math.round(Sound.level() * 100));
    this.ok = true;
  },
  play(from) {
    if (!this.player || !this.ok) return;
    if (from != null) this.player.seekTo(from, true);
    this.player.setVolume(Math.round(Sound.level() * 100));
    this.player.playVideo();
  },
  pause() { if (this.player && this.player.pauseVideo) try { this.player.pauseVideo(); } catch { /* */ } },
  stop() { this.pause(); this.ok = false; },
  playing() { try { return !!this.player && this.player.getPlayerState() === 1; } catch { return false; } },
  time() { try { return this.player.getCurrentTime(); } catch { return 0; } },
  setVolume(v) { if (this.player && this.player.setVolume) try { this.player.setVolume(Math.round(v * 100)); } catch { /* */ } },
};

/* ===================== sala online (MQTT público) ===================== */

const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];

const Room = {
  id: null, role: null, b: 0, client: null, connected: false,
  guestId: null, guestSeen: 0, hostSeen: 0, epoch: null, lastSeq: -1, seen: new Set(),
  base() { return `tocaai/v2/${this.id}`; },
  link() { return `${location.origin}${location.pathname}#s=${this.id}${this.b ? '&b=' + this.b : ''}`; },
  connectTo(i) {
    return new Promise((res, rej) => {
      const c = mqtt.connect(BROKERS[i], { clientId: 'tocaai_' + uid(10), keepalive: 20, reconnectPeriod: 2000, connectTimeout: 7000, clean: true });
      let first = true;
      const t = setTimeout(() => { if (first) { first = false; c.end(true); rej(new Error('timeout')); } }, 8000);
      c.on('connect', () => {
        this.connected = true; updateRoomBar();
        c.subscribe(this.role === 'host' ? [this.base() + '/a', this.base() + '/p'] : [this.base() + '/s', this.base() + '/p'], { qos: 1 });
        if (first) { first = false; clearTimeout(t); res(c); }
        else if (this.role === 'guest') this.hello();
        else publishState();
      });
      c.on('close', () => { this.connected = false; updateRoomBar(); });
      c.on('message', (topic, buf) => this.onMessage(topic, buf.toString()));
      c.on('error', () => {});
    });
  },
  async host() {
    this.role = 'host'; this.id = uid(10); this.epoch = uid(6);
    for (let i = 0; i < BROKERS.length; i++) {
      try { this.client = await this.connectTo(i); this.b = i; break; } catch { /* tenta o próximo */ }
    }
    if (!this.client) throw new Error('sem conexão');
    clearInterval(this.hb);
    this.hb = setInterval(() => {
      this.pub('/p', { k: 'hb', th: Date.now() });
      updateRoomBar();
    }, 3000);
  },
  async join(id, b) {
    this.role = 'guest'; this.id = id; this.b = b || 0;
    this.guestId = sessionStorage.getItem('tocaai.gid') || uid(8);
    try { sessionStorage.setItem('tocaai.gid', this.guestId); } catch { /* */ }
    this.client = await this.connectTo(this.b);
    clearInterval(this.hb);
    this.hb = setInterval(() => { this.hello(); updateRoomBar(); }, 3000);
    this.hello();
  },
  hello() { this.pub('/p', { k: 'ping', gid: this.guestId, name: myName(), t0: Date.now() }); },
  pub(sub, obj, opts = { qos: 1 }) {
    if (!this.client) return;
    this.client.publish(this.base() + sub, typeof obj === 'string' ? obj : JSON.stringify(obj), opts);
  },
  sendState(s) { this.pub('/s', { epoch: this.epoch, s }, { qos: 1, retain: true }); },
  sendAction(a) { this.pub('/a', { gid: this.guestId, aid: uid(8), a }); },
  onMessage(topic, txt) {
    let m; try { m = JSON.parse(txt); } catch { return; }
    if (!m) return;
    const sub = topic.slice(this.base().length);
    if (this.role === 'host') {
      if (sub === '/p' && m.k === 'ping') {
        if (this.guestId && this.guestId !== m.gid && Date.now() - this.guestSeen < 15000) return; // sala cheia
        const isNew = this.guestId !== m.gid || Date.now() - this.guestSeen > 15000;
        this.guestId = m.gid; this.guestSeen = Date.now();
        this.pub('/p', { k: 'pong', gid: m.gid, t0: m.t0, th: Date.now() }, { qos: 0 });
        onGuestHello(m.name || 'Convidado', isNew);
      } else if (sub === '/a' && m.gid === this.guestId && m.a) {
        if (this.seen.has(m.aid)) return;
        this.seen.add(m.aid);
        this.guestSeen = Date.now();
        hostAct(Object.assign({}, m.a, { p: 1, fromGuest: true }));
      }
    } else {
      if (sub === '/s') {
        if (!m.s) return; // sala encerrada (retained limpo)
        if (m.epoch !== this.epoch) { this.epoch = m.epoch; this.lastSeq = -1; }
        if (m.s.seq <= this.lastSeq) return;
        this.lastSeq = m.s.seq; this.hostSeen = Date.now();
        receiveState(m.s);
      } else if (sub === '/p') {
        if (m.k === 'hb') this.hostSeen = Date.now();
        if (m.k === 'pong' && m.gid === this.guestId) {
          const t1 = Date.now(), rtt = t1 - m.t0;
          this.hostSeen = t1;
          if (rtt < Clock.best * 1.5 || rtt < 120) {
            const off = m.th - (m.t0 + rtt / 2);
            Clock.offset = Clock.best === Infinity ? off : (rtt <= Clock.best ? off : Clock.offset * 0.7 + off * 0.3);
            Clock.best = Math.min(Clock.best, rtt);
          }
        }
      }
    }
  },
  guestOnline() { return this.role === 'host' && this.guestId && Date.now() - this.guestSeen < 10000; },
  hostOnline() { return this.role === 'guest' && Date.now() - this.hostSeen < 10000; },
  leave() {
    clearInterval(this.hb);
    if (this.client) {
      if (this.role === 'host') this.client.publish(this.base() + '/s', '', { qos: 1, retain: true });
      const c = this.client;
      setTimeout(() => c.end(true), 300);
    }
    Object.assign(this, { id: null, role: null, client: null, connected: false, guestId: null, guestSeen: 0, hostSeen: 0, epoch: null, lastSeq: -1 });
    this.seen = new Set();
    Clock.offset = 0; Clock.best = Infinity;
    updateRoomBar();
  },
};

/* ===================== configuração ===================== */

const DEFAULT_CFG = { cats: ['rock'], mode: 'titulo', players: 'solo', where: 'local', input: 'opcoes', pool: 'classicas', rounds: '10', time: '15', names: ['', ''] };
let cfg = Object.assign({}, DEFAULT_CFG, store.get('cfg', {}));
cfg.cats = (cfg.cats || []).filter(c => CAT[c]);
if (!cfg.cats.length) cfg.cats = ['rock'];
if (!Array.isArray(cfg.names)) cfg.names = ['', ''];

const myName = () => (cfg.names[0] || '').trim() || (Room.role === 'guest' ? 'Convidado' : 'Jogador 1');
function catMask(cats) { return cats.reduce((m, c) => m | CAT[c].bit, 0); }
function inputChoices(c) {
  if (c.players === 'versus') return [];
  return c.mode === 'letra' ? ['digitar', 'cantar'] : ['opcoes', 'digitar'];
}
function fixCfg() {
  if (cfg.players === 'solo') cfg.where = 'local';
  if (Room.role === 'host' && cfg.players !== 'solo') cfg.where = 'online';
  const ch = inputChoices(cfg);
  if (ch.length && !ch.includes(cfg.input)) cfg.input = ch[0];
}
function buildPool(c) {
  const mask = catMask(c.cats);
  let pool = SONGS.filter(s => s.mask & mask);
  if (c.mode === 'letra') {
    pool = pool.filter(s => s.lrc);
    // no modo letra, prefere as que têm áudio sincronizado
    const synced = pool.filter(s => s.yt);
    if (synced.length >= (c.pool === 'classicas' ? 60 : 30)) pool = synced;
  }
  if (c.pool === 'classicas') {
    const classic = pool.filter(s => s.cm & mask);
    if (classic.length >= 30) return classic;
    pool.sort((a, b) => b.rank - a.rank);
    const extra = pool.filter(s => !(s.cm & mask)).slice(0, 30 - classic.length);
    return classic.concat(extra);
  }
  return pool;
}

/* ===================== estado do jogo ===================== */

let S = null;     // estado compartilhado
let H = null;     // dados só do host (fila de músicas etc.)
let ME = null;    // online: 0 = host, 1 = convidado. local: null
const isLocal = () => !Room.role;
const isHost = () => Room.role !== 'guest';
const versus = () => S && S.cfg.players === 'versus';
const coop = () => S && S.cfg.players === 'coop';
const nClients = () => (S && S.online ? 2 : 1);
const KEYS = { p1: ['q', 'w', 'a', 's'], p2: ['o', 'p', 'k', 'l'] };
const LETTERS = ['A', 'B', 'C', 'D'];

function commit() {
  S.seq = (S.seq || 0) + 1;
  render();
  Media.sync();
  publishState();
}
function publishState() { if (Room.role === 'host' && S) Room.sendState(S); }
function receiveState(s) {
  S = s;
  render();
  Media.sync();
}
/* toda ação do usuário passa por aqui */
function act(a) {
  if (Room.role === 'guest') {
    if (!Room.connected) { toast('Sem conexão com a sala…'); return; }
    Room.sendAction(a);
  } else hostAct(a);
}

/* ---------- host: lobby e início ---------- */

function newState(c, names) {
  const two = c.players !== 'solo';
  return {
    seq: S ? S.seq : 0,
    cfg: c, online: !!Room.role,
    names: names.slice(0, two ? 2 : 1),
    players: c.players === 'versus' ? names.slice(0, 2).map(n => ({ name: n, score: 0 }))
      : [{ name: c.players === 'coop' ? names.slice(0, 2).join(' & ') : (Room.role ? names[0] : 'Você'), score: 0 }],
    n: 0, total: +c.rounds, lives: 3, streak: 0, bestStreak: 0,
    phase: 'loading', round: null, history: [], record: null,
  };
}

function lobbyState() {
  S = {
    seq: S ? S.seq : 0, online: true, phase: 'lobby',
    cfg: JSON.parse(JSON.stringify(cfg)),
    names: [myName(), S && S.names && S.names[1] || ''],
    players: [], history: [],
  };
  if (!Room.guestOnline()) S.names[1] = '';
}

function onGuestHello(name, isNew) {
  if (!S) return;
  if (S.names[1] !== name) {
    S.names[1] = name;
    if (S.players.length === 2 && versus()) S.players[1].name = name;
    if (coop() && S.players[0]) S.players[0].name = S.names.join(' & ');
    commit();
  } else if (isNew) publishState();
  updateRoomBar();
}

function startGame() {
  const c = JSON.parse(JSON.stringify(cfg));
  const names = Room.role === 'host'
    ? [myName(), (S && S.names && S.names[1]) || 'Convidado']
    : [0, 1].map(i => (cfg.names[i] || '').trim() || `Jogador ${i + 1}`);
  const pool = buildPool(c);
  const recent = new Set(store.get('recent', []));
  H = {
    pool,
    distractPool: SONGS.filter(s => s.mask & catMask(c.cats)),
    queue: shuffle(pool.filter(s => !recent.has(s.id))).concat(shuffle(pool.filter(s => recent.has(s.id)))),
    qi: 0, next: null, timers: [], id: uid(6),
  };
  S = newState(c, names);
  show('game');
  hostNextRound();
}

function clearTimers() { if (H) { H.timers.forEach(clearTimeout); H.timers = []; } }
function hostTimer(at, fn) {
  const h = H;
  const t = setTimeout(() => { if (H === h) fn(); }, Math.max(0, at - Clock.now()));
  H.timers.push(t);
}

/* ---------- host: preparação das rodadas ---------- */

async function prepare(song, game) {
  const c = S.cfg;
  if (c.mode === 'letra') {
    const lrc = await getLyrics(song.lrc);
    const pick = pickLine(parseLrc(lrc));
    if (!pick) throw new Error('letra ruim');
    const sync = song.yt ? 'yt' : 'text';
    return { song: songInfo(song), kind: 'letra', sync, ...pick, ...lyricTimes(pick, sync) };
  }
  const url = await getPreview(song.id);
  const audio = await loadAudio(url);
  Media.cacheAudio(song.id, audio);
  const q = c.mode === 'misto' ? (Math.random() < 0.5 ? 'titulo' : 'artista') : c.mode;
  const { options, answer } = makeOptions(game, song, q);
  return { song: songInfo(song), kind: 'guess', q, options, answer };
}
const songInfo = s => ({ id: s.id, t: s.t, a: s.a, cover: s.cover, mask: s.mask, yt: s.yt });

async function prepareNext(game) {
  for (let tries = 0; tries < 10 && game.qi < game.queue.length; tries++) {
    if (H !== game) return null;
    const song = game.queue[game.qi++];
    try { return await prepare(song, game); }
    catch (e) { console.warn('pulando', song.t, '-', e.message); }
  }
  return null;
}

function makeOptions(game, song, q) {
  const key = s => q === 'artista' ? s.a : s.t;
  const right = key(song);
  const taken = [core(right)];
  const out = [right];
  const clash = k => !k || taken.some(x => x === k || (x.length > 3 && k.length > 3 && (x.includes(k) || k.includes(x))));
  const tryAdd = s => {
    if (q === 'artista' && s.a === song.a) return;
    const v = key(s), k = core(v);
    if (clash(k)) return;
    taken.push(k); out.push(v);
  };
  const near = game.distractPool.filter(s => s !== song && (s.mask & song.mask));
  if (q === 'titulo') {
    const same = shuffle(near.filter(s => s.a === song.a));
    if (same.length && Math.random() < 0.7) tryAdd(same[0]);
  }
  for (const s of shuffle(near.slice())) { if (out.length >= 4) break; tryAdd(s); }
  for (const s of shuffle(SONGS.slice())) { if (out.length >= 4) break; tryAdd(s); }
  shuffle(out);
  return { options: out, answer: out.indexOf(right) };
}

function parseLrc(txt) {
  const out = [];
  for (const line of txt.split('\n')) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!stamps.length || !text || !/[a-zà-ú]/i.test(text)) continue;
    for (const m of stamps) out.push({ t: +m[1] * 60 + +m[2], text });
  }
  return out.sort((a, b) => a.t - b.t);
}

function pickLine(lines) {
  if (lines.length < 6) return null;
  const count = new Map();
  for (const l of lines) { const k = core(l.text); count.set(k, (count.get(k) || 0) + 1); }
  const FILLER = /^(oh|ô|ó|uh|ah|eh|yeah|hey|la|lá|na|ná|uô|iê|ê|é|ai|ay|hum|uou|woo|ooh|uhu)$/i;
  const cands = [];
  lines.forEach((l, i) => {
    if (i < 2) return;
    const w = l.text.split(/\s+/);
    if (w.length < 4 || w.length > 12) return;
    const real = w.filter(x => !FILLER.test(x.replace(/[^\p{L}]/gu, '')));
    if (real.length < 4 || new Set(real.map(x => nrm(x))).size < 3) return;
    const k = Math.min(5, Math.max(2, Math.ceil(w.length * 0.45)));
    const hidden = w.slice(w.length - k).join(' ');
    const hk = core(hidden);
    if (hk.replace(/ /g, '').length < 5) return;
    if (w.slice(w.length - k).every(x => FILLER.test(x.replace(/[^\p{L}]/gu, '')))) return;
    const ctx = lines.slice(Math.max(0, i - 3), i);
    if (ctx.some(c => core(c.text) === core(l.text) || core(c.text).includes(hk))) return;
    if (l.t - ctx[0].t > 40) return; // contexto longe demais (solo instrumental no meio)
    const repeated = count.get(core(l.text)) > 1;
    const score = (repeated ? 2 : 0) + (i < lines.length * 0.65 ? 0.8 : 0) + Math.random() * 1.6;
    const next = lines[i + 1];
    cands.push({ ctx: ctx.map(x => ({ text: x.text, t: x.t })), tt: l.t, tEnd: next ? next.t : l.t + 4,
                 shown: w.slice(0, w.length - k).join(' '), hidden, score });
  });
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const { score, ...c } = cands[0];
  return c;
}

/* quando aparece cada linha (em "tempo da música"). Sem áudio, comprime os intervalos. */
function lyricTimes(pick, sync) {
  if (sync === 'yt') {
    const start = Math.max(0, pick.ctx[0].t - 4);
    return { start, show: pick.ctx.map(c => c.t), stopAt: pick.tt };
  }
  const show = []; let t = 1;
  pick.ctx.forEach((c, j) => {
    if (j) t += clamp(c.t - pick.ctx[j - 1].t, 1.1, 3.4) * 0.85;
    show.push(t);
  });
  const stopAt = t + clamp(pick.tt - pick.ctx[pick.ctx.length - 1].t, 1.1, 3.4) * 0.85;
  return { start: 0, show, stopAt };
}

/* ---------- host: fluxo ---------- */

async function hostNextRound() {
  const game = H;
  if (!game || !S) return;
  clearTimers();
  if (S.n >= S.total || (coop() && S.lives <= 0)) return hostEnd();
  S.n++;
  S.phase = 'loading';
  S.round = { id: uid(6), n: S.n };
  commit();
  let r = null;
  if (game.next) { r = await game.next; game.next = null; }
  if (!r) r = await prepareNext(game);
  if (H !== game) return;
  if (!r) {
    S.n--;
    if (S.n > 0 && game.qi >= game.queue.length) return hostEnd();
    S.phase = 'error'; commit(); return;
  }
  S.round = Object.assign({ id: S.round.id, n: S.n }, r, { answers: [null, null], gain: [0, 0], ready: [false, false] });
  store.set('recent', store.get('recent', []).filter(x => x !== r.song.id).concat(r.song.id).slice(-900));
  S.nextSong = null;
  game.next = prepareNext(game);
  game.next.then(x => { if (x && H === game && S) { S.nextSong = x.kind === 'guess' ? x.song.id : null; } });
  commit();
  const rid = S.round.id;
  hostTimer(Clock.now() + (r.kind === 'letra' ? 20000 : S.online ? 15000 : 9000), () => hostStart(rid));
}

function hostStart(rid) {
  const r = S.round;
  if (!r || r.id !== rid || S.phase !== 'loading') return;
  clearTimers();
  S.phase = 'play';
  r.startAt = Clock.now() + (S.online ? 1500 : 350);
  if (r.kind === 'guess') {
    r.endAt = r.startAt + roundSecs() * 1000;
    hostTimer(r.endAt + 150, () => { if (S.round === r && S.phase === 'play') revealGuess(); });
  } else {
    // segurança: se o player do host travar, abre a resposta mesmo assim
    hostTimer(r.startAt + (r.stopAt - r.start) * 1000 + 9000, () => hostAct({ type: 'lyricsDone', rid }));
  }
  commit();
}

function roundSecs() { return S.round && S.round.kind === 'letra' ? +S.cfg.time + 15 : +S.cfg.time; }

/* quanto do tempo sobrou (0..1) para uma resposta dada ms depois do início */
function fracFrom(ms) { return clamp(1 - ms / (roundSecs() * 1000), 0, 1); }
function mult(right) { const s = right ? S.streak + 1 : 0; return coop() ? (s >= 6 ? 2 : s >= 3 ? 1.5 : 1) : 1; }

function hostAct(a) {
  if (!S) return;
  const r = S.round;
  const p = a.p || 0;
  switch (a.type) {
    case 'ready':
      if (r && r.id === a.rid && S.phase === 'loading') {
        r.ready[p] = true;
        if (r.ready.slice(0, nClients()).every(Boolean)) hostStart(r.id);
      }
      return;
    case 'pick': {
      if (!r || r.kind !== 'guess' || S.phase !== 'play') return;
      const slot = versus() ? p : 0;
      if (r.answers[slot]) return;
      r.answers[slot] = { i: a.i, ms: clamp(a.ms || 0, 0, roundSecs() * 1000), by: p, ord: r.answers.filter(Boolean).length };
      if (!versus() || r.answers.every(Boolean)) return revealGuess();
      return commit();
    }
    case 'typed': {
      if (!r || r.kind !== 'guess' || S.phase !== 'play' || versus() || r.answers[0]) return;
      const target = r.q === 'artista' ? r.song.a : r.song.t;
      if (!matches(a.text || '', target)) return;
      r.answers[0] = { i: r.answer, ms: clamp(a.ms || 0, 0, roundSecs() * 1000), by: p, typed: a.text };
      return revealGuess();
    }
    case 'giveup':
      if (r && r.kind === 'guess' && S.phase === 'play' && !versus()) return revealGuess();
      if (r && r.kind === 'letra' && S.phase === 'answer' && !versus()) return finishLetra(false);
      return;
    case 'lyricsDone':
      if (!r || r.kind !== 'letra' || S.phase !== 'play' || (a.rid && a.rid !== r.id)) return;
      clearTimers();
      S.phase = 'answer';
      r.answerAt = Clock.now();
      r.endAt = r.answerAt + roundSecs() * 1000;
      hostTimer(r.endAt + 150, () => {
        if (S.round !== r || S.phase !== 'answer') return;
        if (versus() || S.cfg.input === 'digitar') finishLetra(false);
        else { S.phase = 'judge'; r.late = true; commit(); }
      });
      return commit();
    case 'lyric': {
      if (!r || r.kind !== 'letra' || S.phase !== 'answer' || versus()) return;
      const { ratio, hits } = lyricScore(a.text || '', r.hidden);
      const frac = fracFrom(a.ms || 0);
      r.typed = { text: a.text, ratio, hits, by: p };
      const right = ratio >= 0.75;
      if (right) r.gain[0] = Math.round((70 + 30 * ratio + 50 * frac) * mult(true));
      else if (ratio >= 0.4 && S.cfg.players === 'solo') r.gain[0] = Math.round(60 * ratio);
      return finishLetra(right);
    }
    case 'buzz':
      if (!r || r.kind !== 'letra' || S.phase !== 'answer' || !versus()) return;
      clearTimers();
      r.buzz = p; r.buzzFrac = fracFrom(a.ms || 0);
      S.phase = 'buzz';
      return commit();
    case 'show':
      if (!r || r.kind !== 'letra') return;
      if (S.phase === 'buzz' || (S.phase === 'answer' && !versus() && S.cfg.input === 'cantar')) {
        clearTimers();
        if (S.phase === 'answer') r.buzzFrac = fracFrom(a.ms || 0);
        S.phase = 'judge';
        commit();
      }
      return;
    case 'judge': {
      if (!r || S.phase !== 'judge') return;
      if (S.online && versus() && p === r.buzz) return; // quem cantou não julga a si mesmo
      const ok = !!a.ok;
      const frac = r.late ? 0 : (r.buzzFrac || 0);
      if (versus()) r.gain[r.buzz] = ok ? Math.round(100 + 50 * frac) : -50;
      else r.gain[0] = ok ? Math.round((100 + 50 * frac) * mult(true)) : 0;
      return finishLetra(ok);
    }
    case 'next':
      if (S.phase === 'reveal' && (!a.rid || a.rid === r.id)) hostNextRound();
      return;
    case 'retry':
      if (S.phase === 'error' && H) { H.qi = Math.max(0, H.qi - 10); hostNextRound(); }
      return;
    case 'again':
      if (S.phase === 'end') startGame();
      return;
  }
}

function revealGuess() {
  const r = S.round;
  if (S.phase !== 'play') return;
  clearTimers();
  const rights = (versus() ? [0, 1] : [0]).map(k => !!r.answers[k] && r.answers[k].i === r.answer);
  if (versus()) {
    const order = [0, 1].filter(k => rights[k]).sort((x, y) => (r.answers[x].ms - r.answers[y].ms) || (r.answers[x].ord - r.answers[y].ord));
    [0, 1].forEach(k => {
      if (!r.answers[k]) r.gain[k] = 0;
      else if (rights[k]) r.gain[k] = Math.round(50 + 100 * fracFrom(r.answers[k].ms)) + (order[0] === k ? 30 : 0);
      else r.gain[k] = -25;
    });
  } else if (rights[0]) {
    r.gain[0] = Math.round((50 + 100 * fracFrom(r.answers[0].ms)) * mult(true));
  }
  applyResult(rights);
}

function finishLetra(ok) {
  const r = S.round;
  clearTimers();
  const rights = versus() ? [0, 1].map(k => r.buzz === k && ok) : [ok];
  applyResult(rights);
}

function applyResult(rights) {
  const r = S.round;
  if (coop()) {
    if (rights[0]) { S.streak++; S.bestStreak = Math.max(S.bestStreak, S.streak); }
    else { S.streak = 0; S.lives--; }
  } else if (!versus()) {
    S.streak = rights[0] ? S.streak + 1 : 0; S.bestStreak = Math.max(S.bestStreak, S.streak);
  }
  S.players.forEach((pl, i) => { pl.score = Math.max(0, pl.score + (r.gain[i] || 0)); });
  S.history.push({ song: r.song, rights, gain: r.gain.slice(0, S.players.length) });
  r.rights = rights;
  S.phase = 'reveal';
  commit();
}

function hostEnd() {
  clearTimers();
  if (!versus()) {
    const best = store.get('best', {});
    const key = `${S.cfg.players}-${S.cfg.mode}`;
    const prev = best[key] || 0, score = S.players[0].score;
    if (score > prev) { best[key] = score; store.set('best', best); }
    S.record = { prev, score };
  }
  S.phase = 'end';
  commit();
}

/* ===================== mídia em cada aparelho ===================== */

const Media = {
  audios: new Map(), // songId -> Audio já carregado
  st: {},            // estado local da rodada atual
  loop: 0,
  cacheAudio(id, a) {
    this.audios.set(id, a);
    if (this.audios.size > 6) this.audios.delete(this.audios.keys().next().value);
  },
  async audioFor(id) {
    if (this.audios.has(id)) return this.audios.get(id);
    const a = await loadAudio(await getPreview(id));
    this.cacheAudio(id, a);
    return a;
  },
  stopAll() { Sound.stop(); YTP.stop(); cancelAnimationFrame(this.loop); this.st = {}; },
  /* chamado a cada mudança de estado */
  sync() {
    if (!S || S.phase === 'lobby') { this.stopAll(); return; }
    if (S.phase === 'end' || S.phase === 'error') { cancelAnimationFrame(this.loop); return; }
    const r = S.round;
    if (!r || !r.kind) return;
    if (this.st.rid !== r.id) {
      Sound.stop(); YTP.pause(); cancelAnimationFrame(this.loop);
      this.st = { rid: r.id, prepared: false, started: false, revealed: false, ytOk: false, done: false };
      this.prepare(r);
    }
    const st = this.st;
    if (S.phase === 'play' && st.prepared && !st.started) this.start(r);
    if (r.kind === 'letra' && ['judge', 'reveal'].includes(S.phase) && !st.revealed) {
      st.revealed = true;
      this.playAnswer(r);
    }
    if (S.phase !== 'play') YTPauseIfBefore(r);
    if (S.nextSong && !this.audios.has(S.nextSong)) this.audioFor(S.nextSong).catch(() => {});
  },
  async prepare(r) {
    const st = this.st, me = ME == null ? 0 : ME;
    try {
      if (r.kind === 'guess') st.audio = await this.audioFor(r.song.id);
      else if (r.sync === 'yt') { await YTP.prepare(r.song.yt, r.start); st.ytOk = true; }
    } catch (e) { console.warn('mídia', e.message); }
    if (this.st !== st) return;
    st.prepared = true;
    act({ type: 'ready', rid: r.id, p: me });
    if (S && S.phase === 'play' && S.round.id === r.id) this.start(r);
  },
  start(r) {
    const st = this.st;
    if (st.started) return;
    st.started = true;
    const wait = Math.max(0, r.startAt - Clock.now());
    setTimeout(async () => {
      if (this.st !== st) return;
      if (r.kind === 'guess') {
        if (!st.audio) return;
        const late = Math.max(0, (Clock.now() - r.startAt) / 1000);
        const ok = await Sound.play(st.audio, late < 20 ? late : 0);
        if (!ok && this.st === st) showBlocked();
      } else {
        if (st.ytOk) {
          const late = Math.max(0, (Clock.now() - r.startAt) / 1000);
          YTP.play(r.start + late);
          setTimeout(() => { if (this.st === st && !YTP.playing() && S && S.phase === 'play') showBlocked(); }, 2500);
        }
        this.lyricsLoop(r);
      }
    }, wait);
  },
  /* tempo atual da música no modo letra */
  songTime(r) {
    if (r.sync === 'yt' && this.st.ytOk && YTP.playing()) return YTP.time();
    return r.start + (Clock.now() - r.startAt) / 1000;
  },
  lyricsLoop(r) {
    const st = this.st;
    const tick = () => {
      if (this.st !== st || !S || S.round.id !== r.id) return;
      const t = this.songTime(r);
      const box = $('#lyrics');
      if (box && S.phase === 'play') {
        const n = r.show.filter(x => t >= x - 0.15).length;
        const have = box.querySelectorAll('.ln').length;
        if (n > have) {
          box.querySelectorAll('.ln').forEach(x => x.classList.remove('cur'));
          for (let j = have; j < n; j++) box.insertAdjacentHTML('beforeend', `<div class="ln cur">${esc(r.ctx[j].text)}</div>`);
        }
      }
      if (t >= r.stopAt - 0.2 && !st.done) {
        st.done = true;
        if (st.ytOk) YTP.pause();
        if (isHost()) hostAct({ type: 'lyricsDone', rid: r.id });
      }
      if (S.phase === 'play') this.loop = requestAnimationFrame(tick);
    };
    this.loop = requestAnimationFrame(tick);
  },
  playAnswer(r) {
    const st = this.st;
    if (r.sync === 'yt' && st.ytOk) { YTP.play(Math.max(0, r.tt - 0.4)); return; }
    this.audioFor(r.song.id).then(a => { if (this.st === st) Sound.play(a); }).catch(() => {});
  },
};
function YTPauseIfBefore(r) {
  // garante que o vídeo não siga tocando a resposta antes da hora
  if (r.kind === 'letra' && ['answer', 'buzz'].includes(S.phase) && YTP.playing()) YTP.pause();
}
function showBlocked() {
  const sub = $('#sub');
  if (sub && !sub.querySelector('[data-act="unblock"]')) sub.innerHTML = `<button class="linkish" data-act="unblock">O navegador bloqueou o som. Toca aqui pra ouvir.</button>`;
}

/* ===================== telas ===================== */

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}

let viewKey = '';
function render() {
  if (!S) return;
  if (S.phase === 'lobby') { viewKey = ''; renderLobby(); return; }
  if (S.phase === 'end') { viewKey = ''; renderEnd(); return; }
  if (!$('#game').classList.contains('active')) show('game');
  const r = S.round || {};
  const key = [S.phase === 'loading' ? 'loading' : S.phase, r.id, r.kind].join('|');
  if (key !== viewKey) { viewKey = key; renderGameView(); }
  else patchGameView();
  updateRoomBar();
}

/* ---------- home ---------- */

function renderHome() {
  const total = SONGS.length;
  $('#heroSub').textContent = `${total.toLocaleString('pt-BR')} músicas brasileiras. Ouve o trecho, acerta a música ou o artista, ou completa a letra. Sozinho, em dupla ou cada um no seu canto, numa sala online.`;
  const grid = $('#catGrid');
  grid.innerHTML = '';
  for (const id of HOME_ORDER) {
    const c = CAT[id];
    const songs = SONGS.filter(s => s.mask & c.bit);
    const fame = new Map();
    for (const s of songs.filter(s => s.cm & c.bit)) fame.set(s.a, (fame.get(s.a) || 0) + 1);
    const top = [...fame.entries()].sort((a, b) => b[1] - a[1]).slice(0, id === 'rock' ? 5 : 3).map(x => x[0]);
    const el = document.createElement('button');
    el.className = 'tile' + (id === 'rock' ? ' big' : '');
    el.style.setProperty('--c', c.color);
    el.style.setProperty('--fg', textOn(c.color));
    el.innerHTML = id === 'rock'
      ? `<div><span class="t-tag">A favorita da casa</span><div class="t-name">${esc(c.name)}</div></div>
         <div class="t-sub">${esc(top.join(', '))} e mais ${songs.length} músicas</div><div class="t-disc"></div>`
      : `<span class="t-count">${songs.length}</span><div class="t-name">${esc(c.name)}</div><div class="t-sub">${esc(top.join(', '))}</div>`;
    el.addEventListener('click', () => openSetup([id]));
    grid.appendChild(el);
  }
  const all = document.createElement('button');
  all.className = 'tile all';
  all.innerHTML = `<span class="t-count">${total}</span><div class="t-name">Tudo junto</div><div class="t-sub">Todas as categorias misturadas</div>`;
  all.addEventListener('click', () => openSetup(CATS.map(c => c.id)));
  grid.appendChild(all);
}

/* ---------- setup ---------- */

function openSetup(cats) {
  if (Room.role === 'guest') return;
  cfg.cats = cats.slice();
  if (Room.role === 'host' && cfg.players === 'solo') cfg.players = 'versus';
  fixCfg();
  renderSetup();
  $('#setup').hidden = false;
  setTimeout(() => $('#startBtn').focus(), 50);
}
function closeSetup() { $('#setup').hidden = true; }

function renderSetup() {
  const sel = cfg.cats;
  $('#setupTitle').textContent = sel.length === CATS.length ? 'Tudo junto'
    : sel.length === 1 ? CAT[sel[0]].name : sel.map(c => CAT[c].name).join(' + ');
  const chips = $('#catChips');
  chips.innerHTML = '';
  for (const id of HOME_ORDER) {
    const c = CAT[id], b = document.createElement('button');
    b.className = 'chip' + (sel.includes(id) ? ' on' : '');
    b.textContent = c.name;
    b.style.setProperty('--c', c.color); b.style.setProperty('--fg', textOn(c.color));
    b.addEventListener('click', () => {
      if (cfg.cats.includes(id)) { if (cfg.cats.length > 1) cfg.cats = cfg.cats.filter(x => x !== id); }
      else cfg.cats = [...cfg.cats, id];
      renderSetup();
    });
    chips.appendChild(b);
  }
  document.querySelectorAll('#setup .seg').forEach(seg => {
    const key = seg.dataset.key;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(cfg[key]) === b.dataset.v));
  });
  document.querySelector('.seg[data-key="players"] button[data-v="solo"]').hidden = Room.role === 'host';
  const ch = inputChoices(cfg);
  $('#inputField').hidden = !ch.length;
  document.querySelectorAll('#inputField button').forEach(b => { b.hidden = !ch.includes(b.dataset.v); });
  $('#whereField').hidden = cfg.players === 'solo' || Room.role === 'host';
  const online = cfg.where === 'online';
  $('#names').hidden = cfg.players === 'solo' && !online;
  $('#name1').hidden = online;
  $('#name0').placeholder = online ? 'Seu nome' : 'Jogador 1';
  $('#name0').value = cfg.names[0] || ''; $('#name1').value = cfg.names[1] || '';
  const hints = {
    solo: '',
    coop: 'Vocês jogam juntos: uma pontuação só, 3 vidas e bônus por sequência de acertos.',
    versus: cfg.mode === 'letra'
      ? 'Quem souber aperta primeiro e canta. O outro julga se acertou.'
      : online ? 'Cada um responde no seu aparelho. Mais rápido ganha mais pontos.'
        : 'Cada um responde no seu lado do teclado (ou toca no seu painel). Mais rápido ganha mais pontos.',
  };
  let hint = hints[cfg.players];
  if (online && Room.role !== 'host') hint += ' Você vai receber um link pra mandar pra outra pessoa.';
  $('#playersHint').textContent = hint;
  $('#playersHint').hidden = !hint;
  const n = buildPool(cfg).length;
  $('#poolCount').textContent = n < 12 ? 'Poucas músicas aqui, escolhe mais categorias' : `${n} músicas no sorteio`;
  $('#startBtn').disabled = n < 12;
  $('#startBtn').textContent = online && Room.role !== 'host' ? 'Criar sala' : 'Começar';
}

function bindSetup() {
  document.querySelectorAll('#setup .seg').forEach(seg => {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      cfg[seg.dataset.key] = b.dataset.v;
      fixCfg(); renderSetup();
    });
  });
  ['#name0', '#name1'].forEach((s, i) => $(s).addEventListener('input', e => { cfg.names[i] = e.target.value; }));
  $('#setupClose').addEventListener('click', closeSetup);
  $('#setup').addEventListener('click', e => { if (e.target.id === 'setup') closeSetup(); });
  $('#startBtn').addEventListener('click', async () => {
    store.set('cfg', cfg);
    closeSetup();
    if (Room.role === 'host') {
      if (!Room.guestOnline()) { lobbyState(); commit(); return; }
      startGame(); return;
    }
    if (cfg.where === 'online' && cfg.players !== 'solo') return createRoom();
    startGame();
  });
}

/* ---------- sala ---------- */

async function createRoom() {
  ME = 0;
  show('lobby');
  $('#lobby').innerHTML = `<div class="loading"><div class="disc spin"><div class="label"></div></div>Criando a sala…</div>`;
  try { await Room.host(); }
  catch {
    Room.leave(); ME = null;
    $('#lobby').innerHTML = `<div class="err"><h2>Não consegui criar a sala.</h2><p>Confere a internet e tenta de novo.</p>
      <div class="actions"><button class="btn primary" data-act="home">Voltar</button></div></div>`;
    return;
  }
  lobbyState();
  commit();
}

function renderLobby() {
  show('lobby');
  const host = Room.role === 'host';
  const c = S.cfg;
  const guest = S.names[1];
  const present = host ? Room.guestOnline() && guest : true;
  const summary = `${c.cats.length === CATS.length ? 'Tudo junto' : c.cats.map(x => CAT[x].name).join(' + ')} · ${({ titulo: 'Música', artista: 'Artista', misto: 'Misturado', letra: 'Completar letra' })[c.mode]} · ${c.players === 'coop' ? 'Cooperativo' : 'Competitivo'} · ${c.rounds} rodadas`;
  if (host) {
    $('#lobby').innerHTML = `<div class="lobby">
      <div class="kicker">Sala online</div>
      <h2>${present ? `${esc(guest)} entrou.` : 'Manda o link pra quem vai jogar.'}</h2>
      <p class="lobby-sum">${esc(summary)}</p>
      <div class="linkbox"><input id="roomLink" readonly value="${esc(Room.link())}"><button class="btn" data-act="copy">Copiar</button>${navigator.share ? '<button class="btn" data-act="share">Enviar</button>' : ''}</div>
      <div class="presence ${present ? 'on' : ''}"><i></i>${present ? `${esc(guest)} está na sala` : 'Esperando alguém entrar…'}</div>
      <div class="actions">
        <button class="btn primary" data-act="lobbyStart" ${present ? '' : 'disabled'}>Começar</button>
        <button class="btn" data-act="lobbyChange">Mudar jogo</button>
        <button class="btn" data-act="leaveRoom">Fechar sala</button>
      </div>
      <p class="hint">Dica: fiquem numa ligação pra ouvir um ao outro cantando.</p></div>`;
  } else {
    $('#lobby').innerHTML = `<div class="lobby">
      <div class="kicker">Sala de ${esc(S.names[0])}</div>
      <h2>Você tá dentro.</h2>
      <p class="lobby-sum">${esc(summary)}</p>
      <div class="presence on"><i></i>Esperando ${esc(S.names[0])} começar…</div>
      <div class="actions"><button class="btn" data-act="leaveRoom">Sair da sala</button></div></div>`;
  }
  updateRoomBar();
}

function renderJoin(id, b) {
  show('lobby');
  $('#lobby').innerHTML = `<div class="lobby">
    <div class="kicker">Convite</div>
    <h2>Bora jogar toca aí?</h2>
    <p class="lobby-sum">Alguém te chamou pra uma partida de música brasileira. Põe seu nome e entra.</p>
    <form class="answer-form" data-act="join"><input id="joinName" maxlength="14" placeholder="Seu nome" autocomplete="off" value="${esc(cfg.names[0] || '')}"><button class="btn primary">Entrar</button></form>
    <p class="hint" id="joinMsg"></p></div>`;
  $('#joinName').focus();
  $('#lobby').dataset.room = id; $('#lobby').dataset.b = b;
}

async function joinRoom(name) {
  const id = $('#lobby').dataset.room, b = +$('#lobby').dataset.b || 0;
  cfg.names[0] = name.trim().slice(0, 14); store.set('cfg', cfg);
  $('#joinMsg').textContent = 'Conectando…';
  ME = 1;
  try { await Room.join(id, b); }
  catch { ME = null; Room.leave(); $('#joinMsg').textContent = 'Não consegui conectar. Confere a internet e tenta de novo.'; return; }
  // sem estado da sala em alguns segundos = sala não existe mais
  setTimeout(() => {
    if (Room.role === 'guest' && !S) $('#joinMsg').textContent = 'Não achei essa sala. Pede um link novo pra quem te chamou.';
  }, 7000);
}

function leaveRoom() {
  Room.leave();
  ME = null; S = null; H = null;
  Media.stopAll();
  history.replaceState(null, '', location.pathname);
  show('home');
}

function updateRoomBar() {
  const bar = $('#roombar');
  if (!Room.role) { bar.hidden = true; return; }
  bar.hidden = false;
  let txt, ok;
  if (Room.role === 'host') {
    ok = Room.connected && Room.guestOnline();
    const g = S && S.names && S.names[1];
    txt = !Room.connected ? 'Reconectando à sala…' : ok ? `Online com ${g}` : g ? `${g} saiu da sala…` : 'Sala aberta, esperando alguém';
  } else {
    ok = Room.connected && Room.hostOnline();
    const h = S && S.names ? S.names[0] : 'o host';
    txt = !Room.connected ? 'Reconectando…' : ok ? `Online com ${h}` : `Sem sinal de ${h}…`;
  }
  bar.className = 'roombar' + (ok ? ' on' : '');
  bar.querySelector('span').textContent = txt;
}

/* ---------- jogo ---------- */

function barHTML() {
  const g = S;
  let right;
  if (versus()) {
    right = g.players.map((p, i) => `<div class="score p${i + 1}${ME === i ? ' me' : ''}"><span class="s-name">${esc(p.name)}</span><span class="s-pts">${p.score}</span></div>`).join('');
  } else {
    right = `<div class="score"><span class="s-pts">${g.players[0].score}</span></div>`;
    if (coop()) {
      right = `<span class="streak">${g.streak >= 3 ? 'x' + mult(true) : ''}</span>
        <div class="lives" title="Vidas">${[0, 1, 2].map(i => `<i class="${i >= g.lives ? 'lost' : ''}"></i>`).join('')}</div>` + right;
    }
  }
  return `<div class="g-bar">
      <button class="g-quit" data-act="quit">✕ sair</button>
      <span class="g-round">${g.n} / ${g.total}</span>
      <div class="scores">${right}</div>
    </div>
    <div class="timer"><div></div></div>`;
}

function catColor(song) {
  const c = S.cfg.cats.map(id => CAT[id]).find(c => song.mask & c.bit) || CATS.find(c => song.mask & c.bit);
  return c ? c.color : '#E4572E';
}
function discHTML(song, spin) {
  return `<div class="disc ${spin ? 'spin' : ''}" style="--cat:${catColor(song)}">
      <div class="label"></div>
      <div class="cover" style="background-image:url('${coverUrl(song, 500)}')"></div>
    </div>`;
}

function setYtDock(on) {
  $('#ytdock').classList.toggle('show', !!on);
}

function renderGameView() {
  const el = $('#gview');
  const r = S.round || {};
  el.style.setProperty('--cat', r.song ? catColor(r.song) : CAT[S.cfg.cats[0]].color);
  setYtDock(r.kind === 'letra' && r.sync === 'yt' && S.phase !== 'loading');
  if (S.phase === 'loading') {
    const wait = S.online && r.kind && r.ready && !r.ready[ME === 0 ? 1 : 0];
    el.innerHTML = barHTML() + `<div class="loading"><div class="disc spin"><div class="label"></div></div>${wait ? `Esperando ${esc(S.names[ME === 0 ? 1 : 0])} carregar…` : 'Escolhendo a próxima…'}</div>`;
    return;
  }
  if (S.phase === 'error') {
    el.innerHTML = `<div class="err"><h2>Não deu pra carregar as músicas.</h2><p>Confere a internet e tenta de novo.</p>
      <div class="actions">${isHost() ? '<button class="btn primary" data-act="retry">Tentar de novo</button>' : ''}<button class="btn" data-act="quit">Sair</button></div></div>`;
    return;
  }
  if (r.kind === 'guess') renderGuess(el, r); else renderLetra(el, r);
  startTimerLoop();
}

function patchGameView() {
  const bar = $('.g-bar');
  if (bar) { const tmp = document.createElement('div'); tmp.innerHTML = barHTML(); bar.replaceWith(tmp.firstElementChild); }
  const r = S.round;
  if (!r) return;
  if (S.phase === 'loading') {
    const wait = S.online && r.kind && r.ready && !r.ready[ME === 0 ? 1 : 0];
    const l = $('.loading');
    if (l && wait) l.lastChild.textContent = `Esperando ${S.names[ME === 0 ? 1 : 0]} carregar…`;
  }
  if (r.kind === 'guess' && S.phase === 'play') patchGuessAnswers(r);
}

/* timer visual: lê S.round, não manda em nada (quem decide o fim é o host) */
let timerRaf = 0;
function startTimerLoop() {
  cancelAnimationFrame(timerRaf);
  const tick = () => {
    const bar = document.querySelector('.timer > div');
    if (!bar || !S || !S.round) return;
    const r = S.round, dur = roundSecs() * 1000;
    let left = 1;
    if (S.phase === 'play' && r.kind === 'guess') left = (r.endAt - Clock.now()) / dur;
    else if (S.phase === 'answer') left = (r.endAt - Clock.now()) / dur;
    else if (S.phase === 'buzz' || S.phase === 'judge') left = r.buzzFrac != null ? r.buzzFrac : 0;
    else if (S.phase === 'reveal') left = 0;
    left = clamp(left, 0, 1);
    bar.style.transform = `scaleX(${left})`;
    bar.parentElement.classList.toggle('low', left * dur < 4000 && ['play', 'answer'].includes(S.phase) && !(S.phase === 'play' && r.kind === 'letra'));
    timerRaf = requestAnimationFrame(tick);
  };
  timerRaf = requestAnimationFrame(tick);
}
const msNow = () => S && S.round ? Math.max(0, Clock.now() - (S.phase === 'answer' ? S.round.answerAt : S.round.startAt)) : 0;

function renderGuess(el, r) {
  const qText = r.q === 'artista' ? 'Quem canta essa?' : 'Qual é a música?';
  const done = S.phase === 'reveal';
  const localPads = versus() && isLocal();
  let body = '';
  if (localPads) {
    body = `<div class="opts">${r.options.map((o, i) => `<div class="opt" data-i="${i}"><span class="k">${LETTERS[i]}</span>${esc(o)}<span class="who"></span></div>`).join('')}</div>`;
    if (!done) body += `<div class="pads">${[0, 1].map(p => `<div class="pad p${p + 1}" data-p="${p}">
        <div class="pad-name">${esc(S.players[p].name)}<small class="pad-status"></small></div>
        <div class="pad-keys">${LETTERS.map((L, i) => `<button data-act="pick" data-p="${p}" data-i="${i}">${L}<kbd>${KEYS['p' + (p + 1)][i].toUpperCase()}</kbd></button>`).join('')}</div>
      </div>`).join('')}</div>`;
  } else if (S.cfg.input === 'digitar' && !versus()) {
    if (!done) body = `<form class="answer-form" data-act="typed"><input id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${r.q === 'artista' ? 'Nome do artista' : 'Nome da música'}"><button class="btn primary">Chutar</button></form>
      <div class="answer-extra"><button class="linkish" data-act="giveup">Não sei, mostra</button></div>`;
  } else {
    body = `<div class="opts">${r.options.map((o, i) => `<button class="opt" data-act="pick" data-i="${i}"><span class="k">${i + 1}</span>${esc(o)}<span class="who"></span></button>`).join('')}</div>`;
  }
  const head = done
    ? `<div class="reveal-title">${esc(r.song.t)}</div><div class="reveal-artist">${esc(r.song.a)}</div><div class="delta">${deltaHTML()}</div>`
    : `<div class="question">${qText}</div><div class="sub" id="sub"></div>`;
  el.innerHTML = barHTML() + `<div class="stage ${versus() ? 'compact' : ''}">
      <div class="disc spin ${done ? 'revealed' : ''}" style="--cat:${catColor(r.song)}"><div class="label"></div><div class="cover" style="background-image:url('${coverUrl(r.song, 500)}')"></div></div>
      ${head}
      ${body}
      ${done ? nextHTML() : ''}
    </div>`;
  if (done) markOptions(r); else patchGuessAnswers(r);
  const inp = $('#ans'); if (inp) inp.focus();
}

function patchGuessAnswers(r) {
  if (isLocal() && versus()) {
    [0, 1].forEach(p => {
      const pad = document.querySelector(`.pad[data-p="${p}"]`);
      if (pad && r.answers[p]) { pad.classList.add('done'); pad.querySelector('.pad-status').textContent = 'respondeu'; }
    });
    return;
  }
  if (!S.online) return;
  const mine = versus() ? r.answers[ME] : r.answers[0];
  document.querySelectorAll('.opt').forEach(o => {
    o.classList.toggle('mine', !!mine && mine.i === +o.dataset.i);
    if (mine) o.disabled = true;
  });
  const sub = $('#sub');
  if (sub && versus()) {
    const other = 1 - ME;
    sub.textContent = mine && !r.answers[other] ? `Esperando ${S.players[other].name}…`
      : !mine && r.answers[other] ? `${S.players[other].name} já respondeu!` : '';
  }
}

function markOptions(r) {
  document.querySelectorAll('.opt').forEach(o => {
    const i = +o.dataset.i;
    o.disabled = true;
    const chosen = r.answers.some(a => a && a.i === i);
    if (i === r.answer) o.classList.add('right');
    else if (chosen) o.classList.add('wrong');
    else o.classList.add('dim');
    const who = o.querySelector('.who');
    if (who && S.names.length > 1) {
      who.innerHTML = r.answers.map((a, k) => a && a.i === i ? `<b class="w${(versus() ? k : a.by) + 1}">${esc(badge(versus() ? k : a.by))}</b>` : '').join('');
    }
  });
}
function badge(p) {
  const ini = S.names.map(x => (x || '').trim().slice(0, 1).toUpperCase());
  return ini[0] && ini[0] !== ini[1] ? ini[p] : String(p + 1);
}

function deltaHTML() {
  const r = S.round;
  const fmt = (v, name) => {
    const cls = v > 0 ? 'plus' : v < 0 ? 'minus' : 'zero';
    const txt = v > 0 ? '+' + v : v < 0 ? String(v) : (versus() ? '0' : 'Não foi dessa vez');
    return `<span class="${cls}">${name ? esc(name) + ' ' : ''}${txt}</span>`;
  };
  if (versus()) return S.players.map((p, i) => fmt(r.gain[i], p.name)).join('');
  if (coop() && !r.rights[0]) return `<span class="minus">${S.lives > 0 ? 'Perderam uma vida' : 'Acabaram as vidas'}</span>`;
  return fmt(r.gain[0]);
}

function nextHTML() {
  const last = S.n >= S.total || (coop() && S.lives <= 0);
  return `<div class="actions"><button class="btn primary" data-act="next">${last ? 'Ver resultado' : 'Próxima'} <kbd>Enter</kbd></button></div>`;
}

/* ---------- modo letra ---------- */

function renderLetra(el, r) {
  const ph = S.phase;
  const answerShown = ph === 'judge' || ph === 'reveal';
  const lines = ph === 'play'
    ? '' // a animação (Media.lyricsLoop) vai preenchendo
    : r.ctx.map((c, j) => `<div class="ln${j === r.ctx.length - 1 ? ' cur' : ''}" style="animation:none">${esc(c.text)}</div>`).join('');
  let target = '';
  if (ph !== 'play') {
    const hw = r.hidden.split(/\s+/);
    const fill = answerShown
      ? hw.map((w, i) => `<span class="fill ${r.typed ? (r.typed.hits[i] ? 'hit' : 'miss') : ''}">${esc(w)}</span>`).join(' ')
      : hw.map(w => `<span class="blank" style="width:${clamp(w.length, 2, 12) * 0.55}em"></span>`).join('');
    target = `<div class="ln target" id="target">${esc(r.shown)} ${fill}</div>`;
  }
  const yt = r.sync === 'yt';
  el.innerHTML = barHTML() + `<div class="stage">
      ${yt ? '<div class="yt-slot"></div>' : ''}
      <div class="song-chip">${yt ? '' : `<img src="${coverUrl(r.song)}" alt="">`}<b>${esc(r.song.t)}</b><span>${esc(r.song.a)}</span></div>
      <div class="lyrics" id="lyrics">${lines}${target}</div>
      <div class="sub" id="sub">${ph === 'play' ? (yt ? '' : '<span class="muted-hint">sem áudio nessa, só a letra</span>') : ''}</div>
      ${ph === 'reveal' ? `<div class="delta">${deltaHTML()}</div>` : ''}
      <div id="controls">${letraControls(r)}</div>
    </div>`;
  if (ph === 'play' && Media.st.rid === r.id && Media.st.started) {
    // re-render no meio da animação: recoloca as linhas que já passaram
    const t = Media.songTime(r);
    const n = r.show.filter(x => t >= x - 0.15).length;
    $('#lyrics').innerHTML = r.ctx.slice(0, n).map((c, j) => `<div class="ln${j === n - 1 ? ' cur' : ''}" style="animation:none">${esc(c.text)}</div>`).join('');
  }
  const inp = $('#ans'); if (inp) inp.focus();
}

function letraControls(r) {
  const ph = S.phase;
  const local = isLocal();
  if (ph === 'answer') {
    if (versus()) {
      if (local) return `<div class="pads">${[0, 1].map(p => `<div class="pad p${p + 1}" data-p="${p}">
          <button class="buzz" data-act="buzz" data-p="${p}">${esc(S.players[p].name)}: eu sei!<kbd>${KEYS['p' + (p + 1)].join(' ').toUpperCase()}</kbd></button></div>`).join('')}</div>`;
      return `<div class="pads one"><div class="pad p${ME + 1}"><button class="buzz" data-act="buzz">Eu sei! <kbd>Espaço</kbd></button></div></div>`;
    }
    if (S.cfg.input === 'digitar') return `<form class="answer-form" data-act="lyric"><input id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Completa a frase…"><button class="btn primary">Responder</button></form>
      <div class="answer-extra"><button class="linkish" data-act="giveup">Não sei, mostra</button></div>`;
    return `<div class="actions"><button class="btn primary" data-act="show">Mostrar resposta <kbd>Enter</kbd></button></div>`;
  }
  if (ph === 'buzz') {
    const who = S.players[r.buzz].name;
    const me = !local && ME === r.buzz;
    return `<div class="turn p${r.buzz + 1}">${me ? 'Sua vez, canta!' : `${esc(who)}, canta!`}</div>
      <div class="actions"><button class="btn primary" data-act="show">Mostrar resposta <kbd>Enter</kbd></button></div>`;
  }
  if (ph === 'judge') {
    let q, can = true;
    if (versus()) {
      const who = S.players[r.buzz].name;
      if (!local && ME === r.buzz) { can = false; q = `${esc(S.players[1 - r.buzz].name)} tá julgando…`; }
      else q = `${esc(who)} acertou?`;
      q = `<div class="turn p${r.buzz + 1}">${q}</div>`;
    } else q = `<div class="turn">${coop() ? 'Acertaram?' : 'Acertou?'}</div>`;
    return q + (can ? `<div class="actions"><button class="btn ok" data-act="judge" data-v="1">Acertou <kbd>S</kbd></button><button class="btn bad" data-act="judge" data-v="0">Errou <kbd>N</kbd></button></div>` : '');
  }
  if (ph === 'reveal') return nextHTML();
  return '';
}

/* ---------- fim ---------- */

function renderEnd() {
  show('end');
  const g = S;
  const hits = g.history.filter(h => h.rights.some(Boolean)).length;
  let kicker, title, line;
  if (versus()) {
    const [a, b] = g.players;
    kicker = 'Fim de jogo';
    title = a.score === b.score ? 'Empate!' : `${esc((a.score > b.score ? a : b).name)} venceu.`;
    line = `${g.history.length} rodadas`;
  } else {
    const rec = g.record || { prev: 0, score: g.players[0].score };
    kicker = coop() && g.lives <= 0 ? 'Acabaram as vidas' : 'Fim de jogo';
    title = `${g.players[0].score} pontos`;
    line = `${hits} de ${g.history.length} certas` + (g.bestStreak >= 3 ? ` · melhor sequência: ${g.bestStreak}` : '')
      + (isLocal() ? (rec.score > rec.prev && rec.prev > 0 ? ' · novo recorde!' : rec.prev ? ` · recorde: ${Math.max(rec.prev, rec.score)}` : '') : '');
  }
  const scores = versus()
    ? `<div class="end-scores">${g.players.map((p, i) => `<div class="score p${i + 1}"><span class="s-name">${esc(p.name)}</span><span class="s-pts">${p.score}</span></div>`).join('')}</div>` : '';
  const recap = g.history.map(h => {
    let res;
    if (versus()) res = h.gain.map((v, i) => `<span class="w${i + 1}">${v > 0 ? '+' + v : v}</span>`).join(' · ');
    else res = h.rights[0] ? `<span>+${h.gain[0]}</span>` : '<span>✕</span>';
    const ok = h.rights.some(Boolean);
    return `<a href="https://www.deezer.com/track/${h.song.id}" target="_blank" rel="noopener">
      <img src="${coverUrl(h.song)}" alt="" loading="lazy">
      <div class="r-txt"><div class="r-t">${esc(h.song.t)}</div><div class="r-a">${esc(h.song.a)}</div></div>
      <div class="r-res ${versus() ? '' : ok ? 'ok' : 'no'}">${res}</div></a>`;
  }).join('');
  const host = isHost();
  const actions = host
    ? `<button class="btn primary" data-act="again">Jogar de novo <kbd>Enter</kbd></button><button class="btn" data-act="home">${S.online ? 'Mudar jogo' : 'Início'}</button>`
    : `<span class="hint">Esperando ${esc(S.names[0])} escolher o próximo jogo…</span>`;
  $('#end').innerHTML = `<div class="end-hero"><div class="kicker">${kicker}</div><h2>${title}</h2><p>${line}</p>${scores}
      <div class="actions">${actions}</div></div>
    <div class="recap">${recap}</div>`;
  updateRoomBar();
}

/* ===================== eventos ===================== */

function quit() {
  if (Room.role === 'guest') { if (confirm('Sair da sala?')) leaveRoom(); return; }
  if (S && S.phase !== 'lobby' && S.n > 1 && S.phase !== 'end' && !confirm('Sair da partida?')) return;
  clearTimers(); H = null;
  Media.stopAll();
  if (Room.role === 'host') { lobbyState(); commit(); }
  else { S = null; show('home'); }
}

function goHome() {
  // host online: volta pra home mas mantém a sala (convidado fica esperando)
  clearTimers(); H = null; Media.stopAll();
  if (Room.role === 'host') { lobbyState(); S.phase = 'lobby'; publishState(); }
  else S = null;
  show('home');
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'FORM') return;
  const a = b.dataset.act;
  const rid = S && S.round ? S.round.id : null;
  switch (a) {
    case 'quit': quit(); break;
    case 'pick': {
      const p = b.dataset.p != null ? +b.dataset.p : (ME == null ? 0 : ME);
      act({ type: 'pick', p, i: +b.dataset.i, ms: msNow() });
      if (S.online) { b.classList.add('mine'); }
      break;
    }
    case 'next': act({ type: 'next', rid }); break;
    case 'giveup': act({ type: 'giveup' }); break;
    case 'show': act({ type: 'show', ms: msNow() }); break;
    case 'buzz': act({ type: 'buzz', p: b.dataset.p != null ? +b.dataset.p : ME, ms: msNow() }); break;
    case 'judge': act({ type: 'judge', ok: b.dataset.v === '1' }); break;
    case 'unblock': {
      const r = S && S.round;
      if (r && r.kind === 'guess' && Media.st.audio) Sound.play(Media.st.audio, Math.max(0, (Clock.now() - r.startAt) / 1000));
      else if (r && r.kind === 'letra' && Media.st.ytOk) YTP.play(Media.songTime(r));
      b.remove(); break;
    }
    case 'retry': act({ type: 'retry' }); break;
    case 'again': act({ type: 'again' }); break;
    case 'home': if (Room.role === 'host' || !Room.role) goHome(); else leaveRoom(); break;
    case 'copy': {
      const inp = $('#roomLink');
      (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(() => toast('Link copiado'), () => { inp.select(); document.execCommand('copy'); toast('Link copiado'); });
      break;
    }
    case 'share': navigator.share({ title: 'toca aí', text: 'Bora jogar? Entra na minha sala:', url: Room.link() }).catch(() => {}); break;
    case 'lobbyStart': if (Room.guestOnline()) { cfg = Object.assign(cfg, S.cfg); startGame(); } break;
    case 'lobbyChange': show('home'); break;
    case 'leaveRoom': if (confirm(Room.role === 'host' ? 'Fechar a sala?' : 'Sair da sala?')) leaveRoom(); break;
    case 'leaveRoomBar': if (confirm(Room.role === 'host' ? 'Fechar a sala?' : 'Sair da sala?')) leaveRoom(); break;
  }
});

document.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, inp = f.querySelector('input');
  const v = inp.value;
  if (f.dataset.act === 'join') { if (v.trim()) joinRoom(v); else inp.focus(); return; }
  if (!S || !S.round || !v.trim()) return;
  const r = S.round;
  if (f.dataset.act === 'typed') {
    // confere aqui mesmo pra dar o "tremido" na hora; o host confere de novo
    if (matches(v, r.q === 'artista' ? r.song.a : r.song.t)) act({ type: 'typed', text: v, ms: msNow(), p: ME == null ? 0 : ME });
    else { inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake'); inp.select(); }
  } else if (f.dataset.act === 'lyric') {
    act({ type: 'lyric', text: v, ms: msNow(), p: ME == null ? 0 : ME });
    inp.disabled = true;
  }
});

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$('#setup').hidden) {
    if (e.key === 'Escape') closeSetup();
    else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && !$('#startBtn').disabled) $('#startBtn').click();
    return;
  }
  const typing = e.target.tagName === 'INPUT';
  const k = e.key.toLowerCase();
  if ($('#end').classList.contains('active')) {
    if (e.key === 'Enter' && isHost() && S) { e.preventDefault(); act({ type: 'again' }); }
    return;
  }
  if (!S || !S.round || !$('#game').classList.contains('active')) return;
  const r = S.round;
  if (e.key === 'Escape') { quit(); return; }
  if (typing) return;
  const enter = e.key === 'Enter' || e.key === ' ';
  if (enter && document.querySelector('[data-act="next"]')) { e.preventDefault(); act({ type: 'next', rid: r.id }); return; }
  if (r.kind === 'guess' && S.phase === 'play') {
    if (versus() && isLocal()) {
      const p = KEYS.p1.includes(k) ? 0 : KEYS.p2.includes(k) ? 1 : -1;
      if (p >= 0) { e.preventDefault(); act({ type: 'pick', p, i: KEYS['p' + (p + 1)].indexOf(k), ms: msNow() }); }
    } else if (/^[1-4]$/.test(k) && document.querySelector('.opt[data-act="pick"]:not(:disabled)')) {
      const b = document.querySelector(`.opt[data-i="${+k - 1}"]`);
      if (b) b.click();
    }
  } else if (r.kind === 'letra') {
    if (S.phase === 'answer' && versus()) {
      if (isLocal()) { if (KEYS.p1.includes(k)) act({ type: 'buzz', p: 0, ms: msNow() }); else if (KEYS.p2.includes(k)) act({ type: 'buzz', p: 1, ms: msNow() }); }
      else if (enter) { e.preventDefault(); act({ type: 'buzz', p: ME, ms: msNow() }); }
    } else if (enter && document.querySelector('[data-act="show"]')) {
      e.preventDefault(); act({ type: 'show', ms: msNow() });
    } else if (S.phase === 'judge' && document.querySelector('[data-act="judge"]')) {
      if (k === 's') act({ type: 'judge', ok: true }); else if (k === 'n') act({ type: 'judge', ok: false });
    }
  }
});

/* ===================== início ===================== */

$('#vol').value = Sound.vol;
$('#vol').addEventListener('input', e => { Sound.vol = +e.target.value; Sound.muted = Sound.vol === 0; store.set('vol', Sound.vol); store.set('muted', Sound.muted); Sound.apply(); });
$('#muteBtn').addEventListener('click', () => { Sound.muted = !Sound.muted; if (!Sound.muted && Sound.vol === 0) { Sound.vol = 0.8; $('#vol').value = 0.8; } store.set('muted', Sound.muted); Sound.apply(); });
$('#logo').addEventListener('click', () => {
  if (Room.role === 'guest') return;
  if (S && S.phase !== 'lobby' && S.phase !== 'end' && S.n > 1 && !confirm('Sair da partida?')) return;
  closeSetup(); goHome();
});
$('#roombar').addEventListener('click', e => { if (e.target.closest('button')) { if (confirm(Room.role === 'host' ? 'Fechar a sala?' : 'Sair da sala?')) leaveRoom(); } });
window.addEventListener('beforeunload', () => { if (Room.role === 'host' && Room.client) Room.client.publish(Room.base() + '/s', '', { qos: 0, retain: true }); });
Sound.apply();
bindSetup();
renderHome();
YTP.loadApi().catch(() => {});

const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('s')) renderJoin(hash.get('s'), +hash.get('b') || 0);
