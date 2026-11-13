// Quran Radio — Android app (generated from the Chrome extension)
// Quran Radio — Android app (generated from the Chrome extension)

// ═══════════════════════════════════════════════════════════
//  Android app layer: storage + audio engine + background service
//  (replaces chrome.storage / background.js / offscreen.js)
// ═══════════════════════════════════════════════════════════
const store = {
  get(key) {
    try {
      const raw = localStorage.getItem('qr_' + key);
      return { [key]: raw === null ? undefined : JSON.parse(raw) };
    } catch (_) { return { [key]: undefined }; }
  },
  set(obj) {
    try { Object.keys(obj).forEach((k) => localStorage.setItem('qr_' + k, JSON.stringify(obj[k]))); } catch (_) {}
  }
};

const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const NativePlugins = (Cap && Cap.Plugins) || {};
const SystemBars = NativePlugins.SystemBars;
const AppPlugin = NativePlugins.App;

function applySystemBars(theme) {
  try {
    if (SystemBars && SystemBars.setStyle) {
      SystemBars.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' });
    }
  } catch (_) {}
}

// ── Media notification (MediaStyle + MediaSession: shows on lock screen with controls) ──
const Media = NativePlugins.MediaControl;
let mediaPermAsked = false;
let usingNative = false;   // true while the native (ExoPlayer) service plays the stream
let nativeWaiter = null;

function mediaLabels() {
  const ar = currentLang === 'ar' || currentLang === 'ur';
  return ar
    ? { lblPlay: 'تشغيل', lblPause: 'إيقاف مؤقت', lblNext: 'التالي', lblPrev: 'السابق', lblStop: 'إغلاق' }
    : { lblPlay: 'Play', lblPause: 'Pause', lblNext: 'Next', lblPrev: 'Previous', lblStop: 'Close' };
}

async function mediaShow(playing) {
  if (!Media) return;
  try {
    if (!mediaPermAsked) { mediaPermAsked = true; await Media.requestPermission(); }
    const n = stationNotifText();
    await Media.show({ title: n.title, subtitle: n.body, playing, ...mediaLabels() });
  } catch (_) {}
}

async function mediaHide() {
  if (!Media) return;
  try { await Media.hide(); } catch (_) {}
}

function mediaMeta() {
  const n = stationNotifText();
  return { title: n.title, subtitle: n.body, ...mediaLabels() };
}

function nativePlay(urls) {
  return new Promise((resolve) => {
    if (nativeWaiter) nativeWaiter({ success: false, aborted: true });
    let done = false;
    let tm = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (nativeWaiter === finish) nativeWaiter = null;
      clearTimeout(tm);
      resolve(r);
    };
    tm = setTimeout(() => finish({ success: false, error: 'TIMEOUT' }), 60000);
    nativeWaiter = finish;
    Media.playStream({ urls, volume: audio.volume, ...mediaMeta() })
      .catch(() => finish({ success: false, error: 'NATIVE' }));
  });
}

function syncUiPlaying(p) {
  activePlayRequestId++;
  hasConnectionError = false;
  isPlaying = p;
  setLoadingState(false);
  updatePlayState();
}

function syncUiFailed() {
  activePlayRequestId++;
  isPlaying = false;
  hasConnectionError = true;
  setLoadingState(false);
  updatePlayState();
  refreshStatusLabel();
}

if (Media && Media.addListener) {
  // Events from the native player (it keeps running even when the web view is throttled)
  Media.addListener('state', (ev) => {
    const st = ev && ev.state;
    if (st === 'started') {
      if (nativeWaiter) nativeWaiter({ success: true });
    } else if (st === 'failed') {
      if (nativeWaiter) nativeWaiter({ success: false, error: 'Stream error' });
      else syncUiFailed();
    } else if (st === 'paused') {
      syncUiPlaying(false);
    } else if (st === 'resumed') {
      syncUiPlaying(true);
    }
  });
}

if (Media && Media.addListener) {
  Media.addListener('action', (ev) => {
    const a = ev && ev.action;
    if (a === 'play') {
      if (!isPlaying) startPlaybackForCurrentStation();
    } else if (a === 'pause') {
      pauseFromExternal(false);
    } else if (a === 'next') {
      stepStation(1);
    } else if (a === 'prev') {
      stepStation(-1);
    } else if (a === 'stop') {
      pauseFromExternal(true);
      try { if (AppPlugin && AppPlugin.exitApp) AppPlugin.exitApp(); } catch (_) {}
    }
  });
}

// Back button: send app to background instead of killing it (so audio keeps playing)
if (AppPlugin && AppPlugin.addListener) {
  AppPlugin.addListener('backButton', () => {
    if (!langMenu.hidden) { closeLangMenu(); return; }
    try { AppPlugin.minimizeApp(); } catch (_) {}
  });
}

// ── Audio engine (ported from offscreen.js) ──
const audio = new Audio();
audio.preload = 'none';

let currentPlayId = 0;
let stallTimer = null;
let engineVolume = 1.0;
let wantPlaying = false;
let lastPlayArgs = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

function applyVolume(vol) {
  const clamped = Math.max(0, Math.min(1, Number(vol ?? 1)));
  engineVolume = clamped;
  audio.volume = clamped === 0 ? 0 : Math.min(1, Math.pow(clamped, 1.7));
  if (usingNative && Media && Media.setVolume) {
    try { Media.setVolume({ volume: audio.volume }); } catch (_) {}
  }
}
applyVolume(1.0);

function clearStallTimer() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }
function clearReconnectTimer() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }

function buildCandidateUrls(url, fallbackUrls = []) {
  const candidates = [];
  const addUrl = (u) => {
    if (!u || typeof u !== 'string') return;
    if (u.startsWith('mp3quran-server:')) return; // live streams only
    if (!candidates.includes(u)) candidates.push(u);
  };

  if (url && url.includes('://qurango.net/radio/')) {
    addUrl(url.replace('://qurango.net/radio/', '://backup.qurango.net/radio/'));
    addUrl(url);
  } else if (url && url.includes('://backup.qurango.net/radio/')) {
    addUrl(url);
    addUrl(url.replace('://backup.qurango.net/radio/', '://qurango.net/radio/'));
  } else if (url) {
    addUrl(url);
  }

  if (Array.isArray(fallbackUrls)) fallbackUrls.forEach(addUrl);
  return candidates;
}

function tryPlaySingleUrl(targetUrl, playId, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (playId !== currentPlayId) return reject(new Error('ABORTED'));

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('TIMEOUT')); }
    }, timeoutMs);

    audio.pause();
    applyVolume(engineVolume);
    audio.src = targetUrl;
    audio.load();
    audio.play()
      .then(() => { if (settled) return; settled = true; clearTimeout(timer); resolve(true); })
      .catch((err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); });
  });
}

async function playStation(url, volume, fallbackUrls = []) {
  const playId = ++currentPlayId;
  clearStallTimer();
  if (volume !== undefined && volume !== null) applyVolume(volume);

  const candidates = buildCandidateUrls(url, fallbackUrls);
  let lastError = null;

  for (const candidate of candidates) {
    if (playId !== currentPlayId) return { success: false, aborted: true };
    try {
      await tryPlaySingleUrl(candidate, playId, 6000);
      if (playId !== currentPlayId) return { success: false, aborted: true };
      return { success: true, activeUrl: candidate };
    } catch (err) {
      if (playId !== currentPlayId || (err && err.message === 'ABORTED')) return { success: false, aborted: true };
      lastError = err;
    }
  }

  if (candidates.length > 0 && playId === currentPlayId) {
    const primary = candidates[0];
    const retryUrl = primary.includes('serverkw.quran-uni.com')
      ? primary
      : primary + (primary.includes('?') ? '&' : '?') + '_t=' + Date.now();
    try {
      await tryPlaySingleUrl(retryUrl, playId, 7000);
      if (playId !== currentPlayId) return { success: false, aborted: true };
      return { success: true, activeUrl: retryUrl };
    } catch (err) {
      if (playId !== currentPlayId) return { success: false, aborted: true };
      lastError = err;
    }
  }
  return { success: false, error: (lastError && lastError.message) || 'Stream error' };
}

function stationNotifText() {
  const st = stations[currentStationIndex] || stations[0];
  return {
    title: translateStationName(st.name),
    body: translateStationSubtitle(st.subtitle)
  };
}

async function enginePlay(message) {
  wantPlaying = true;
  clearReconnectTimer();
  reconnectAttempts = 0;
  lastPlayArgs = { url: message.url, fallbackUrls: message.fallbackUrls || [] };
  store.set({ currentStation: message.stationIndex, volume: message.volume });

  // 1) Preferred: native player inside the foreground service (survives screen-off / throttling)
  if (Media && Media.playStream) {
    currentPlayId++;
    clearStallTimer();
    try { audio.pause(); } catch (_) {}
    if (message.volume !== undefined && message.volume !== null) applyVolume(message.volume);
    if (!mediaPermAsked) {
      mediaPermAsked = true;
      try { await Media.requestPermission(); } catch (_) {}
    }
    usingNative = true;
    applyVolume(engineVolume);
    const urls = buildCandidateUrls(message.url, message.fallbackUrls || []);
    const r = await nativePlay(urls);
    if (r && r.aborted) return { success: false, aborted: true };
    if (r && r.success) return { success: true };
    usingNative = false; // could not start natively -> fall back to the web view player below
  }

  // 2) Fallback: web view <audio>
  mediaShow(true);

  const res = await playStation(message.url, message.volume, message.fallbackUrls || []);
  if (res && res.aborted) return { success: false, aborted: true };
  if (!res || !res.success) {
    wantPlaying = false;
    mediaHide();
    return { success: false, error: (res && res.error) || 'Stream error' };
  }
  return { success: true };
}

function enginePause(hideNotification) {
  wantPlaying = false;
  currentPlayId++;
  clearStallTimer();
  clearReconnectTimer();
  audio.pause();
  if (nativeWaiter) nativeWaiter({ success: false, aborted: true });
  if (usingNative) {
    if (hideNotification) mediaHide();
    else { try { Media.pauseStream(); } catch (_) {} }
  } else if (hideNotification) {
    mediaHide();
  } else {
    mediaShow(false);
  }
  return { success: true };
}

// Called from the notification / lock screen / headset buttons
function pauseFromExternal(hideNotification) {
  activePlayRequestId++;
  enginePause(!!hideNotification);
  hasConnectionError = false;
  isPlaying = false;
  setLoadingState(false);
  updatePlayState();
}

function stepStation(dir) {
  let list = Array.from(stationList.querySelectorAll('.station-item'))
    .filter((el) => el.dataset.match !== '0')
    .map((el) => parseInt(el.dataset.index, 10));
  if (!list.length) list = stations.map((_, i) => i);
  const pos = list.indexOf(currentStationIndex);
  const next = pos === -1
    ? list[dir > 0 ? 0 : list.length - 1]
    : list[(pos + dir + list.length) % list.length];
  expandedSections.add(stations[next].section);
  selectStation(next);
  filterStations(searchInput.value);
  const el = stationList.querySelector('.station-item.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

async function engineHandle(message) {
  switch (message.action) {
    case 'play': return enginePlay(message);
    case 'pause': return enginePause(false);
    case 'setVolume': {
      const v = Math.max(0, Math.min(1, Number(message.volume ?? 1)));
      applyVolume(v);
      store.set({ volume: v });
      return { success: true, volume: v };
    }
    case 'getState': {
      const st = store.get('currentStation').currentStation;
      const vol = store.get('volume').volume;
      return {
        success: true,
        state: {
          isPlaying: wantPlaying && !audio.paused,
          currentStation: typeof st === 'number' ? st : 0,
          volume: typeof vol === 'number' ? vol : 1.0
        }
      };
    }
    default: return { success: false, error: 'Unknown action' };
  }
}

// Live stream ended unexpectedly -> reconnect
audio.addEventListener('ended', () => { if (wantPlaying) scheduleReconnect(); });

audio.addEventListener('stalled', () => {
  clearStallTimer();
  const stalledPlayId = currentPlayId;
  const stalledSrc = audio.src;
  stallTimer = setTimeout(() => {
    if (stalledPlayId === currentPlayId && stalledSrc && audio.src === stalledSrc && !audio.paused && audio.readyState < 3) {
      audio.load();
      applyVolume(engineVolume);
      audio.play().catch(() => {});
    }
  }, 4000);
});

audio.addEventListener('playing', () => { reconnectAttempts = 0; });

// Auto-reconnect when the stream drops (mobile networks)
audio.addEventListener('error', () => { if (wantPlaying) scheduleReconnect(); });
window.addEventListener('online', () => { if (wantPlaying && (audio.paused || audio.error)) scheduleReconnect(500); });

function scheduleReconnect(delay) {
  if (usingNative) return;
  if (!wantPlaying || !lastPlayArgs || reconnectTimer) return;
  if (reconnectAttempts >= 6) {
    wantPlaying = false;
    mediaShow(false);
    activePlayRequestId++;
    isPlaying = false;
    hasConnectionError = true;
    setLoadingState(false);
    updatePlayState();
    return;
  }
  reconnectAttempts++;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!wantPlaying) return;
    const res = await playStation(lastPlayArgs.url, engineVolume, lastPlayArgs.fallbackUrls);
    if (res && res.success) reconnectAttempts = 0;
    else if (!(res && res.aborted) && wantPlaying) scheduleReconnect();
  }, delay || 2500);
}



// ═══════════ UI (from popup.js) ═══════════
// popup.js — Quran Radio (20 Riwayat + Senior Reciters + Live Radio Broadcasts)

const SECTIONS = [
  { id: 'all', badge: 'الكل', title: 'جميع الأقسام والروايات' },
  { id: 'kibar', badge: 'قسم ١', title: 'كبار القراء' },
  { id: 'radios', badge: 'قسم ٢', title: 'قسم الإذاعات' },
  { id: 'riwaya_1', badge: 'رواية ١', title: 'رواية حفص عن عاصم' },
  { id: 'riwaya_2', badge: 'رواية ٢', title: 'رواية شعبة عن عاصم' },
  { id: 'riwaya_3', badge: 'رواية ٣', title: 'رواية ورش عن نافع' },
  { id: 'riwaya_4', badge: 'رواية ٤', title: 'رواية قالون عن نافع' },
  { id: 'riwaya_5', badge: 'رواية ٥', title: 'رواية البزي عن ابن كثير' },
  { id: 'riwaya_6', badge: 'رواية ٦', title: 'رواية قنبل عن ابن كثير' },
  { id: 'riwaya_7', badge: 'رواية ٧', title: 'رواية الدوري عن أبي عمرو' },
  { id: 'riwaya_8', badge: 'رواية ٨', title: 'رواية السوسي عن أبي عمرو' },
  { id: 'riwaya_10', badge: 'رواية ٩', title: 'رواية ابن ذكوان عن ابن عامر' },
  { id: 'riwaya_11', badge: 'رواية ١٠', title: 'رواية خلف عن حمزة' },
  { id: 'riwaya_13', badge: 'رواية ١١', title: 'رواية أبي الحارث عن الكسائي' },
  { id: 'riwaya_14', badge: 'رواية ١٢', title: 'رواية الدوري عن الكسائي' },
  { id: 'riwaya_16', badge: 'رواية ١٣', title: 'رواية ابن جماز عن أبي جعفر' },
  { id: 'riwaya_17', badge: 'رواية ١٤', title: 'رواية رويس عن يعقوب الحضرمي' },
  { id: 'riwaya_18', badge: 'رواية ١٥', title: 'رواية روح عن يعقوب الحضرمي' },
  { id: 'islamic', badge: 'قسم خاص', title: 'التفسير والحديث والأذكار والسيرة' },
  { id: 'eid', badge: '', title: 'تكبيرات العيد' }
];

const stations = [
  // ═══════════════════════════════════════════════════════════════════
  // ١. تبويب كبار القراء (الحصري بجميع الروايات، المنشاوي، عبد الباسط، البنا، مصطفى إسماعيل، الطبلاوي)
  // ═══════════════════════════════════════════════════════════════════
  {
    section: 'kibar',
    name: 'محمود خليل الحصري',
    subtitle: 'رواية حفص عن عاصم - مجود',
    url: 'https://backup.qurango.net/radio/mahmoud_khalil_alhussary_mojawwad'
  },
  {
    section: 'kibar',
    name: 'محمود خليل الحصري',
    subtitle: 'رواية حفص عن عاصم - مرتل',
    url: 'https://backup.qurango.net/radio/mahmoud_khalil_alhussary'
  },
  {
    section: 'kibar',
    name: 'محمود خليل الحصري',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/mahmoud_khalil_alhussary_warsh'
  },
  {
    section: 'kibar',
    name: 'محمود خليل الحصري',
    subtitle: 'رواية قالون عن نافع',
    url: 'https://serverkw.quran-uni.com:8206/;*.mp3'
  },
  {
    section: 'kibar',
    name: 'محمود خليل الحصري',
    subtitle: 'رواية الدوري عن أبي عمرو',
    url: 'https://serverkw.quran-uni.com:8050/;*.mp3'
  },
  {
    section: 'kibar',
    name: 'محمد صديق المنشاوي',
    subtitle: 'رواية حفص عن عاصم - مجود',
    url: 'https://backup.qurango.net/radio/mohammed_siddiq_alminshawi_mojawwad'
  },
  {
    section: 'kibar',
    name: 'محمد صديق المنشاوي',
    subtitle: 'رواية حفص عن عاصم - مرتل',
    url: 'https://backup.qurango.net/radio/mohammed_siddiq_alminshawi'
  },
  {
    section: 'kibar',
    name: 'عبد الباسط عبد الصمد',
    subtitle: 'رواية حفص عن عاصم - مجود',
    url: 'https://backup.qurango.net/radio/abdulbasit_abdulsamad_mojawwad'
  },
  {
    section: 'kibar',
    name: 'عبد الباسط عبد الصمد',
    subtitle: 'رواية حفص عن عاصم - مرتل',
    url: 'https://backup.qurango.net/radio/abdulbasit_abdulsamad'
  },
  {
    section: 'kibar',
    name: 'عبد الباسط عبد الصمد',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/abdulbasit_abdulsamad_warsh'
  },
  {
    section: 'kibar',
    name: 'محمود علي البنّا',
    subtitle: 'رواية حفص عن عاصم - مجود',
    url: 'https://backup.qurango.net/radio/mahmoud_ali__albanna_mojawwad'
  },
  {
    section: 'kibar',
    name: 'محمود علي البنّا',
    subtitle: 'رواية حفص عن عاصم - مرتل',
    url: 'https://backup.qurango.net/radio/mahmoud_ali__albanna'
  },
  {
    section: 'kibar',
    name: 'مصطفى إسماعيل',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/mustafa_ismail'
  },
  {
    section: 'kibar',
    name: 'محمد الطبلاوي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/mohammad_altablaway'
  },

  // ═══════════════════════════════════════════════════════════════════
  // ٢. قسم الإذاعات المباشرة والمنوعات القرآنية
  // ═══════════════════════════════════════════════════════════════════
  {
    section: 'radios',
    name: 'إذاعة القرآن الكريم من القاهرة',
    subtitle: 'إذاعة مباشرة',
    url: 'https://stream.radiojar.com/8s5u5tpdtwzuv',
    fallbackUrls: [
      'https://n0a.radiojar.com/8s5u5tpdtwzuv',
      'https://n02.radiojar.com/8s5u5tpdtwzuv',
      'http://stream.radiojar.com/8s5u5tpdtwzuv'
    ]
  },
  {
    section: 'radios',
    name: 'إذاعة القرآن الكريم - السعودية',
    subtitle: 'إذاعة مباشرة',
    url: 'https://stream.radiojar.com/0tpy1h0kxtzuv',
    fallbackUrls: [
      'https://n0a.radiojar.com/0tpy1h0kxtzuv',
      'https://n02.radiojar.com/0tpy1h0kxtzuv',
      'https://backup.qurango.net/radio/mix'
    ]
  },
  {
    section: 'radios',
    name: 'إذاعة الحرم المكي',
    subtitle: 'إذاعة مباشرة',
    url: 'http://r7.tarat.com:8004/stream?type=http&nocache=114',
    fallbackUrls: [
      'https://stream.radiojar.com/0tpy1h0kxtzuv',
      'https://backup.qurango.net/radio/abdulrahman_alsudaes'
    ]
  },
  {
    section: 'radios',
    name: 'الإذاعة العامة - إذاعة متنوعة لمختلف القراء',
    subtitle: 'إذاعة متنوعة',
    url: 'https://backup.qurango.net/radio/mix',
    fallbackUrls: [
      'https://qurango.net/radio/mix',
      'https://backup.qurango.net/radio/salma'
    ]
  },
  {
    section: 'radios',
    name: 'تلاوات خاشعة',
    subtitle: 'روايات متنوعة',
    url: 'https://backup.qurango.net/radio/salma',
    fallbackUrls: [
      'https://qurango.net/radio/salma',
      'https://backup.qurango.net/radio/sakeenah'
    ]
  },
  {
    section: 'radios',
    name: 'إذاعة آيات السكينة',
    subtitle: 'تلاوات هادئة',
    url: 'https://backup.qurango.net/radio/sakeenah',
    fallbackUrls: [
      'https://qurango.net/radio/sakeenah',
      'https://backup.qurango.net/radio/salma'
    ]
  },
  {
    section: 'radios',
    name: 'تراتيل قصيرة متميزة',
    subtitle: 'تلاوات مختارة',
    url: 'https://backup.qurango.net/radio/tarateel',
    fallbackUrls: [
      'https://qurango.net/radio/tarateel',
      'https://backup.qurango.net/radio/salma'
    ]
  },
  {
    section: 'radios',
    name: 'سورة البقرة - لعدد من القراء',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/albaqarah',
    fallbackUrls: ['https://qurango.net/radio/albaqarah']
  },

  // ═══════════════════════════════════════════════════════════════════
  // ٣. الروايات العشرون (مرتبة: حفص، شعبة، ورش، قالون، ثم باقي الروايات العشرين)
  // ═══════════════════════════════════════════════════════════════════

  // ─── (١) رواية حفص عن عاصم ───
  {
    section: 'riwaya_1',
    name: 'أحمد نعينع',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/ahmad_nauina'
  },
  {
    section: 'riwaya_1',
    name: 'أحمد عامر',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/ahmed_amer'
  },
  {
    section: 'riwaya_1',
    name: 'سيد رمضان',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/sayeed_ramadan'
  },
  {
    section: 'riwaya_1',
    name: 'علي حجاج السويسي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/ali_hajjaj_alsouasi'
  },
  {
    section: 'riwaya_1',
    name: 'محمد رشاد الشريف',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/mohammad_rashad_alshareef'
  },
  {
    section: 'riwaya_1',
    name: 'صابر عبد الحكم',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/saber_abdulhakm'
  },
  {
    section: 'riwaya_1',
    name: 'أحمد خليل شاهين',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/ahmad_shaheen'
  },
  {
    section: 'riwaya_1',
    name: 'أحمد صابر',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/ahmad_saber'
  },
  {
    section: 'riwaya_1',
    name: 'مصطفى اللاهوني',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/mustafa_allahoni'
  },
  {
    section: 'riwaya_1',
    name: 'أكرم العلاقمي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/akram_alalaqmi'
  },
  {
    section: 'riwaya_1',
    name: 'ماهر المعيقلي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/maher_al_meaqli'
  },
  {
    section: 'riwaya_1',
    name: 'بندر بليلة',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/bandar_balilah'
  },
  {
    section: 'riwaya_1',
    name: 'علي الحذيفي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/ali_alhuthaifi'
  },
  {
    section: 'riwaya_1',
    name: 'عبد الرحمن السديس',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/abdulrahman_alsudaes'
  },
  {
    section: 'riwaya_1',
    name: 'سعود الشريم',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/saud_alshuraim'
  },
  {
    section: 'riwaya_1',
    name: 'ياسر الدوسري',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/yasser_aldosari'
  },
  {
    section: 'riwaya_1',
    name: 'عبد الله عواد الجهني',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/abdullah_aljohany'
  },
  {
    section: 'riwaya_1',
    name: 'صلاح البدير',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/salah_albudair'
  },
  {
    section: 'riwaya_1',
    name: 'عبد المحسن القاسم',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/abdulmohsen_alqasim'
  },
  {
    section: 'riwaya_1',
    name: 'عبد البارئ الثبيتي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/abdelbari_altoubayti'
  },
  {
    section: 'riwaya_1',
    name: 'أحمد طالب بن حميد',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/a_binhameed'
  },
  {
    section: 'riwaya_1',
    name: 'بدر التركي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/bader'
  },
  {
    section: 'riwaya_1',
    name: 'علي جابر',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/ali_jaber'
  },
  {
    section: 'riwaya_1',
    name: 'محمد أيوب',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/mohammed_ayyub'
  },
  {
    section: 'riwaya_1',
    name: 'محمد أيوب',
    subtitle: 'قراءة مميزة - رواية حفص',
    url: 'https://backup.qurango.net/radio/ayyoub2'
  },
  {
    section: 'riwaya_1',
    name: 'عبد الله خياط',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/abdullah_khayyat'
  },
  {
    section: 'riwaya_1',
    name: 'مشاري راشد العفاسي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/mishary_alafasi'
  },
  {
    section: 'riwaya_1',
    name: 'أبو بكر الشاطري',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/shaik_abu_bakr_al_shatri'
  },
  {
    section: 'riwaya_1',
    name: 'سعد الغامدي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/saad_alghamdi'
  },
  {
    section: 'riwaya_1',
    name: 'أحمد العجمي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/ahmad_alajmy'
  },
  {
    section: 'riwaya_1',
    name: 'فارس عباد',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/fares_abbad'
  },
  {
    section: 'riwaya_1',
    name: 'إدريس أبكر',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/idrees_abkr'
  },
  {
    section: 'riwaya_1',
    name: 'ناصر القطامي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/nasser_alqatami'
  },
  {
    section: 'riwaya_1',
    name: 'خالد الجليل',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/khalid_aljileel'
  },
  {
    section: 'riwaya_1',
    name: 'محمد اللحيدان',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/mohammed_allohaidan'
  },
  {
    section: 'riwaya_1',
    name: 'محمد جبريل',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/mohammed_jibreel'
  },
  {
    section: 'riwaya_1',
    name: 'هاني الرفاعي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/hani_arrifai'
  },
  {
    section: 'riwaya_1',
    name: 'عادل الكلباني',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/adel_alkhalbany'
  },
  {
    section: 'riwaya_1',
    name: 'صلاح بو خاطر',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/slaah_bukhatir'
  },
  {
    section: 'riwaya_1',
    name: 'عبد الله بصفر',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/abdullah_basfer'
  },
  {
    section: 'riwaya_1',
    name: 'عبد الله المطرود',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/abdullah_almattrod'
  },
  {
    section: 'riwaya_1',
    name: 'خالد القحطاني',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/khaled_alqahtani'
  },
  {
    section: 'riwaya_1',
    name: 'خليفة الطنيجي',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/khalifa_altunaiji'
  },
  {
    section: 'riwaya_1',
    name: 'حاتم فريد الواعر',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/hatem_fareed_alwaer'
  },
  {
    section: 'riwaya_1',
    name: 'الزين محمد أحمد',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/alzain_mohammad_ahmad'
  },
  {
    section: 'riwaya_1',
    name: 'أحمد ديبان',
    subtitle: 'رواية حفص عن عاصم',
    url: 'https://backup.qurango.net/radio/ahmad_deban'
  },

  // ─── (٢) رواية شعبة عن عاصم ───
  {
    section: 'riwaya_2',
    name: 'عبد الرشيد صوفي',
    subtitle: 'رواية شعبة عن عاصم',
    url: 'https://serverkw.quran-uni.com:8172/;*.mp3'
  },
  {
    section: 'riwaya_2',
    name: 'أحمد ديبان',
    subtitle: 'رواية شعبة عن عاصم',
    url: 'https://backup.qurango.net/radio/ahmad_deban'
  },

  // ─── (٣) رواية ورش عن نافع ───
  {
    section: 'riwaya_3',
    name: 'محمود خليل الحصري',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/mahmoud_khalil_alhussary_warsh'
  },
  {
    section: 'riwaya_3',
    name: 'عبد الباسط عبد الصمد',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/abdulbasit_abdulsamad_warsh'
  },
  {
    section: 'riwaya_3',
    name: 'العيون الكوشي',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/aloyoon_alkoshi'
  },
  {
    section: 'riwaya_3',
    name: 'عمر القزابري',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/omar_alqazabri'
  },
  {
    section: 'riwaya_3',
    name: 'القارئ ياسين',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/alqaria_yassen'
  },
  {
    section: 'riwaya_3',
    name: 'إبراهيم الدوسري',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/ibrahim_aldosari'
  },
  {
    section: 'riwaya_3',
    name: 'محمد عبد الكريم',
    subtitle: 'رواية ورش عن نافع من طريق الأصبهاني',
    url: 'https://backup.qurango.net/radio/mohammad_abdullkarem_alasbahani'
  },

  // ─── (٤) رواية قالون عن نافع ───
  {
    section: 'riwaya_4',
    name: 'محمود خليل الحصري',
    subtitle: 'رواية قالون عن نافع',
    url: 'https://serverkw.quran-uni.com:8206/;*.mp3'
  },
  {
    section: 'riwaya_4',
    name: 'علي الحذيفي',
    subtitle: 'رواية قالون عن نافع',
    url: 'https://backup.qurango.net/radio/ali_alhuthaifi_qalon'
  },
  {
    section: 'riwaya_4',
    name: 'أحمد خضر الطرابلسي',
    subtitle: 'رواية قالون عن نافع',
    url: 'https://backup.qurango.net/radio/ahmad_khader_altarabulsi'
  },
  {
    section: 'riwaya_4',
    name: 'الدوكالي محمد العالم',
    subtitle: 'رواية قالون عن نافع',
    url: 'https://backup.qurango.net/radio/addokali_mohammad_alalim'
  },
  {
    section: 'riwaya_4',
    name: 'طارق عبد الغني دعوب',
    subtitle: 'رواية قالون عن نافع',
    url: 'https://backup.qurango.net/radio/tareq_abdulgani_daawob'
  },
  {
    section: 'riwaya_4',
    name: 'وليد النائحي',
    subtitle: 'رواية قالون عن نافع من طريق أبي نشيط',
    url: 'https://backup.qurango.net/radio/waleed_alnaehi'
  },

  // ─── (٥) رواية البزي عن ابن كثير ───
  {
    section: 'riwaya_5',
    name: 'يوسف بن نوح أحمد',
    subtitle: 'رواية البزي عن ابن كثير',
    url: 'https://backup.qurango.net/radio/yousef_bin_noah_ahmad'
  },
  {
    section: 'riwaya_5',
    name: 'محمد عبد الحكيم سعيد العبد الله',
    subtitle: 'رواية البزي وقنبل عن ابن كثير',
    url: 'https://backup.qurango.net/radio/mohammad_alabdullah_albizi'
  },

  // ─── (٦) رواية قنبل عن ابن كثير ───
  {
    section: 'riwaya_6',
    name: 'محمد عبد الحكيم سعيد العبد الله',
    subtitle: 'رواية البزي وقنبل عن ابن كثير',
    url: 'https://backup.qurango.net/radio/mohammad_alabdullah_albizi'
  },

  // ─── (٧) رواية الدوري عن أبي عمرو ───
  {
    section: 'riwaya_7',
    name: 'محمود خليل الحصري',
    subtitle: 'رواية الدوري عن أبي عمرو',
    url: 'https://serverkw.quran-uni.com:8050/;*.mp3'
  },
  {
    section: 'riwaya_7',
    name: 'الفاتح محمد الزبير',
    subtitle: 'رواية الدوري عن أبي عمرو',
    url: 'https://backup.qurango.net/radio/alfateh_alzubair'
  },
  {
    section: 'riwaya_7',
    name: 'مفتاح السلطني',
    subtitle: 'رواية الدوري عن أبي عمرو',
    url: 'https://backup.qurango.net/radio/muftah_alsaltany_aldori_an_abi_amr'
  },
  {
    section: 'riwaya_7',
    name: 'عبد الرشيد صوفي',
    subtitle: 'رواية الدوري عن أبي عمرو',
    url: 'https://serverkw.quran-uni.com:8048/;*.mp3'
  },

  // ─── (٨) رواية السوسي عن أبي عمرو ───
  {
    section: 'riwaya_8',
    name: 'عبد الرشيد صوفي',
    subtitle: 'رواية السوسي عن أبي عمرو',
    url: 'https://backup.qurango.net/radio/abdulrasheed_soufi_assosi'
  },

  // ─── (٩) رواية ابن ذكوان عن ابن عامر ───
  {
    section: 'riwaya_10',
    name: 'مفتاح السلطني',
    subtitle: 'رواية ابن ذكوان عن ابن عامر',
    url: 'https://backup.qurango.net/radio/muftah_alsaltany_ibn_thakwan_an_ibn_amr'
  },
  {
    section: 'riwaya_10',
    name: 'مجدي البلتاجي',
    subtitle: 'رواية ابن ذكوان عن ابن عامر',
    url: 'https://serverkw.quran-uni.com:8174/;*.mp3'
  },

  // ─── (١٠) رواية خلف عن حمزة ───
  {
    section: 'riwaya_11',
    name: 'عبد الرشيد صوفي',
    subtitle: 'رواية خلف عن حمزة',
    url: 'https://backup.qurango.net/radio/abdulrasheed_soufi_khalaf'
  },

  // ─── (١١) رواية أبي الحارث عن الكسائي ───
  {
    section: 'riwaya_13',
    name: 'عبد الرشيد صوفي',
    subtitle: 'رواية أبي الحارث عن الكسائي',
    url: 'https://serverkw.quran-uni.com:8042/;*.mp3'
  },

  // ─── (١٢) رواية الدوري عن الكسائي ───
  {
    section: 'riwaya_14',
    name: 'مفتاح السلطني',
    subtitle: 'رواية الدوري عن الكسائي',
    url: 'https://backup.qurango.net/radio/muftah_alsaltany_aldorai'
  },
  {
    section: 'riwaya_14',
    name: 'محمد عبد الحكيم سعيد العبد الله',
    subtitle: 'رواية الدوري عن الكسائي',
    url: 'https://backup.qurango.net/radio/mohammad_alabdullah_aldorai'
  },
  {
    section: 'riwaya_14',
    name: 'محمود الشيمي',
    subtitle: 'رواية الدوري عن الكسائي',
    url: 'https://backup.qurango.net/radio/mahmood_alsheimy'
  },

  // ─── (١٣) رواية ابن جماز عن أبي جعفر ───
  {
    section: 'riwaya_16',
    name: 'مفتاح السلطني',
    subtitle: 'رواية ابن جماز عن أبي جعفر',
    url: 'https://serverkw.quran-uni.com:8040/;*.mp3'
  },

  // ─── (١٤) رواية رويس عن يعقوب الحضرمي ───
  {
    section: 'riwaya_17',
    name: 'مفتاح السلطني',
    subtitle: 'رواية رويس عن يعقوب الحضرمي',
    url: 'https://serverkw.quran-uni.com:8170/;*.mp3'
  },

  // ─── (١٥) رواية روح عن يعقوب الحضرمي ───
  {
    section: 'riwaya_18',
    name: 'مفتاح السلطني',
    subtitle: 'رواية روح عن يعقوب الحضرمي',
    url: 'https://serverkw.quran-uni.com:8056/;*.mp3'
  },

  // ═══════════════════════════════════════════════════════════════════
  // ٤. قسم التفسير والحديث والأذكار والسيرة
  // ═══════════════════════════════════════════════════════════════════
  {
    section: 'islamic',
    name: 'الرقية الشرعية',
    subtitle: 'رقية شرعية',
    url: 'https://backup.qurango.net/radio/roqiah'
  },
  {
    section: 'islamic',
    name: 'أذكار الصباح',
    subtitle: 'أذكار',
    url: 'https://backup.qurango.net/radio/athkar_sabah'
  },
  {
    section: 'islamic',
    name: 'أذكار المساء',
    subtitle: 'أذكار',
    url: 'https://backup.qurango.net/radio/athkar_masa'
  },
  {
    section: 'islamic',
    name: 'قصص الأنبياء',
    subtitle: 'قصص',
    url: 'https://backup.qurango.net/radio/alanbiya'
  },
  {
    section: 'islamic',
    name: 'صحيح البخاري',
    subtitle: 'حديث',
    url: 'https://backup.qurango.net/radio/saheh-bokharee'
  },
  {
    section: 'islamic',
    name: 'صحيح مسلم',
    subtitle: 'حديث',
    url: 'https://backup.qurango.net/radio/saheh-muslim'
  },
  {
    section: 'islamic',
    name: 'رياض الصالحين',
    subtitle: 'حديث',
    url: 'https://backup.qurango.net/radio/riyad'
  },
  {
    section: 'islamic',
    name: 'المختصر في السيرة النبوية',
    subtitle: 'السيرة',
    url: 'https://backup.qurango.net/radio/almukhtasar_fi_alsiyra'
  },
  {
    section: 'islamic',
    name: 'في ظلال السيرة النبوية',
    subtitle: 'السيرة',
    url: 'https://backup.qurango.net/radio/fi_zilal_alsiyra'
  },
  {
    section: 'islamic',
    name: 'المختصر في تفسير القرآن الكريم',
    subtitle: 'تفسير',
    url: 'https://backup.qurango.net/radio/mukhtasartafsir'
  },
  {
    section: 'islamic',
    name: 'تفسير القرآن الكريم للإمام الطبري',
    subtitle: 'تفسير',
    url: 'https://backup.qurango.net/radio/tabri'
  },

  // ═══════════════════════════════════════════════════════════════════
  // ٥. تكبيرات العيد (في آخر القائمة خالص)
  // ═══════════════════════════════════════════════════════════════════
  {
    section: 'eid',
    name: 'تكبيرات العيد',
    subtitle: 'بث مباشر',
    url: 'https://backup.qurango.net/radio/eid'
  }
];

// ─── إعدادات اللغات والترجمة (Multi-Language Support) ───
const LANGUAGES = [
  { code: 'ar', label: 'العربية', dir: 'rtl' },
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'fr', label: 'Français', dir: 'ltr' },
  { code: 'es', label: 'Español', dir: 'ltr' },
  { code: 'tr', label: 'Türkçe', dir: 'ltr' },
  { code: 'id', label: 'Indonesia', dir: 'ltr' },
  { code: 'ur', label: 'اردو', dir: 'rtl' },
  { code: 'ru', label: 'Русский', dir: 'ltr' },
  { code: 'de', label: 'Deutsch', dir: 'ltr' }
];

const UI_STRINGS = {
  ar: {
    headerTitle: 'وَرَتِّلِ الْقُرْآنَ تَرْتِيلًا',
    headerSubtitle: 'LIVE QURAN RADIO • بث مباشر',
    footerQuote: 'وَرَتِّلِ الْقُرْآنَ تَرْتِيلًا',
    stopped: 'متوقف',
    live: 'يُبَثّ الآن',
    loading: 'جارٍ التحميل...',
    error: 'تعذّر الاتصال، حاول مجدداً',
    searchPlaceholder: 'ابحث عن قارئ أو رواية أو إذاعة...',
    themeTitle: 'تغيير المظهر',
    langTitle: 'تغيير اللغة',
    playTitle: 'تشغيل / إيقاف',
    muteTitle: 'كتم الصوت',
    volumeTitle: 'مستوى الصوت'
  },
  en: {
    headerTitle: 'And Recite the Quran with Measured Recitation',
    headerSubtitle: 'LIVE QURAN RADIO • 24/7',
    footerQuote: 'And recite the Quran with measured recitation',
    stopped: 'Stopped',
    live: 'Live Now',
    loading: 'Loading...',
    error: 'Connection failed, try again',
    searchPlaceholder: 'Search reciter, narration or station...',
    themeTitle: 'Toggle theme',
    langTitle: 'Change language',
    playTitle: 'Play / Pause',
    muteTitle: 'Mute / Unmute',
    volumeTitle: 'Volume'
  },
  fr: {
    headerTitle: 'Et récite le Coran lentement et clairement',
    headerSubtitle: 'RADIO CORAN EN DIRECT • 24/7',
    footerQuote: 'Et récite le Coran lentement et clairement',
    stopped: 'Arrêté',
    live: 'En direct',
    loading: 'Chargement...',
    error: 'Échec de connexion, réessayez',
    searchPlaceholder: 'Rechercher un récitateur ou une narration...',
    themeTitle: 'Changer le thème',
    langTitle: 'Changer la langue',
    playTitle: 'Lecture / Pause',
    muteTitle: 'Muet',
    volumeTitle: 'Volume'
  },
  es: {
    headerTitle: 'Y recita el Corán con una recitación pausada',
    headerSubtitle: 'RADIO CORÁN EN VIVO • 24/7',
    footerQuote: 'Y recita el Corán con una recitación pausada',
    stopped: 'Detenido',
    live: 'En vivo',
    loading: 'Cargando...',
    error: 'Error de conexión, reintente',
    searchPlaceholder: 'Buscar recitador o narración...',
    themeTitle: 'Cambiar tema',
    langTitle: 'Cambiar idioma',
    playTitle: 'Reproducir / Pausar',
    muteTitle: 'Silenciar',
    volumeTitle: 'Volumen'
  },
  tr: {
    headerTitle: "Kur'ân'ı Tertîl Üzere Oku",
    headerSubtitle: "CANLI KUR'ÂN RADYOSU • 7/24",
    footerQuote: "Kur'ân'ı açık ve tane tane oku",
    stopped: 'Durduruldu',
    live: 'Canlı Yayın',
    loading: 'Yükleniyor...',
    error: 'Bağlantı hatası, tekrar deneyin',
    searchPlaceholder: 'Kâri, rivayet veya radyo ara...',
    themeTitle: 'Temayı değiştir',
    langTitle: 'Dili değiştir',
    playTitle: 'Oynat / Duraklat',
    muteTitle: 'Sesi kapat',
    volumeTitle: 'Ses seviyesi'
  },
  id: {
    headerTitle: 'Dan Bacalah Al-Quran Secara Tartil',
    headerSubtitle: 'RADIO AL-QURAN LANGSUNG • 24/7',
    footerQuote: 'Dan bacalah Al-Quran itu dengan perlahan-lahan',
    stopped: 'Berhenti',
    live: 'Sedang Siaran',
    loading: 'Memuat...',
    error: 'Gagal terhubung, coba lagi',
    searchPlaceholder: 'Cari qari, riwayat atau radio...',
    themeTitle: 'Ubah tema',
    langTitle: 'Ubah bahasa',
    playTitle: 'Putar / Jeda',
    muteTitle: 'Bisukan',
    volumeTitle: 'Volume suara'
  },
  ur: {
    headerTitle: 'وَرَتِّلِ الْقُرْآنَ تَرْتِيلًا',
    headerSubtitle: 'لائیو قرآن ریڈیو • براہِ راست',
    footerQuote: 'اور قرآن کو ٹھہر ٹھہر کر پڑھو',
    stopped: 'رکا ہوا',
    live: 'براہِ راست جاری',
    loading: 'لوڈ ہو رہا ہے...',
    error: 'کنکشن ناکام، دوبارہ کوشش کریں',
    searchPlaceholder: 'قاری، روایت یا ریڈیو تلاش کریں...',
    themeTitle: 'تھیم تبدیل کریں',
    langTitle: 'زبان تبدیل کریں',
    playTitle: 'چلائیں / روکیں',
    muteTitle: 'آواز بند کریں',
    volumeTitle: 'آواز کی سطح'
  },
  ru: {
    headerTitle: 'Читай Коран размеренным чтением',
    headerSubtitle: 'РАДИО КОРАН В ПРЯМОМ ЭФИРЕ • 24/7',
    footerQuote: 'Читай Коран размеренным чтением',
    stopped: 'Остановлено',
    live: 'В эфире',
    loading: 'Загрузка...',
    error: 'Ошибка подключения, повторите',
    searchPlaceholder: 'Поиск чтеца, риваята или радио...',
    themeTitle: 'Сменить тему',
    langTitle: 'Сменить язык',
    playTitle: 'Старт / Пауза',
    muteTitle: 'Без звука',
    volumeTitle: 'Громкость'
  },
  de: {
    headerTitle: 'Und trage den Koran wohlgeordnet vor',
    headerSubtitle: 'LIVE KORAN RADIO • 24/7',
    footerQuote: 'Und trage den Koran wohlgeordnet vor',
    stopped: 'Gestoppt',
    live: 'Live-Übertragung',
    loading: 'Wird geladen...',
    error: 'Verbindungsfehler, erneut versuchen',
    searchPlaceholder: 'Rezitator, Überlieferung oder Sender suchen...',
    themeTitle: 'Design wechseln',
    langTitle: 'Sprache ändern',
    playTitle: 'Wiedergabe / Pause',
    muteTitle: 'Stummschalten',
    volumeTitle: 'Lautstärke'
  }
};

const SECTION_TRANSLATIONS = {
  all: {
    ar: 'الكل',
    en: 'All',
    fr: 'Tout',
    es: 'Todo',
    tr: 'Tümü',
    id: 'Semua',
    ur: 'سب',
    ru: 'Все',
    de: 'Alle'
  },
  kibar: {
    ar: 'كبار القراء',
    en: 'Senior Reciters',
    fr: 'Grands Récitateurs',
    es: 'Grandes Recitadores',
    tr: 'Büyük Kâriler',
    id: 'Qari Senior Utama',
    ur: 'کبار قراء',
    ru: 'Великие чтецы',
    de: 'Große Rezitatoren'
  },
  radios: {
    ar: 'قسم الإذاعات',
    en: 'Radio Stations',
    fr: 'Stations Radio',
    es: 'Emisoras de Radio',
    tr: 'Radyo İstasyonları',
    id: 'Stasiun Radio',
    ur: 'ریڈیو اسٹیشنز',
    ru: 'Радиостанции',
    de: 'Radiosender'
  },
  riwaya_1: {
    ar: 'رواية حفص عن عاصم',
    en: "1. Hafs 'an 'Asim",
    fr: '1. Hafs d’après Asim',
    es: '1. Hafs de Asim',
    tr: '1. Âsım’dan Hafs Rivayeti',
    id: "1. Riwayat Hafs 'an 'Ashim",
    ur: '١. روایتِ حفص عن عاصم',
    ru: '1. Риваят Хафс от Асима',
    de: '1. Hafs nach Asim'
  },
  riwaya_2: {
    ar: 'رواية شعبة عن عاصم',
    en: "2. Shu'bah 'an 'Asim",
    fr: '2. Chou’bah d’après Asim',
    es: '2. Shu’bah de Asim',
    tr: '2. Âsım’dan Şu’be Rivayeti',
    id: "2. Riwayat Syu'bah 'an 'Ashim",
    ur: '٢. روایتِ شعبہ عن عاصم',
    ru: '2. Риваят Шуаба от Асима',
    de: '2. Schuba nach Asim'
  },
  riwaya_3: {
    ar: 'رواية ورش عن نافع',
    en: "3. Warsh 'an Nafi'",
    fr: '3. Warch d’après Nafi',
    es: '3. Warsh de Nafi',
    tr: '3. Nâfi’den Verş Rivayeti',
    id: "3. Riwayat Warsy 'an Nafi'",
    ur: '٣. روایتِ ورش عن نافع',
    ru: '3. Риваят Варш от Нафи',
    de: '3. Warsch nach Nafi'
  },
  riwaya_4: {
    ar: 'رواية قالون عن نافع',
    en: "4. Qalun 'an Nafi'",
    fr: '4. Qaloun d’après Nafi',
    es: '4. Qalun de Nafi',
    tr: '4. Nâfi’den Kâlûn Rivayeti',
    id: "4. Riwayat Qalun 'an Nafi'",
    ur: '٤. روایتِ قالون عن نافع',
    ru: '4. Риваят Калун от Нафи',
    de: '4. Qalun nach Nafi'
  },
  riwaya_5: {
    ar: 'رواية البزي عن ابن كثير',
    en: "5. Al-Bazzi 'an Ibn Kathir",
    fr: '5. Al-Bazzi d’après Ibn Kathir',
    es: '5. Al-Bazzi de Ibn Kathir',
    tr: '5. İbn Kesîr’den Bezzî Rivayeti',
    id: "5. Riwayat Al-Bazzi 'an Ibnu Katsir",
    ur: '٥. روایتِ بزی عن ابن کثیر',
    ru: '5. Риваят аль-Баззи от Ибн Касира',
    de: '5. Al-Bazzi nach Ibn Kathir'
  },
  riwaya_6: {
    ar: 'رواية قنبل عن ابن كثير',
    en: "6. Qunbul 'an Ibn Kathir",
    fr: '6. Qounboul d’après Ibn Kathir',
    es: '6. Qunbul de Ibn Kathir',
    tr: '6. İbn Kesîr’den Kunbül Rivayeti',
    id: "6. Riwayat Qunbul 'an Ibnu Katsir",
    ur: '٦. روایتِ قنبل عن ابن کثیر',
    ru: '6. Риваят Кунбуль от Ибн Касира',
    de: '6. Qunbul nach Ibn Kathir'
  },
  riwaya_7: {
    ar: 'رواية الدوري عن أبي عمرو',
    en: "7. Ad-Duri 'an Abi 'Amr",
    fr: '7. Ad-Douri d’après Abou Amr',
    es: '7. Ad-Duri de Abu Amr',
    tr: '7. Ebû Amr’dan Dûrî Rivayeti',
    id: "7. Riwayat Ad-Duri 'an Abi 'Amr",
    ur: '٧. روایتِ دوری عن ابی عمرو',
    ru: '7. Риваят ад-Дури от Абу Амра',
    de: '7. Ad-Duri nach Abu Amr'
  },
  riwaya_8: {
    ar: 'رواية السوسي عن أبي عمرو',
    en: "8. As-Susi 'an Abi 'Amr",
    fr: '8. As-Sousi d’après Abou Amr',
    es: '8. As-Susi de Abu Amr',
    tr: '8. Ebû Amr’dan Sûsî Rivayeti',
    id: "8. Riwayat As-Susi 'an Abi 'Amr",
    ur: '٨. روایتِ سوسی عن ابی عمرو',
    ru: '8. Риваят ас-Суси от Абу Амра',
    de: '8. As-Susi nach Abu Amr'
  },
  riwaya_10: {
    ar: 'رواية ابن ذكوان عن ابن عامر',
    en: "9. Ibn Dhakwan 'an Ibn 'Amir",
    fr: '9. Ibn Dhakwan d’après Ibn Amir',
    es: '9. Ibn Dhakwan de Ibn Amir',
    tr: '9. İbn Âmir’den İbn Zekvân Rivayeti',
    id: "9. Riwayat Ibnu Dzakwan 'an Ibnu 'Amir",
    ur: '٩. روایتِ ابن ذکوان عن ابن عامر',
    ru: '9. Риваят Ибн Закван от Ибн Амира',
    de: '9. Ibn Dhakwan nach Ibn Amir'
  },
  riwaya_11: {
    ar: 'رواية خلف عن حمزة',
    en: "10. Khalaf 'an Hamzah",
    fr: '10. Khalaf d’après Hamzah',
    es: '10. Khalaf de Hamzah',
    tr: '10. Hamza’dan Halef Rivayeti',
    id: "10. Riwayat Khalaf 'an Hamzah",
    ur: '١٠. روایتِ خلف عن حمزہ',
    ru: '10. Риваят Халяф от Хамзы',
    de: '10. Chalaf nach Hamza'
  },
  riwaya_13: {
    ar: 'رواية أبي الحارث عن الكسائي',
    en: "11. Abu Al-Harith 'an Al-Kisa'i",
    fr: '11. Abou Al-Harith d’après Al-Kisaï',
    es: '11. Abu Al-Harith de Al-Kisa’i',
    tr: '11. Kisâî’den Ebü’l-Hâris Rivayeti',
    id: "11. Riwayat Abul Harits 'an Al-Kisa'i",
    ur: '١١. روایتِ ابو الحارث عن الکسائی',
    ru: '11. Риваят Абу аль-Харис от аль-Кисаи',
    de: '11. Abu al-Harith nach al-Kisai'
  },
  riwaya_14: {
    ar: 'رواية الدوري عن الكسائي',
    en: "12. Ad-Duri 'an Al-Kisa'i",
    fr: '12. Ad-Douri d’après Al-Kisaï',
    es: '12. Ad-Duri de Al-Kisa’i',
    tr: '12. Kisâî’den Dûrî Rivayeti',
    id: "12. Riwayat Ad-Duri 'an Al-Kisa'i",
    ur: '١٢. روایتِ دوری عن الکسائی',
    ru: '12. Риваят ад-Дури от аль-Кисаи',
    de: '12. Ad-Duri nach al-Kisai'
  },
  riwaya_16: {
    ar: 'رواية ابن جماز عن أبي جعفر',
    en: "13. Ibn Jammaz 'an Abi Ja'far",
    fr: '13. Ibn Jammaz d’après Abou Ja’far',
    es: '13. Ibn Yammaz de Abu Ya’far',
    tr: '13. Ebû Ca’fer’den İbn Cemmâz Rivayeti',
    id: "13. Riwayat Ibnu Jammaz 'an Abi Ja'far",
    ur: '١٣. روایتِ ابن جماز عن ابی جعفر',
    ru: '13. Риваят Ибн Джаммаз от Абу Джафара',
    de: '13. Ibn Dschammaz nach Abu Dschafar'
  },
  riwaya_17: {
    ar: 'رواية رويس عن يعقوب الحضرمي',
    en: "14. Ruways 'an Ya'qub Al-Hadrami",
    fr: '14. Rouways d’après Yaqoub Al-Hadrami',
    es: '14. Ruways de Yaqub Al-Hadrami',
    tr: '14. Yakub el-Hadramî’den Ruveys Rivayeti',
    id: "14. Riwayat Ruwais 'an Ya'qub Al-Hadhrami",
    ur: '١٤. روایتِ رویس عن یعقوب حضرمی',
    ru: '14. Риваят Рувайс от Якуба аль-Хадрами',
    de: '14. Ruways nach Yaqub al-Hadrami'
  },
  riwaya_18: {
    ar: 'رواية روح عن يعقوب الحضرمي',
    en: "15. Rawh 'an Ya'qub Al-Hadrami",
    fr: '15. Rawh d’après Yaqoub Al-Hadrami',
    es: '15. Rawh de Yaqub Al-Hadrami',
    tr: '15. Yakub el-Hadramî’den Ravh Rivayeti',
    id: "15. Riwayat Rauh 'an Ya'qub Al-Hadhrami",
    ur: '١٥. روایتِ روح عن یعقوب حضرمی',
    ru: '15. Риваят Раух от Якуба аль-Хадрами',
    de: '15. Rawh nach Yaqub al-Hadrami'
  },
  islamic: {
    ar: 'التفسير والحديث والأذكار والسيرة',
    en: 'Tafsir, Hadith, Adhkar & Seerah',
    fr: 'Tafsir, Hadith, Adhkar et Sîra',
    es: 'Tafsir, Hadiz, Adhkar y Sira',
    tr: 'Tefsir, Hadis, Zikir ve Siyer',
    id: 'Tafsir, Hadits, Dzikir & Sirah',
    ur: 'تفسیر، حدیث، اذکار و سیرت',
    ru: 'Тафсир, Хадисы, Азкары и Сира',
    de: 'Tafsir, Hadith, Adhkar & Sira'
  },
  eid: {
    ar: 'تكبيرات العيد',
    en: 'Eid Takbeerat',
    fr: "Takbirat de l'Aïd",
    es: 'Takbirat del Eid',
    tr: 'Bayram Tekbirleri',
    id: 'Takbiran Hari Raya',
    ur: 'تکبیراتِ عید',
    ru: 'Такбиры Ид',
    de: 'Eid-Takbirat'
  }
};

// ترجمة أسماء القراء والمحطات لجميع اللغات
const RECITER_LATIN = {
  'محمود خليل الحصري': 'Mahmoud Khalil Al-Hussary',
  'محمد صديق المنشاوي': 'Mohamed Siddiq El-Minshawi',
  'عبد الباسط عبد الصمد': 'Abdulbasit Abdulsamad',
  'محمود علي البنّا': 'Mahmoud Ali Al-Banna',
  'مصطفى إسماعيل': 'Mustafa Ismail',
  'محمد الطبلاوي': 'Mohamed Al-Tablawi',
  'أحمد عيسى المعصراوي': 'Ahmed Isa Al-Maasarawi',
  'أحمد نعينع': 'Ahmed Nuaina',
  'أحمد عامر': 'Ahmed Amer',
  'سيد رمضان': 'Sayed Ramadan',
  'علي حجاج السويسي': 'Ali Hajjaj Al-Souaisi',
  'محمد رشاد الشريف': 'Mohammad Rashad Al-Shareef',
  'صابر عبد الحكم': 'Saber Abdul-Hakam',
  'أحمد خليل شاهين': 'Ahmed Khalil Shaheen',
  'أحمد صابر': 'Ahmed Saber',
  'مصطفى اللاهوني': 'Mustafa Al-Lahouni',
  'أكرم العلاقمي': 'Akram Al-Alaqmi',
  'ماهر المعيقلي': 'Maher Al-Muaiqly',
  'بندر بليلة': 'Bandar Balilah',
  'علي الحذيفي': 'Ali Al-Hudhaifi',
  'عبد الرحمن السديس': 'Abdulrahman Al-Sudais',
  'سعود الشريم': 'Saud Al-Shuraim',
  'ياسر الدوسري': 'Yasser Al-Dosari',
  'عبد الله عواد الجهني': 'Abdullah Awad Al-Juhany',
  'صلاح البدير': 'Salah Al-Budair',
  'عبد المحسن القاسم': 'Abdulmohsen Al-Qasim',
  'عبد البارئ الثبيتي': 'Abdulbari Al-Thubaity',
  'أحمد طالب بن حميد': 'Ahmed Taleb Hameed',
  'بدر التركي': 'Badr Al-Turki',
  'علي جابر': 'Ali Jaber',
  'محمد أيوب': 'Mohammed Ayyub',
  'عبد الله خياط': 'Abdullah Khayyat',
  'مشاري راشد العفاسي': 'Mishary Rashid Alafasy',
  'أبو بكر الشاطري': 'Abu Bakr Al-Shatri',
  'سعد الغامدي': 'Saad Al-Ghamdi',
  'أحمد العجمي': 'Ahmed Al-Ajmi',
  'فارس عباد': 'Fares Abbad',
  'إدريس أبكر': 'Idris Abkar',
  'ناصر القطامي': 'Nasser Al-Qatami',
  'خالد الجليل': 'Khalid Al-Jalil',
  'محمد اللحيدان': 'Mohammed Al-Luhaidan',
  'محمد جبريل': 'Mohammed Jibreel',
  'هاني الرفاعي': 'Hani Ar-Rifai',
  'عادل الكلباني': 'Adel Al-Kalbani',
  'صلاح بو خاطر': 'Salah Bukhatir',
  'عبد الله بصفر': 'Abdullah Basfar',
  'عبد الله المطرود': 'Abdullah Al-Matrood',
  'خالد القحطاني': 'Khaled Al-Qahtani',
  'خليفة الطنيجي': 'Khalifa Al-Tunaiji',
  'حاتم فريد الواعر': 'Hatem Fareed Al-Waer',
  'الزين محمد أحمد': 'Al-Zain Mohammed Ahmed',
  'العيون الكوشي': 'Al-Oyoon Al-Koshi',
  'عمر القزابري': 'Omar Al-Qazabri',
  'القارئ ياسين': 'Al-Qari Yassen',
  'إبراهيم الدوسري': 'Ibrahim Al-Dosari',
  'محمد عبد الكريم': 'Mohammad Abdul-Kareem',
  'أحمد ديبان': 'Ahmad Deban',
  'عبد الرشيد صوفي': 'Abdulrasheed Soufi',
  'أحمد خضر الطرابلسي': 'Ahmad Khader Al-Tarabulsi',
  'الدوكالي محمد العالم': 'Addokali Mohammad Al-Alim',
  'طارق عبد الغني دعوب': 'Tareq Abdulgani Daawob',
  'وليد النائحي': 'Waleed Al-Naehi',
  'يوسف بن نوح أحمد': 'Yousef Bin Noah Ahmad',
  'محمد عبد الحكيم سعيد العبد الله': 'Mohammad Al-Abdullah',
  'الفاتح محمد الزبير': 'Al-Fateh Mohammad Al-Zubair',
  'مفتاح السلطني': 'Muftah Al-Saltany',
  'مجدي البلتاجي': 'Magdy Al-Beltagy',
  'محمود الشيمي': 'Mahmood Al-Sheimy',
  'ياسر المزروعي': 'Yasser Al-Mazroyee'
};

const RECITER_RU = {
  'محمود خليل الحصري': 'Махмуд Халиль аль-Хусари',
  'محمد صديق المنشاوي': 'Мухаммад Сиддик аль-Миншави',
  'عبد الباسط عبد الصمد': 'Абдуль-Басит Абдус-Самад',
  'محمود علي البنّا': 'Махмуд Али аль-Банна',
  'مصطفى إسماعيل': 'Мустафа Исмаиль',
  'محمد الطبلاوي': 'Мухаммад ат-Таблави',
  'أحمد عيسى المعصراوي': 'Ахмад Иса аль-Маасарави',
  'أحمد نعينع': 'Ахмад Нуайна',
  'أحمد عامر': 'Ахмад Амер',
  'سيد رمضان': 'Сайед Рамадан',
  'علي حجاج السويسي': 'Али Хаджадж ас-Сувайси',
  'محمد رشاد الشريف': 'Мухаммад Рашад аш-Шариф',
  'صابر عبد الحكم': 'Сабер Абдуль-Хакам',
  'أحمد خليل شاهين': 'Ахмад Халиль Шахин',
  'أحمد صابر': 'Ахмад Сабер',
  'مصطفى اللاهوني': 'Мустафа аль-Лахуни',
  'أكرم العلاقمي': 'Акрам аль-Алякми',
  'ماهر المعيقلي': 'Махер аль-Муайкли',
  'بندر بليلة': 'Бандар Балиля',
  'علي الحذيفي': 'Али аль-Хузайфи',
  'عبد الرحمن السديس': 'Абдуррахман ас-Судайс',
  'سعود الشريم': 'Сауд аш-Шурейм',
  'ياسر الدوسري': 'Ясир ад-Досари',
  'عبد الله عواد الجهني': 'Абдуллах аль-Джухани',
  'صلاح البدير': 'Салях аль-Будайр',
  'عبد المحسن القاسم': 'Абдуль-Мухсин аль-Касим',
  'عبد البارئ الثبيتي': 'Абдуль-Бари ас-Субайти',
  'أحمد طالب بن حميد': 'Ахмад Талиб Хамид',
  'بدر التركي': 'Бадр ат-Турки',
  'علي جابر': 'Али Джабер',
  'محمد أيوب': 'Мухаммад Айюб',
  'عبد الله خياط': 'Абдуллах Хайят',
  'مشاري راشد العفاسي': 'Мишари Рашид аль-Афаси',
  'أبو بكر الشاطري': 'Абу Бакр аш-Шатри',
  'سعد الغامدي': 'Саад аль-Гамиди',
  'أحمد العجمي': 'Ахмад аль-Аджми',
  'فارس عباد': 'Фарис Аббад',
  'إدريس أبكر': 'Идрис Абкар',
  'ناصر القطامي': 'Насир аль-Катами',
  'خالد الجليل': 'Халид аль-Джалиль',
  'محمد اللحيدان': 'Мухаммад аль-Люхайдан',
  'محمد جبريل': 'Мухаммад Джибриль',
  'هاني الرفاعي': 'Хани ар-Рифаи',
  'عادل الكلباني': 'Адиль аль-Кальбани',
  'صلاح بو خاطر': 'Салях Бухатир',
  'عبد الله بصفر': 'Абдуллах Басфар',
  'عبد الله المطرود': 'Абдуллах аль-Матруд',
  'خالد القحطاني': 'Халид аль-Кахтани',
  'خليفة الطنيجي': 'Халифа ат-Тунайджи',
  'حاتم فريد الواعر': 'Хатим Фарид аль-Ваир',
  'الزين محمد أحمد': 'Аз-Зейн Мухаммад Ахмад',
  'العيون الكوشي': 'Аль-Уюн аль-Куши',
  'عمر القزابري': 'Умар аль-Казабри',
  'القارئ ياسين': 'Аль-Кари Ясин',
  'إبراهيم الدوسري': 'Ибрахим ад-Досари',
  'محمد عبد الكريم': 'Мухаммад Абдуль-Карим',
  'أحمد ديبان': 'Ахмад Дибан',
  'عبد الرشيد صوفي': 'Абдуррашид Суфи',
  'أحمد خضر الطرابلسي': 'Ахмад Хадр ат-Тарабульси',
  'الدوكالي محمد العالم': 'Ад-Дукали Мухаммад аль-Алим',
  'طارق عبد الغني دعوب': 'Тарик Абдуль-Гани Дауб',
  'وليد النائحي': 'Валид ан-Наихи',
  'يوسف بن نوح أحمد': 'Юсуф ибн Нух Ахмад',
  'محمد عبد الحكيم سعيد العبد الله': 'Мухаммад аль-Абдуллах',
  'الفاتح محمد الزبير': 'Аль-Фатих Мухаммад аз-Зубайр',
  'مفتاح السلطني': 'Муфтах ас-Сальтани',
  'مجدي البلتاجي': 'Магди аль-Бельтаджи',
  'محمود الشيمي': 'Махмуд аш-Шими',
  'ياسر المزروعي': 'Ясир аль-Мазруи'
};

const TOPICAL_NAMES = {
  'تكبيرات العيد': {
    en: 'Eid Takbeerat',
    fr: "Takbirat de l'Aïd",
    es: 'Takbirat del Eid',
    tr: 'Bayram Tekbirleri',
    id: 'Takbiran Idul Fitri & Idul Adha',
    ur: 'تکبیراتِ عید',
    ru: 'Такбиры Ид (Праздничные такбиры)',
    de: 'Eid-Takbirat'
  },
  'إذاعة القرآن الكريم من القاهرة': {
    en: 'Holy Quran Radio - Cairo',
    fr: 'Radio du Saint Coran - Le Caire',
    es: 'Radio del Sagrado Corán - El Cairo',
    tr: "Kahire Kur'ân-ı Kerîm Radyosu",
    id: 'Radio Al-Quran Al-Karim - Kairo',
    ur: 'ریڈیو قرآن کریم - قاہرہ',
    ru: 'Радио Священного Корана - Каир',
    de: 'Edler Koran Radio - Kairo'
  },
  'إذاعة القرآن الكريم - السعودية': {
    en: 'Holy Quran Radio - Saudi Arabia',
    fr: 'Radio du Saint Coran - Arabie Saoudite',
    es: 'Radio del Sagrado Corán - Arabia Saudita',
    tr: "Suudi Arabistan Kur'ân Radyosu",
    id: 'Radio Al-Quran - Arab Saudi',
    ur: 'ریڈیو قرآن کریم - سعودی عرب',
    ru: 'Радио Священного Корана - Саудовская Аравия',
    de: 'Edler Koran Radio - Saudi-Arabien'
  },
  'إذاعة الحرم المكي': {
    en: 'Masjid Al-Haram Radio (Makkah)',
    fr: 'Radio de la Grande Mosquée de La Mecque',
    es: 'Radio de la Gran Mezquita de La Meca',
    tr: 'Mescid-i Haram Radyosu (Mekke)',
    id: 'Radio Masjidil Haram (Makkah)',
    ur: 'مسجد الحرام ریڈیو (مکہ مکرمہ)',
    ru: 'Радио Аль-Харам (Мекка)',
    de: 'Masjid al-Haram Radio (Mekka)'
  },
  'الإذاعة العامة - إذاعة متنوعة لمختلف القراء': {
    en: 'General Radio - Various Reciters',
    fr: 'Radio Générale - Divers Récitateurs',
    es: 'Radio General - Varios Recitadores',
    tr: 'Genel Radyo - Farklı Kâriler',
    id: 'Radio Umum - Berbagai Qari',
    ur: 'عمومی ریڈیو - مختلف قراء کی تلاوت',
    ru: 'Общее радио - Разные чтецы',
    de: 'Allgemeines Radio - Verschiedene Rezitatoren'
  },
  'تلاوات خاشعة': {
    en: 'Humble & Heart-Touching Recitations',
    fr: 'Récitations Humbles et Apaisantes',
    es: 'Recitaciones Humildes y Conmovedoras',
    tr: 'Huşû Veren Tilâvetler',
    id: 'Tilawah Khusyuk & Menyentuh Hati',
    ur: 'خاشعانہ تلاوتیں',
    ru: 'Проникновенное чтение Корана',
    de: 'Demütige & Herzberührende Rezitationen'
  },
  'إذاعة آيات السكينة': {
    en: 'Verses of Tranquility Radio',
    fr: 'Radio Versets de la Sérénité',
    es: 'Radio Versículos de Serenidad',
    tr: 'Sekînet Âyetleri Radyosu',
    id: 'Radio Ayat-Ayat Ketenangan',
    ur: 'آیاتِ سکینت ریڈیو',
    ru: 'Аяты спокойствия и умиротворения',
    de: 'Verse der Ruhe & Gelassenheit'
  },
  'تراتيل قصيرة متميزة': {
    en: 'Featured Short Recitations',
    fr: 'Courtes Récitations Choisies',
    es: 'Recitaciones Cortas Destacadas',
    tr: 'Seçkin Kısa Tilâvetler',
    id: 'Tilawah Pendek Pilihan',
    ur: 'منتخب مختصر تلاوتیں',
    ru: 'Избранные короткие суры',
    de: 'Ausgewählte kurze Rezitationen'
  },
  'سورة البقرة - لعدد من القراء': {
    en: 'Surah Al-Baqarah - Various Reciters',
    fr: 'Sourate Al-Baqarah - Divers Récitateurs',
    es: 'Sura Al-Baqarah - Varios Recitadores',
    tr: 'Bakara Sûresi - Farklı Kâriler',
    id: 'Surah Al-Baqarah - Berbagai Qari',
    ur: 'سورۃ البقرہ - مختلف قراء',
    ru: 'Сура Аль-Бакара - Разные чтецы',
    de: 'Sure Al-Baqarah - Verschiedene Rezitatoren'
  },
  'الرقية الشرعية': {
    en: 'Ruqyah Shariah (Islamic Healing)',
    fr: 'Roqya Charia (Guérison Spirituelle)',
    es: 'Ruqyah Shariah (Sanación Espiritual)',
    tr: 'Rukye-i Şeriyye',
    id: 'Ruqyah Syariyyah',
    ur: 'رقیہ شرعیہ (مسنون دم)',
    ru: 'Рукья Шария (Исламское исцеление)',
    de: 'Ruqyah Scharia'
  },
  'أذكار الصباح': {
    en: 'Morning Adhkar (Remembrances)',
    fr: 'Invocations du Matin (Adhkar)',
    es: 'Adhkar de la Mañana',
    tr: 'Sabah Zikirleri (Ezkâr)',
    id: 'Dzikir Pagi',
    ur: 'صبح کے اذکار',
    ru: 'Утренние азкары',
    de: 'Morgen-Adhkar (Bittgebete)'
  },
  'أذكار المساء': {
    en: 'Evening Adhkar (Remembrances)',
    fr: 'Invocations du Soir (Adhkar)',
    es: 'Adhkar de la Tarde',
    tr: 'Akşam Zikirleri (Ezkâr)',
    id: 'Dzikir Petang',
    ur: 'شام کے اذکار',
    ru: 'Вечерние азкары',
    de: 'Abend-Adhkar (Bittgebete)'
  },
  'قصص الأنبياء': {
    en: 'Stories of the Prophets',
    fr: 'Histoires des Prophètes',
    es: 'Historias de los Profetas',
    tr: 'Peygamber Kıssaları',
    id: 'Kisah Para Nabi',
    ur: 'قصص الانبیاء',
    ru: 'Истории пророков',
    de: 'Geschichten der Propheten'
  },
  'صحيح البخاري': {
    en: 'Sahih Al-Bukhari',
    fr: 'Sahih Al-Boukhari',
    es: 'Sahih Al-Bujari',
    tr: 'Sahîh-i Buhârî',
    id: 'Shahih Al-Bukhari',
    ur: 'صحیح بخاری',
    ru: 'Сахих аль-Бухари',
    de: 'Sahih al-Buchari'
  },
  'صحيح مسلم': {
    en: 'Sahih Muslim',
    fr: 'Sahih Mouslim',
    es: 'Sahih Muslim',
    tr: 'Sahîh-i Müslim',
    id: 'Shahih Muslim',
    ur: 'صحیح مسلم',
    ru: 'Сахих Муслим',
    de: 'Sahih Muslim'
  },
  'رياض الصالحين': {
    en: 'Riyad as-Salihin',
    fr: 'Riyad as-Salihin (Les Jardins des Vertueux)',
    es: 'Riyad as-Salihin (El Jardín de los Justos)',
    tr: 'Riyâzü’s-Sâlihîn',
    id: 'Riyadhus Shalihin',
    ur: 'ریاض الصالحین',
    ru: 'Рияд ас-Салихин (Сады праведных)',
    de: 'Riyad as-Salihin (Die Gärten der Tugendhaften)'
  },
  'المختصر في السيرة النبوية': {
    en: 'Concise Prophetic Biography (Seerah)',
    fr: 'Biographie Abrégée du Prophète (Sîra)',
    es: 'Biografía Resumida del Profeta (Sira)',
    tr: 'Muhtasar Peygamberimiz’in Hayatı (Siyer)',
    id: 'Ringkasan Sirah Nabawiyah',
    ur: 'مختصر سیرت النبی ﷺ',
    ru: 'Краткое жизнеописание Пророка (Сира)',
    de: 'Kurzbiografie des Propheten (Sira)'
  },
  'في ظلال السيرة النبوية': {
    en: 'In the Shade of the Prophetic Biography',
    fr: 'À l’Ombre de la Sîra du Prophète',
    es: 'A la Sombra de la Sira del Profeta',
    tr: 'Siyer-i Nebî Gölgesinde',
    id: 'Di Bawah Naungan Sirah Nabawiyah',
    ur: 'سیرت النبی ﷺ کے سائے میں',
    ru: 'В сени жизнеописания Пророка',
    de: 'Im Schatten der Prophetenbiografie'
  },
  'المختصر في تفسير القرآن الكريم': {
    en: 'Concise Tafsir of the Holy Quran',
    fr: 'Tafsir Abrégé du Saint Coran',
    es: 'Tafsir Resumido del Sagrado Corán',
    tr: "Kur'ân-ı Kerîm Muhtasar Tefsiri",
    id: 'Tafsir Ringkas Al-Quran Al-Karim',
    ur: 'مختصر تفسیر قرآن کریم',
    ru: 'Краткий тафсир Священного Корана',
    de: 'Kurzkommentar (Tafsir) des Korans'
  },
  'تفسير القرآن الكريم للإمام الطبري': {
    en: 'Tafsir Al-Tabari (Quran Exegesis)',
    fr: "Tafsir de l'Imam At-Tabari",
    es: 'Tafsir del Imán Al-Tabari',
    tr: 'İmam Taberî Tefsiri',
    id: 'Tafsir Al-Quran Imam Ath-Thabari',
    ur: 'تفسیر طبری (امام طبری)',
    ru: 'Тафсир имама ат-Табари',
    de: 'Tafsir von Imam at-Tabari'
  }
};

const SUBTITLE_TRANSLATIONS = {
  'بث مباشر': {
    en: 'Live Stream',
    fr: 'En direct',
    es: 'Transmisión en vivo',
    tr: 'Canlı Yayın',
    id: 'Siaran Langsung',
    ur: 'براہِ راست نشریات',
    ru: 'Прямой эфир',
    de: 'Live-Stream'
  },
  'رواية حفص عن عاصم - مجود': {
    en: "Hafs 'an 'Asim - Mujawwad (Melodic)",
    fr: 'Hafs d’après Asim - Moujawwad',
    es: 'Hafs de Asim - Muyawad',
    tr: 'Âsım’dan Hafs - Mücevved',
    id: "Riwayat Hafs 'an 'Ashim - Mujawwad",
    ur: 'روایتِ حفص عن عاصم - مجود',
    ru: 'Риваят Хафс от Асима - Муджаввад',
    de: 'Hafs nach Asim - Mujawwad'
  },
  'رواية حفص عن عاصم - مرتل': {
    en: "Hafs 'an 'Asim - Murattal",
    fr: 'Hafs d’après Asim - Mourattal',
    es: 'Hafs de Asim - Murattal',
    tr: 'Âsım’dan Hafs - Mürettel',
    id: "Riwayat Hafs 'an 'Ashim - Murattal",
    ur: 'روایتِ حفص عن عاصم - مرتل',
    ru: 'Риваят Хафс от Асима - Муратталь',
    de: 'Hafs nach Asim - Murattal'
  },
  'رواية حفص عن عاصم': {
    en: "Hafs 'an 'Asim Narration",
    fr: 'Narration Hafs d’après Asim',
    es: 'Narración Hafs de Asim',
    tr: 'Âsım’dan Hafs Rivayeti',
    id: "Riwayat Hafs 'an 'Ashim",
    ur: 'روایتِ حفص عن عاصم',
    ru: 'Риваят Хафс от Асима',
    de: 'Hafs-Überlieferung nach Asim'
  },
  'رواية شعبة عن عاصم': {
    en: "Shu'bah 'an 'Asim Narration",
    fr: 'Narration Chou’bah d’après Asim',
    es: 'Narración Shu’bah de Asim',
    tr: 'Âsım’dan Şu’be Rivayeti',
    id: "Riwayat Syu'bah 'an 'Ashim",
    ur: 'روایتِ شعبہ عن عاصم',
    ru: 'Риваят Шуаба от Асима',
    de: 'Schuba-Überlieferung nach Asim'
  },
  'رواية ورش عن نافع': {
    en: "Warsh 'an Nafi' Narration",
    fr: 'Narration Warch d’après Nafi',
    es: 'Narración Warsh de Nafi',
    tr: 'Nâfi’den Verş Rivayeti',
    id: "Riwayat Warsy 'an Nafi'",
    ur: 'روایتِ ورش عن نافع',
    ru: 'Риваят Варш от Нафи',
    de: 'Warsch-Überlieferung nach Nafi'
  },
  'رواية ورش عن نافع من طريق الأصبهاني': {
    en: "Warsh 'an Nafi' (via Al-Asbahani)",
    fr: 'Warch d’après Nafi (voie Al-Asbahani)',
    es: 'Warsh de Nafi (vía Al-Asbahani)',
    tr: 'Nâfi’den Verş (İsbahânî Tariki)',
    id: "Riwayat Warsy 'an Nafi' (Jalur Al-Ashbahani)",
    ur: 'روایتِ ورش عن نافع (طریق اصبہانی)',
    ru: 'Риваят Варш от Нафи (путь аль-Асбахани)',
    de: 'Warsch nach Nafi (über al-Asbahani)'
  },
  'رواية قالون عن نافع': {
    en: "Qalun 'an Nafi' Narration",
    fr: 'Narration Qaloun d’après Nafi',
    es: 'Narración Qalun de Nafi',
    tr: 'Nâfi’den Kâlûn Rivayeti',
    id: "Riwayat Qalun 'an Nafi'",
    ur: 'روایتِ قالون عن نافع',
    ru: 'Риваят Калун от Нафи',
    de: 'Qalun-Überlieferung nach Nafi'
  },
  'رواية قالون عن نافع من طريق أبي نشيط': {
    en: "Qalun 'an Nafi' (via Abi Nashit)",
    fr: 'Qaloun d’après Nafi (voie Abi Nachit)',
    es: 'Qalun de Nafi (vía Abi Nashit)',
    tr: 'Nâfi’den Kâlûn (Ebû Neşît Tariki)',
    id: "Riwayat Qalun 'an Nafi' (Jalur Abi Nasyith)",
    ur: 'روایتِ قالون عن نافع (طریق ابی نشیط)',
    ru: 'Риваят Калун от Нафи (путь Абу Нашита)',
    de: 'Qalun nach Nafi (über Abi Naschit)'
  },
  'رواية البزي عن ابن كثير': {
    en: "Al-Bazzi 'an Ibn Kathir Narration",
    fr: 'Narration Al-Bazzi d’après Ibn Kathir',
    es: 'Narración Al-Bazzi de Ibn Kathir',
    tr: 'İbn Kesîr’den Bezzî Rivayeti',
    id: "Riwayat Al-Bazzi 'an Ibnu Katsir",
    ur: 'روایتِ بزی عن ابن کثیر',
    ru: 'Риваят аль-Баззи от Ибн Касира',
    de: 'Al-Bazzi-Überlieferung nach Ibn Kathir'
  },
  'رواية البزي وقنبل عن ابن كثير': {
    en: "Al-Bazzi & Qunbul 'an Ibn Kathir",
    fr: 'Al-Bazzi et Qounboul d’après Ibn Kathir',
    es: 'Al-Bazzi y Qunbul de Ibn Kathir',
    tr: 'İbn Kesîr’den Bezzî ve Kunbül Rivayeti',
    id: "Riwayat Al-Bazzi & Qunbul 'an Ibnu Katsir",
    ur: 'روایتِ بزی و قنبل عن ابن کثیر',
    ru: 'Риваяты аль-Баззи и Кунбуля от Ибн Касира',
    de: 'Al-Bazzi & Qunbul nach Ibn Kathir'
  },
  'رواية قنبل عن ابن كثير': {
    en: "Qunbul 'an Ibn Kathir Narration",
    fr: 'Narration Qounboul d’après Ibn Kathir',
    es: 'Narración Qunbul de Ibn Kathir',
    tr: 'İbn Kesîr’den Kunbül Rivayeti',
    id: "Riwayat Qunbul 'an Ibnu Katsir",
    ur: 'روایتِ قنبل عن ابن کثیر',
    ru: 'Риваят Кунбуль от Ибн Касира',
    de: 'Qunbul-Überlieferung nach Ibn Kathir'
  },
  'رواية الدوري عن أبي عمرو': {
    en: "Ad-Duri 'an Abi 'Amr Narration",
    fr: 'Narration Ad-Douri d’après Abou Amr',
    es: 'Narración Ad-Duri de Abu Amr',
    tr: 'Ebû Amr’dan Dûrî Rivayeti',
    id: "Riwayat Ad-Duri 'an Abi 'Amr",
    ur: 'روایتِ دوری عن ابی عمرو',
    ru: 'Риваят ад-Дури от Абу Амра',
    de: 'Ad-Duri-Überlieferung nach Abu Amr'
  },
  'رواية السوسي عن أبي عمرو': {
    en: "As-Susi 'an Abi 'Amr Narration",
    fr: 'Narration As-Sousi d’après Abou Amr',
    es: 'Narración As-Susi de Abu Amr',
    tr: 'Ebû Amr’dan Sûsî Rivayeti',
    id: "Riwayat As-Susi 'an Abi 'Amr",
    ur: 'روایتِ سوسی عن ابی عمرو',
    ru: 'Риваят ас-Суси от Абу Амра',
    de: 'As-Susi-Überlieferung nach Abu Amr'
  },
  'رواية هشام عن ابن عامر (بث قراءة ابن عامر)': {
    en: "Hisham 'an Ibn 'Amir (Ibn 'Amir Stream)",
    fr: 'Hicham d’après Ibn Amir (Flux Ibn Amir)',
    es: 'Hisham de Ibn Amir (Emisión Ibn Amir)',
    tr: 'İbn Âmir’den Hişâm Rivayeti',
    id: "Riwayat Hisyam 'an Ibnu 'Amir",
    ur: 'روایتِ ہشام عن ابن عامر',
    ru: 'Риваят Хишам от Ибн Амира',
    de: 'Hischam nach Ibn Amir'
  },
  'رواية ابن ذكوان عن ابن عامر': {
    en: "Ibn Dhakwan 'an Ibn 'Amir Narration",
    fr: 'Narration Ibn Dhakwan d’après Ibn Amir',
    es: 'Narración Ibn Dhakwan de Ibn Amir',
    tr: 'İbn Âmir’den İbn Zekvân Rivayeti',
    id: "Riwayat Ibnu Dzakwan 'an Ibnu 'Amir",
    ur: 'روایتِ ابن ذکوان عن ابن عامر',
    ru: 'Риваят Ибн Закван от Ибн Амира',
    de: 'Ibn-Dhakwan-Überlieferung nach Ibn Amir'
  },
  'رواية خلف عن حمزة': {
    en: "Khalaf 'an Hamzah Narration",
    fr: 'Narration Khalaf d’après Hamzah',
    es: 'Narración Khalaf de Hamzah',
    tr: 'Hamza’dan Halef Rivayeti',
    id: "Riwayat Khalaf 'an Hamzah",
    ur: 'روایتِ خلف عن حمزہ',
    ru: 'Риваят Халяф от Хамзы',
    de: 'Chalaf-Überlieferung nach Hamza'
  },
  'رواية خلاد عن حمزة (بث قراءة حمزة)': {
    en: "Khallad 'an Hamzah (Hamzah Stream)",
    fr: 'Khallad d’après Hamzah (Flux Hamzah)',
    es: 'Khallad de Hamzah (Emisión Hamzah)',
    tr: 'Hamza’dan Hallâd Rivayeti',
    id: "Riwayat Khallad 'an Hamzah",
    ur: 'روایتِ خلاد عن حمزہ',
    ru: 'Риваят Халляд от Хамзы',
    de: 'Challad nach Hamza'
  },
  'رواية أبي الحارث عن الكسائي': {
    en: "Abu Al-Harith 'an Al-Kisa'i Narration",
    fr: 'Narration Abou Al-Harith d’après Al-Kisaï',
    es: 'Narración Abu Al-Harith de Al-Kisa’i',
    tr: 'Kisâî’den Ebü’l-Hâris Rivayeti',
    id: "Riwayat Abul Harits 'an Al-Kisa'i",
    ur: 'روایتِ ابو الحارث عن الکسائی',
    ru: 'Риваят Абу аль-Харис от аль-Кисаи',
    de: 'Abu-al-Harith-Überlieferung nach al-Kisai'
  },
  'رواية الدوري عن الكسائي': {
    en: "Ad-Duri 'an Al-Kisa'i Narration",
    fr: 'Narration Ad-Douri d’après Al-Kisaï',
    es: 'Narración Ad-Duri de Al-Kisa’i',
    tr: 'Kisâî’den Dûrî Rivayeti',
    id: "Riwayat Ad-Duri 'an Al-Kisa'i",
    ur: 'روایتِ دوری عن الکسائی',
    ru: 'Риваят ад-Дури от аль-Кисаи',
    de: 'Ad-Duri-Überlieferung nach al-Kisai'
  },
  'رواية ابن وردان عن أبي جعفر (بث القراءات)': {
    en: "Ibn Wardan 'an Abi Ja'far (Qira'at Stream)",
    fr: 'Ibn Wardan d’après Abou Ja’far',
    es: 'Ibn Wardan de Abu Ya’far',
    tr: 'Ebû Ca’fer’den İbn Verdân Rivayeti',
    id: "Riwayat Ibnu Wardan 'an Abi Ja'far",
    ur: 'روایتِ ابن وردان عن ابی جعفر',
    ru: 'Риваят Ибн Вардан от Абу Джафара',
    de: 'Ibn Wardan nach Abu Dschafar'
  },
  'رواية ابن جماز عن أبي جعفر': {
    en: "Ibn Jammaz 'an Abi Ja'far Narration",
    fr: 'Narration Ibn Jammaz d’après Abou Ja’far',
    es: 'Narración Ibn Yammaz de Abu Ya’far',
    tr: 'Ebû Ca’fer’den İbn Cemmâz Rivayeti',
    id: "Riwayat Ibnu Jammaz 'an Abi Ja'far",
    ur: 'روایتِ ابن جماز عن ابی جعفر',
    ru: 'Риваят Ибн Джаммаз от Абу Джафара',
    de: 'Ibn-Dschammaz-Überlieferung nach Abu Dschafar'
  },
  'رواية رويس عن يعقوب الحضرمي': {
    en: "Ruways 'an Ya'qub Al-Hadrami Narration",
    fr: 'Narration Rouways d’après Yaqoub Al-Hadrami',
    es: 'Narración Ruways de Yaqub Al-Hadrami',
    tr: 'Yakub el-Hadramî’den Ruveys Rivayeti',
    id: "Riwayat Ruwais 'an Ya'qub Al-Hadhrami",
    ur: 'روایتِ رویس عن یعقوب حضرمی',
    ru: 'Риваят Рувайс от Якуба аль-Хадрами',
    de: 'Ruways-Überlieferung nach Yaqub al-Hadrami'
  },
  'رواية روح عن يعقوب الحضرمي': {
    en: "Rawh 'an Ya'qub Al-Hadrami Narration",
    fr: 'Narration Rawh d’après Yaqoub Al-Hadrami',
    es: 'Narración Rawh de Yaqub Al-Hadrami',
    tr: 'Yakub el-Hadramî’den Ravh Rivayeti',
    id: "Riwayat Rauh 'an Ya'qub Al-Hadhrami",
    ur: 'روایتِ روح عن یعقوب حضرمی',
    ru: 'Риваят Раух от Якуба аль-Хадрами',
    de: 'Rawh-Überlieferung nach Yaqub al-Hadrami'
  },
  'قراءة يعقوب الحضرمي بروايتي رويس وروح': {
    en: "Ya'qub Al-Hadrami (Ruways & Rawh)",
    fr: 'Yaqoub Al-Hadrami (Rouways et Rawh)',
    es: 'Yaqub Al-Hadrami (Ruways y Rawh)',
    tr: 'Yakub el-Hadramî (Ruveys ve Ravh)',
    id: "Qiraat Ya'qub Al-Hadhrami (Ruwais & Rauh)",
    ur: 'قراءتِ یعقوب حضرمی (رویس و روح)',
    ru: 'Кыраат Якуба аль-Хадрами (Рувайс и Раух)',
    de: 'Yaqub al-Hadrami (Ruways & Rawh)'
  },
  'رواية إسحاق الوراق عن خلف العاشر (بث القراءات)': {
    en: "Ishaq 'an Khalaf Al-'Ashir (Qira'at Stream)",
    fr: 'Ishaq d’après Khalaf Al-Achir',
    es: 'Ishaq de Khalaf Al-Ashir',
    tr: 'Halef el-Âşir’den İshak Rivayeti',
    id: "Riwayat Ishaq 'an Khalaf Al-'Asyir",
    ur: 'روایتِ اسحاق الوراق عن خلف العاشر',
    ru: 'Риваят Исхак от Халяфа аль-Ашира',
    de: 'Ishaq nach Chalaf al-Aschir'
  },
  'رواية إدريس الحداد عن خلف العاشر (بث القراءات)': {
    en: "Idris 'an Khalaf Al-'Ashir (Qira'at Stream)",
    fr: 'Idris d’après Khalaf Al-Achir',
    es: 'Idris de Khalaf Al-Ashir',
    tr: 'Halef el-Âşir’den İdrîs Rivayeti',
    id: "Riwayat Idris 'an Khalaf Al-'Asyir",
    ur: 'روایتِ ادریس الحداد عن خلف العاشر',
    ru: 'Риваят Идрис от Халяфа аль-Ашира',
    de: 'Idris nach Chalaf al-Aschir'
  },
  'إذاعة مباشرة': {
    en: 'Live Radio Broadcast',
    fr: 'Radio en direct',
    es: 'Radio en vivo',
    tr: 'Canlı Radyo Yayını',
    id: 'Radio Siaran Langsung',
    ur: 'براہِ راست ریڈیو',
    ru: 'Прямая радиотрансляция',
    de: 'Live-Radiosender'
  },
  'إذاعة متنوعة': {
    en: 'Variety Quran Radio',
    fr: 'Radio Coranique Variée',
    es: 'Radio Coránica Variada',
    tr: 'Karma Kur’ân Radyosu',
    id: 'Radio Al-Quran Beragam',
    ur: 'متنوع قرآنی ریڈیو',
    ru: 'Разнообразное радио Корана',
    de: 'Vielseitiges Koran-Radio'
  },
  'روايات متنوعة': {
    en: 'Various Narrations',
    fr: 'Diverses Narrations',
    es: 'Varias Narraciones',
    tr: 'Çeşitli Rivayetler',
    id: 'Berbagai Riwayat',
    ur: 'متنوع روایات',
    ru: 'Различные риваяты',
    de: 'Verschiedene Überlieferungen'
  },
  'تلاوات هادئة': {
    en: 'Calm & Soothing Recitations',
    fr: 'Récitations Calmes et Apaisantes',
    es: 'Recitaciones Tranquilas',
    tr: 'Huzur Veren Sakin Tilâvetler',
    id: 'Tilawah Tenang & Menyejukkan',
    ur: 'پرسکون تلاوتیں',
    ru: 'Спокойное чтение',
    de: 'Ruhige Rezitationen'
  },
  'تلاوات مختارة': {
    en: 'Selected Recitations',
    fr: 'Récitations Sélectionnées',
    es: 'Recitaciones Seleccionadas',
    tr: 'Seçme Tilâvetler',
    id: 'Tilawah Pilihan',
    ur: 'منتخب تلاوتیں',
    ru: 'Избранные чтения',
    de: 'Ausgewählte Rezitationen'
  },
  'قراءة مميزة - رواية حفص': {
    en: 'Special Recitation - Hafs Narration',
    fr: 'Récitation Spéciale - Narration Hafs',
    es: 'Recitación Especial - Narración Hafs',
    tr: 'Özel Tilâvet - Hafs Rivayeti',
    id: 'Tilawah Istimewa - Riwayat Hafs',
    ur: 'خصوصی تلاوت - روایتِ حفص',
    ru: 'Особое чтение - Риваят Хафс',
    de: 'Besondere Rezitation - Hafs'
  },
  'رقية شرعية': {
    en: 'Islamic Spiritual Healing',
    fr: 'Protection & Guérison Spirituelle',
    es: 'Sanación Espiritual Islámica',
    tr: 'Şifâ Âyetleri ve Dualar',
    id: 'Terapi Ruqyah Syariyyah',
    ur: 'شرعی دم اور شفا',
    ru: 'Исламское духовное исцеление',
    de: 'Bittgebete zum Schutz & Heilung'
  },
  'أذكار': {
    en: 'Daily Remembrances (Adhkar)',
    fr: 'Invocations Quotidiennes (Adhkar)',
    es: 'Recuerdos y Súplicas (Adhkar)',
    tr: 'Günlük Zikir ve Dualar',
    id: 'Dzikir Harian',
    ur: 'مسنون اذکار و دعائیں',
    ru: 'Ежедневные поминания (Азкары)',
    de: 'Tägliche Gedenkworte (Adhkar)'
  },
  'قصص': {
    en: 'Islamic Stories',
    fr: 'Récits Islamiques',
    es: 'Relatos Islámicos',
    tr: 'İslâmî Kıssalar',
    id: 'Kisah Islami',
    ur: 'اسلامی واقعات و قصص',
    ru: 'Исламские истории',
    de: 'Islamische Geschichten'
  },
  'حديث': {
    en: 'Prophetic Hadith',
    fr: 'Hadith Prophétique',
    es: 'Hadiz Profético',
    tr: 'Hadîs-i Şerîf',
    id: 'Hadits Nabi',
    ur: 'حدیثِ نبوی ﷺ',
    ru: 'Хадисы Пророка',
    de: 'Prophetische Hadithe'
  },
  'السيرة': {
    en: 'Prophetic Biography (Seerah)',
    fr: 'Biographie Prophétique (Sîra)',
    es: 'Biografía Profética (Sira)',
    tr: 'Siyer-i Nebî',
    id: 'Sirah Nabawiyah',
    ur: 'سیرتِ طیبہ ﷺ',
    ru: 'Жизнеописание Пророка (Сира)',
    de: 'Prophetenbiografie (Sira)'
  },
  'تفسير': {
    en: 'Quran Exegesis (Tafsir)',
    fr: 'Exégèse du Coran (Tafsir)',
    es: 'Exégesis del Corán (Tafsir)',
    tr: 'Kur’ân Tefsiri',
    id: 'Tafsir Al-Quran',
    ur: 'تفسیرِ قرآن',
    ru: 'Толкование Корана (Тафсир)',
    de: 'Koran-Exegese (Tafsir)'
  }
};

const expandedSections = new Set(); // all sections start collapsed
let currentLang = 'ar';
let currentCategory = 'all';
let isPlaying = false;
let isLoading = false;
let hasConnectionError = false;
let currentStationIndex = 0;
let currentVolume = 1.0;
let activePlayRequestId = 0;

const playBtn = document.getElementById('playBtn');
const playIcon = document.getElementById('playIcon');
const stationList = document.getElementById('stationList');
const categoryTabs = document.getElementById('categoryTabs');
const volumeSlider = document.getElementById('volumeSlider');
const volumeIcon = document.getElementById('volumeIcon');
const nowPlayingName = document.getElementById('nowPlayingName');
const nowPlayingSubtitle = document.getElementById('nowPlayingSubtitle');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const loadingRing = document.getElementById('loadingRing');
const searchInput = document.getElementById('searchInput');
const themeToggle = document.getElementById('themeToggle');
const langBtn = document.getElementById('langBtn');
const langCode = document.getElementById('langCode');
const langMenu = document.getElementById('langMenu');
const headerTitle = document.getElementById('headerTitle');
const headerSubtitle = document.getElementById('headerSubtitle');
const footerQuote = document.getElementById('footerQuote');

function getUI(key) {
  const dict = UI_STRINGS[currentLang] || UI_STRINGS.ar;
  return dict[key] || UI_STRINGS.ar[key] || '';
}

function translateSectionTitle(sectionId, lang = currentLang) {
  const entry = SECTION_TRANSLATIONS[sectionId];
  if (!entry) return sectionId;
  return entry[lang] || entry.ar || sectionId;
}

function translateStationName(arabicName, lang = currentLang) {
  if (lang === 'ar') return arabicName;
  if (TOPICAL_NAMES[arabicName] && TOPICAL_NAMES[arabicName][lang]) {
    return TOPICAL_NAMES[arabicName][lang];
  }
  if (lang === 'ur') {
    return arabicName;
  }
  if (lang === 'ru' && RECITER_RU[arabicName]) {
    return RECITER_RU[arabicName];
  }
  return RECITER_LATIN[arabicName] || arabicName;
}

function translateStationSubtitle(arabicSub, lang = currentLang) {
  if (lang === 'ar') return arabicSub;
  if (SUBTITLE_TRANSLATIONS[arabicSub] && SUBTITLE_TRANSLATIONS[arabicSub][lang]) {
    return SUBTITLE_TRANSLATIONS[arabicSub][lang];
  }
  return arabicSub;
}

function buildLangMenu() {
  langMenu.innerHTML = '';
  LANGUAGES.forEach((lang) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lang-option' + (lang.code === currentLang ? ' active' : '');
    btn.innerHTML = `
      <span>${lang.label}</span>
      <span class="lang-option-code">${lang.code.toUpperCase()}</span>
    `;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await applyLanguage(lang.code, true);
      closeLangMenu();
    });
    langMenu.appendChild(btn);
  });
}

function closeLangMenu() {
  langMenu.hidden = true;
  langBtn.classList.remove('open');
}

langBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = langMenu.hidden;
  langMenu.hidden = !willOpen;
  langBtn.classList.toggle('open', willOpen);
});

document.addEventListener('click', () => {
  if (!langMenu.hidden) {
    closeLangMenu();
  }
});

async function applyLanguage(lang, save = false) {
  const found = LANGUAGES.find((l) => l.code === lang) || LANGUAGES[0];
  currentLang = found.code;

  document.documentElement.setAttribute('lang', found.code);
  document.documentElement.setAttribute('dir', found.dir);
  langCode.textContent = found.code.toUpperCase();

  headerTitle.textContent = getUI('headerTitle');
  headerSubtitle.textContent = getUI('headerSubtitle');
  footerQuote.textContent = getUI('footerQuote');
  searchInput.placeholder = getUI('searchPlaceholder');
  themeToggle.title = getUI('themeTitle');
  langBtn.title = getUI('langTitle');
  playBtn.title = getUI('playTitle');
  volumeIcon.title = getUI('muteTitle');
  volumeSlider.title = getUI('volumeTitle');

  buildLangMenu();
  buildCategoryTabs();
  buildStationList();
  updateStationUI();
  refreshStatusLabel();
  filterStations(searchInput.value);

  if (save) {
    store.set({ lang: currentLang });
  }
}

async function loadLanguage() {
  const data = store.get('lang');
  const savedLang = data.lang || 'ar';
  await applyLanguage(savedLang, false);
}

function buildCategoryTabs() {
  if (!categoryTabs) return;
  categoryTabs.innerHTML = '';

  SECTIONS.forEach((sec) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'category-chip' + (sec.id === currentCategory ? ' active' : '');
    btn.dataset.section = sec.id;
    btn.textContent = translateSectionTitle(sec.id);
    btn.addEventListener('click', () => {
      currentCategory = sec.id;
      if (currentCategory !== 'all') expandedSections.add(currentCategory);
      document.querySelectorAll('.category-chip').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.section === currentCategory);
      });
      filterStations(searchInput.value);
      stationList.scrollTop = 0;
    });
    categoryTabs.appendChild(btn);
  });
}

function buildStationList() {
  stationList.innerHTML = '';

  const sectionCounts = {};
  stations.forEach((s) => {
    sectionCounts[s.section] = (sectionCounts[s.section] || 0) + 1;
  });

  let lastSection = null;

  stations.forEach((station, index) => {
    if (station.section !== lastSection) {
      lastSection = station.section;
      const secMeta = SECTIONS.find((s) => s.id === station.section);
      const header = document.createElement('div');
      header.className = 'section-tab-header';
      header.dataset.section = station.section;

      const badgeText =
        currentLang === 'ar' && secMeta ? secMeta.badge : '';
      const sectionTitle = translateSectionTitle(station.section);
      const count = sectionCounts[station.section] || 0;

      header.innerHTML = `
        <div class="section-tab-title-wrap">
          ${badgeText ? `<span class="section-tab-pill">${badgeText}</span>` : ''}
          <span class="section-tab-title">${sectionTitle}</span>
        </div>
        <div class="section-tab-end">
          <span class="section-tab-count">${count}</span>
          <span class="section-chevron">▾</span>
        </div>
      `;
      header.addEventListener('click', () => toggleSection(station.section));
      stationList.appendChild(header);
    }

    const item = document.createElement('div');
    item.className = 'station-item' + (index === currentStationIndex ? ' active' : '');
    item.dataset.index = index;
    item.dataset.section = station.section;
    const displayName = translateStationName(station.name);
    const displaySub = translateStationSubtitle(station.subtitle);
    item.innerHTML = `
      <div class="station-info">
        <span class="station-name">${displayName}</span>
        <span class="station-sub">${displaySub}</span>
      </div>
      <div class="station-active-indicator"></div>
    `;
    item.addEventListener('click', () => selectStation(index));
    stationList.appendChild(item);
  });
}

async function startPlaybackForCurrentStation() {
  const requestId = ++activePlayRequestId;
  const station = stations[currentStationIndex];

  hasConnectionError = false;
  isPlaying = true;
  updatePlayState();
  setLoadingState(true);

  const response = await sendMessage({
    target: 'background',
    action: 'play',
    url: station.url,
    fallbackUrls: station.fallbackUrls || [],
    stationIndex: currentStationIndex,
    volume: currentVolume
  });

  if (requestId !== activePlayRequestId) return;

  if (response && response.success) {
    hasConnectionError = false;
    isPlaying = true;
    setLoadingState(false);
    updatePlayState();
  } else if (!response || !response.aborted) {
    isPlaying = false;
    hasConnectionError = true;
    setLoadingState(false);
    updatePlayState();
    refreshStatusLabel();
  }
}

function selectStation(index) {
  currentStationIndex = index;
  updateStationUI();
  startPlaybackForCurrentStation();
}

function updateStationUI() {
  if (currentStationIndex < 0 || currentStationIndex >= stations.length) {
    currentStationIndex = 0;
  }
  document.querySelectorAll('.station-item').forEach((el) => {
    const i = parseInt(el.dataset.index, 10);
    el.classList.toggle('active', i === currentStationIndex);
  });
  const current = stations[currentStationIndex];
  nowPlayingName.textContent = translateStationName(current.name);
  nowPlayingSubtitle.textContent = translateStationSubtitle(current.subtitle);
  markActiveSection();
}

function refreshStatusLabel() {
  if (isLoading) {
    statusText.textContent = getUI('loading');
  } else if (hasConnectionError) {
    statusText.textContent = getUI('error');
  } else {
    statusText.textContent = isPlaying ? getUI('live') : getUI('stopped');
  }
}

function setLoadingState(loading) {
  isLoading = loading;
  loadingRing.style.display = loading ? 'block' : 'none';
  statusDot.style.display = loading ? 'none' : 'block';
  refreshStatusLabel();
}

function updatePlayState() {
  playIcon.textContent = isPlaying ? '⏸' : '▶';
  statusDot.classList.toggle('live', isPlaying);
  playBtn.classList.toggle('playing', isPlaying);
  refreshStatusLabel();
}

playBtn.addEventListener('click', async () => {
  if (!isPlaying) {
    await startPlaybackForCurrentStation();
  } else {
    activePlayRequestId++;
    hasConnectionError = false;
    isPlaying = false;
    setLoadingState(false);
    updatePlayState();
    await sendMessage({ target: 'background', action: 'pause' });
  }
});

volumeSlider.addEventListener('input', () => {
  const sliderVal = Math.max(0, Math.min(100, parseFloat(volumeSlider.value) || 0));
  currentVolume = sliderVal / 100;
  updateVolumeIcon();
  sendMessage({ target: 'background', action: 'setVolume', volume: currentVolume });
});

function updateVolumeIcon() {
  const percent = Math.round(Math.max(0, Math.min(1, currentVolume)) * 100);
  if (percent === 0) volumeIcon.textContent = '🔇';
  else if (percent < 40) volumeIcon.textContent = '🔈';
  else if (percent < 75) volumeIcon.textContent = '🔉';
  else volumeIcon.textContent = '🔊';

  volumeSlider.style.setProperty('--val', percent);
}

volumeIcon.addEventListener('click', () => {
  if (currentVolume > 0) {
    volumeSlider.dataset.prev = currentVolume;
    currentVolume = 0;
    volumeSlider.value = 0;
  } else {
    currentVolume = parseFloat(volumeSlider.dataset.prev || 1.0);
    volumeSlider.value = Math.round(currentVolume * 100);
  }
  updateVolumeIcon();
  sendMessage({ target: 'background', action: 'setVolume', volume: currentVolume });
});

function toggleSection(sectionId) {
  if (expandedSections.has(sectionId)) expandedSections.delete(sectionId);
  else expandedSections.add(sectionId);
  filterStations(searchInput.value);
}

function filterStations(rawQuery) {
  const searchTerm = (rawQuery || '').trim().toLowerCase();
  const items = stationList.querySelectorAll('.station-item');
  const matchCountBySection = {};

  items.forEach((item) => {
    const index = parseInt(item.dataset.index, 10);
    const station = stations[index];
    const matchesCategory =
      currentCategory === 'all' || station.section === currentCategory;

    let matchesSearch = true;
    if (searchTerm) {
      const searchable = [
        station.name,
        station.subtitle,
        translateSectionTitle(station.section, 'ar'),
        translateSectionTitle(station.section, currentLang),
        translateStationName(station.name, currentLang),
        translateStationSubtitle(station.subtitle, currentLang),
        translateStationName(station.name, 'en'),
        translateStationSubtitle(station.subtitle, 'en'),
        translateStationName(station.name, 'fr')
      ]
        .join(' ')
        .toLowerCase();
      matchesSearch = searchable.includes(searchTerm);
    }

    const isMatch = matchesCategory && matchesSearch;
    item.dataset.match = isMatch ? '1' : '0';
    // a station is shown only if it matches AND its section is open (searching opens everything)
    const isVisible = isMatch && (searchTerm !== '' || expandedSections.has(station.section));
    item.style.display = isVisible ? 'flex' : 'none';
    if (isMatch) {
      matchCountBySection[station.section] = (matchCountBySection[station.section] || 0) + 1;
    }
  });

  const headers = stationList.querySelectorAll('.section-tab-header');
  headers.forEach((header) => {
    const secId = header.dataset.section;
    const count = matchCountBySection[secId] || 0;
    const open = searchTerm !== '' || expandedSections.has(secId);
    header.style.display = count > 0 ? 'flex' : 'none';
    header.classList.toggle('collapsed', !open);
    header.setAttribute('aria-expanded', open ? 'true' : 'false');
    const countBadge = header.querySelector('.section-tab-count');
    if (countBadge) countBadge.textContent = count;
  });

  markActiveSection();
}

function markActiveSection() {
  const current = stations[currentStationIndex];
  stationList.querySelectorAll('.section-tab-header').forEach((header) => {
    header.classList.toggle('has-active', !!current && header.dataset.section === current.section);
  });
}

searchInput.addEventListener('input', (e) => {
  filterStations(e.target.value);
});

function sendMessage(message) {
  return engineHandle(message);
}

// ⭐ دوال الوضع الليلي ⭐
async function loadTheme() {
  const data = store.get('theme');
  const savedTheme = data.theme || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
  applySystemBars(savedTheme);
}

function updateThemeIcon(theme) {
  themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}

themeToggle.addEventListener('click', async () => {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

  const root = document.documentElement;
  root.classList.add('theme-anim');
  clearTimeout(window.__themeAnimTimer);
  root.setAttribute('data-theme', newTheme);
  updateThemeIcon(newTheme);
  window.__themeAnimTimer = setTimeout(() => root.classList.remove('theme-anim'), 450);
  store.set({ theme: newTheme }); applySystemBars(newTheme);
});

// ⭐ دالة التشغيل الأساسية ⭐
async function init() {
  await loadTheme();
  await loadLanguage();
  const state = await sendMessage({ target: 'background', action: 'getState' });
  if (state && state.state) {
    isPlaying = state.state.isPlaying || false;
    currentStationIndex = state.state.currentStation || 0;
    if (currentStationIndex >= stations.length) {
      currentStationIndex = 0;
    }
    currentVolume = state.state.volume ?? 1.0;
  }
  volumeSlider.value = Math.round(currentVolume * 100);
  updateVolumeIcon();
  updateStationUI();
  updatePlayState();
  const activeItem = stationList.querySelector('.station-item.active');
  if (activeItem) {
    activeItem.scrollIntoView({ block: 'nearest' });
  }
}

init();

// ── Re-sync the UI with the native player (after unlock / app resume / page reload) ──
async function syncFromNative() {
  if (!Media || !Media.getStatus) return;
  try {
    const st = await Media.getStatus();
    if (st && st.running && st.nativeMode) {
      usingNative = true;
      wantPlaying = !!st.playing;
      if (isPlaying !== !!st.playing || hasConnectionError) syncUiPlaying(!!st.playing);
    } else if (usingNative && isPlaying) {
      syncUiPlaying(false); // the service is gone -> nothing is playing any more
    }
  } catch (_) {}
}

if (AppPlugin && AppPlugin.addListener) {
  AppPlugin.addListener('appStateChange', (st) => { if (st && st.isActive) syncFromNative(); });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFromNative(); });
setTimeout(syncFromNative, 600);
