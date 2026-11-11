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
let activePlaylist = null; // { urls, currentIndex, seekOnTuneIn }
let wantPlaying = false;
let lastPlayArgs = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

function applyVolume(vol) {
  const clamped = Math.max(0, Math.min(1, Number(vol ?? 1)));
  engineVolume = clamped;
  audio.volume = clamped === 0 ? 0 : Math.min(1, Math.pow(clamped, 1.7));
}
applyVolume(1.0);

function clearStallTimer() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }
function clearReconnectTimer() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }

function buildPlaylistUrlsFromServer(serverSpec) {
  const baseServer = serverSpec.replace('mp3quran-server:', '').replace(/\/+$/, '');
  const isYakoob = baseServer.includes('Rewayat-Rawh-A-n-Yakoob-Alhadrami');
  const startSurah = isYakoob ? 51 : 1;
  const trackUrls = [];
  for (let s = startSurah; s <= 114; s++) {
    trackUrls.push(`${baseServer}/${String(s).padStart(3, '0')}.mp3`);
  }
  return trackUrls;
}

function buildCandidateUrls(url, fallbackUrls = []) {
  const candidates = [];
  const addUrl = (u) => {
    if (!u || typeof u !== 'string') return;
    if (u.startsWith('mp3quran-server:')) {
      const fallbackTracks = buildPlaylistUrlsFromServer(u);
      const startIdx = Math.floor(Math.random() * fallbackTracks.length);
      for (let offset = 0; offset < Math.min(3, fallbackTracks.length); offset++) {
        const trackUrl = fallbackTracks[(startIdx + offset) % fallbackTracks.length];
        if (!candidates.includes(trackUrl)) candidates.push(trackUrl);
      }
      return;
    }
    if (!candidates.includes(u)) candidates.push(u);
  };

  if (url && url.startsWith('mp3quran-server:')) {
    const trackUrls = buildPlaylistUrlsFromServer(url);
    const startIdx = Math.floor(Math.random() * trackUrls.length);
    activePlaylist = { urls: trackUrls, currentIndex: startIdx, seekOnTuneIn: true };
    for (let offset = 0; offset < Math.min(3, trackUrls.length); offset++) {
      addUrl(trackUrls[(startIdx + offset) % trackUrls.length]);
    }
  } else {
    activePlaylist = null;
    if (url && url.includes('://qurango.net/radio/')) {
      addUrl(url.replace('://qurango.net/radio/', '://backup.qurango.net/radio/'));
      addUrl(url);
    } else if (url && url.includes('://backup.qurango.net/radio/')) {
      addUrl(url);
      addUrl(url.replace('://backup.qurango.net/radio/', '://qurango.net/radio/'));
    } else if (url) {
      addUrl(url);
    }
  }
  if (Array.isArray(fallbackUrls)) fallbackUrls.forEach(addUrl);
  return candidates;
}

function tryPlaySingleUrl(targetUrl, playId, seekLiveOffset = false, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (playId !== currentPlayId) return reject(new Error('ABORTED'));

    let settled = false;
    const onLoadedMetadata = () => {
      if (playId !== currentPlayId) return;
      if (seekLiveOffset && Number.isFinite(audio.duration) && audio.duration > 45) {
        const randomFraction = 0.1 + Math.random() * 0.65;
        try { audio.currentTime = Math.floor(audio.duration * randomFraction); } catch (_) {}
      }
    };
    const cleanup = () => audio.removeEventListener('loadedmetadata', onLoadedMetadata);

    const timer = setTimeout(() => {
      if (!settled) { settled = true; cleanup(); reject(new Error('TIMEOUT')); }
    }, timeoutMs);

    audio.pause();
    applyVolume(engineVolume);
    if (seekLiveOffset) audio.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });

    audio.src = targetUrl;
    audio.load();
    audio.play()
      .then(() => { if (settled) return; settled = true; clearTimeout(timer); resolve(true); })
      .catch((err) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); reject(err); });
  });
}

async function playStation(url, volume, fallbackUrls = []) {
  const playId = ++currentPlayId;
  clearStallTimer();
  if (volume !== undefined && volume !== null) applyVolume(volume);

  const candidates = buildCandidateUrls(url, fallbackUrls);
  const shouldSeekLive = Boolean(activePlaylist && activePlaylist.seekOnTuneIn);
  let lastError = null;

  for (const candidate of candidates) {
    if (playId !== currentPlayId) return { success: false, aborted: true };
    try {
      await tryPlaySingleUrl(candidate, playId, shouldSeekLive, 6000);
      if (playId !== currentPlayId) return { success: false, aborted: true };
      if (activePlaylist) {
        const matchedIdx = activePlaylist.urls.indexOf(candidate);
        if (matchedIdx !== -1) activePlaylist.currentIndex = matchedIdx;
        activePlaylist.seekOnTuneIn = false;
      }
      return { success: true, activeUrl: candidate };
    } catch (err) {
      if (playId !== currentPlayId || (err && err.message === 'ABORTED')) return { success: false, aborted: true };
      lastError = err;
    }
  }

  if (candidates.length > 0 && playId === currentPlayId) {
    const retryUrl = candidates[0] + (candidates[0].includes('?') ? '&' : '?') + '_t=' + Date.now();
    try {
      await tryPlaySingleUrl(retryUrl, playId, shouldSeekLive, 7000);
      if (playId !== currentPlayId) return { success: false, aborted: true };
      if (activePlaylist) activePlaylist.seekOnTuneIn = false;
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

  // start the foreground service first so Android keeps us alive while the stream connects
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
  activePlaylist = null;
  audio.pause();
  if (hideNotification) mediaHide(); else mediaShow(false);
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
  const n = stations.length;
  const next = (currentStationIndex + dir + n) % n;
  selectStation(next);
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

// Next surah in Mushaf order when a track ends (playlist stations)
audio.addEventListener('ended', () => {
  if (activePlaylist && activePlaylist.urls.length > 0) {
    activePlaylist.currentIndex = (activePlaylist.currentIndex + 1) % activePlaylist.urls.length;
    audio.src = activePlaylist.urls[activePlaylist.currentIndex];
    audio.load();
    applyVolume(engineVolume);
    audio.play().catch(() => {});
  } else if (wantPlaying) {
    scheduleReconnect();
  }
});

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
const stations = [
  // ─── قسم التلاوات المجودة ───
  {
    name: 'تكبيرات العيد',
    subtitle: 'بث مباشر',
    url: 'https://backup.qurango.net/radio/eid',
    fallbackUrls: ['https://qurango.net/radio/eid']
  },
  {
    name: 'محمود خليل الحصري',
    subtitle: 'رواية حفص - مجود',
    url: 'https://backup.qurango.net/radio/mahmoud_khalil_alhussary_mojawwad',
    fallbackUrls: [
      'https://qurango.net/radio/mahmoud_khalil_alhussary_mojawwad',
      'https://backup.qurango.net/radio/mahmoud_khalil_alhussary'
    ]
  },
  {
    name: 'محمود خليل الحصري',
    subtitle: 'رواية حفص - مرتل',
    url: 'https://backup.qurango.net/radio/mahmoud_khalil_alhussary',
    fallbackUrls: [
      'https://qurango.net/radio/mahmoud_khalil_alhussary',
      'https://backup.qurango.net/radio/mahmoud_khalil_alhussary_mojawwad'
    ]
  },
  {
    name: 'محمود خليل الحصري',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/mahmoud_khalil_alhussary_warsh',
    fallbackUrls: [
      'https://qurango.net/radio/mahmoud_khalil_alhussary_warsh',
      'https://backup.qurango.net/radio/mahmoud_khalil_alhussary'
    ]
  },
  {
    name: 'محمود خليل الحصري',
    subtitle: 'رواية الدوري عن أبي عمرو',
    url: 'https://serverkw.quran-uni.com:8050/;*.mp3',
    fallbackUrls: [
      'https://serverkw.quran-uni.com:8050',
      'mp3quran-server:https://server13.mp3quran.net/husr/Rewayat-Aldori-A-n-Abi-Amr'
    ]
  },
  {
    name: 'محمود خليل الحصري',
    subtitle: 'رواية قالون عن نافع',
    url: 'https://serverkw.quran-uni.com:8206/;*.mp3',
    fallbackUrls: [
      'https://serverkw.quran-uni.com:8206',
      'mp3quran-server:https://server13.mp3quran.net/husr/Rewayat-Qalon-A-n-Nafi'
    ]
  },
  {
    name: 'محمد صديق المنشاوي',
    subtitle: 'رواية حفص - مجود',
    url: 'https://backup.qurango.net/radio/mohammed_siddiq_alminshawi_mojawwad',
    fallbackUrls: [
      'https://qurango.net/radio/mohammed_siddiq_alminshawi_mojawwad',
      'https://backup.qurango.net/radio/mohammed_siddiq_alminshawi'
    ]
  },
  {
    name: 'محمد صديق المنشاوي',
    subtitle: 'رواية حفص - مرتل',
    url: 'https://backup.qurango.net/radio/mohammed_siddiq_alminshawi',
    fallbackUrls: [
      'https://qurango.net/radio/mohammed_siddiq_alminshawi',
      'https://backup.qurango.net/radio/mohammed_siddiq_alminshawi_mojawwad'
    ]
  },
  {
    name: 'عبد الباسط عبد الصمد',
    subtitle: 'رواية حفص - مجود',
    url: 'https://backup.qurango.net/radio/abdulbasit_abdulsamad_mojawwad',
    fallbackUrls: [
      'https://qurango.net/radio/abdulbasit_abdulsamad_mojawwad',
      'https://backup.qurango.net/radio/abdulbasit_abdulsamad'
    ]
  },
  {
    name: 'عبد الباسط عبد الصمد',
    subtitle: 'رواية حفص - مرتل',
    url: 'https://backup.qurango.net/radio/abdulbasit_abdulsamad',
    fallbackUrls: [
      'https://qurango.net/radio/abdulbasit_abdulsamad',
      'https://backup.qurango.net/radio/abdulbasit_abdulsamad_mojawwad'
    ]
  },
  {
    name: 'عبد الباسط عبد الصمد',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/abdulbasit_abdulsamad_warsh',
    fallbackUrls: [
      'https://qurango.net/radio/abdulbasit_abdulsamad_warsh',
      'https://backup.qurango.net/radio/abdulbasit_abdulsamad'
    ]
  },
  {
    name: 'محمود علي البنّا',
    subtitle: 'رواية حفص - مجود',
    url: 'https://backup.qurango.net/radio/mahmoud_ali__albanna_mojawwad',
    fallbackUrls: [
      'https://qurango.net/radio/mahmoud_ali__albanna_mojawwad',
      'https://backup.qurango.net/radio/mahmoud_ali__albanna'
    ]
  },
  {
    name: 'محمود علي البنّا',
    subtitle: 'رواية حفص - مرتل',
    url: 'https://backup.qurango.net/radio/mahmoud_ali__albanna',
    fallbackUrls: [
      'https://qurango.net/radio/mahmoud_ali__albanna',
      'https://backup.qurango.net/radio/mahmoud_ali__albanna_mojawwad'
    ]
  },
  {
    name: 'مصطفى إسماعيل',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/mustafa_ismail',
    fallbackUrls: ['https://qurango.net/radio/mustafa_ismail']
  },
  {
    name: 'محمد الطبلاوي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/mohammad_altablaway',
    fallbackUrls: ['https://qurango.net/radio/mohammad_altablaway']
  },
  {
    name: 'أحمد نعينع',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/ahmad_nauina',
    fallbackUrls: ['https://qurango.net/radio/ahmad_nauina']
  },
  {
    name: 'أحمد عامر',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/ahmed_amer',
    fallbackUrls: ['https://qurango.net/radio/ahmed_amer']
  },
  {
    name: 'سيد رمضان',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/sayeed_ramadan',
    fallbackUrls: ['https://qurango.net/radio/sayeed_ramadan']
  },
  {
    name: 'علي حجاج السويسي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/ali_hajjaj_alsouasi',
    fallbackUrls: ['https://qurango.net/radio/ali_hajjaj_alsouasi']
  },
  {
    name: 'محمد رشاد الشريف',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/mohammad_rashad_alshareef',
    fallbackUrls: ['https://qurango.net/radio/mohammad_rashad_alshareef']
  },
  {
    name: 'صابر عبد الحكم',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/saber_abdulhakm',
    fallbackUrls: ['https://qurango.net/radio/saber_abdulhakm']
  },
  {
    name: 'أحمد خليل شاهين',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/ahmad_shaheen',
    fallbackUrls: ['https://qurango.net/radio/ahmad_shaheen']
  },
  {
    name: 'أحمد صابر',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/ahmad_saber',
    fallbackUrls: ['https://qurango.net/radio/ahmad_saber']
  },
  {
    name: 'مصطفى اللاهوني',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/mustafa_allahoni',
    fallbackUrls: ['https://qurango.net/radio/mustafa_allahoni']
  },
  {
    name: 'أكرم العلاقمي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/akram_alalaqmi',
    fallbackUrls: ['https://qurango.net/radio/akram_alalaqmi']
  },

  // ─── الإذاعات المباشرة والمنوعات القرآنية ───
  {
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
    name: 'إذاعة الحرم المكي',
    subtitle: 'إذاعة مباشرة',
    url: 'http://r7.tarat.com:8004/stream?type=http&nocache=114',
    fallbackUrls: [
      'https://stream.radiojar.com/0tpy1h0kxtzuv',
      'https://backup.qurango.net/radio/abdulrahman_alsudaes'
    ]
  },
  {
    name: 'الإذاعة العامة - إذاعة متنوعة لمختلف القراء',
    subtitle: 'إذاعة متنوعة',
    url: 'https://backup.qurango.net/radio/mix',
    fallbackUrls: [
      'https://qurango.net/radio/mix',
      'https://backup.qurango.net/radio/salma'
    ]
  },
  {
    name: 'تلاوات خاشعة',
    subtitle: 'روايات متنوعة',
    url: 'https://backup.qurango.net/radio/salma',
    fallbackUrls: [
      'https://qurango.net/radio/salma',
      'https://backup.qurango.net/radio/sakeenah'
    ]
  },
  {
    name: 'إذاعة آيات السكينة',
    subtitle: 'تلاوات هادئة',
    url: 'https://backup.qurango.net/radio/sakeenah',
    fallbackUrls: [
      'https://qurango.net/radio/sakeenah',
      'https://backup.qurango.net/radio/salma'
    ]
  },
  {
    name: 'تراتيل قصيرة متميزة',
    subtitle: 'تلاوات مختارة',
    url: 'https://backup.qurango.net/radio/tarateel',
    fallbackUrls: [
      'https://qurango.net/radio/tarateel',
      'https://backup.qurango.net/radio/salma'
    ]
  },
  {
    name: 'سورة البقرة - لعدد من القراء',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/albaqarah',
    fallbackUrls: ['https://qurango.net/radio/albaqarah']
  },

  // ─── أئمة الحرمين الشريفين وكبار القراء ───
  {
    name: 'ماهر المعيقلي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/maher_al_meaqli',
    fallbackUrls: [
      'https://backup.qurango.net/radio/maher',
      'https://qurango.net/radio/maher_al_meaqli',
      'https://qurango.net/radio/maher'
    ]
  },
  {
    name: 'بندر بليلة',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/bandar_balilah',
    fallbackUrls: ['https://qurango.net/radio/bandar_balilah']
  },
  {
    name: 'علي الحذيفي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/ali_alhuthaifi',
    fallbackUrls: [
      'https://qurango.net/radio/ali_alhuthaifi',
      'https://backup.qurango.net/radio/ali_alhuthaifi_qalon'
    ]
  },
  {
    name: 'علي الحذيفي',
    subtitle: 'رواية قالون عن نافع',
    url: 'https://backup.qurango.net/radio/ali_alhuthaifi_qalon',
    fallbackUrls: [
      'https://qurango.net/radio/ali_alhuthaifi_qalon',
      'https://backup.qurango.net/radio/ali_alhuthaifi'
    ]
  },
  {
    name: 'عبد الرحمن السديس',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/abdulrahman_alsudaes',
    fallbackUrls: ['https://qurango.net/radio/abdulrahman_alsudaes']
  },
  {
    name: 'سعود الشريم',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/saud_alshuraim',
    fallbackUrls: ['https://qurango.net/radio/saud_alshuraim']
  },
  {
    name: 'ياسر الدوسري',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/yasser_aldosari',
    fallbackUrls: ['https://qurango.net/radio/yasser_aldosari']
  },
  {
    name: 'عبد الله عواد الجهني',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/abdullah_aljohany',
    fallbackUrls: ['https://qurango.net/radio/abdullah_aljohany']
  },
  {
    name: 'صلاح البدير',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/salah_albudair',
    fallbackUrls: ['https://qurango.net/radio/salah_albudair']
  },
  {
    name: 'عبد المحسن القاسم',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/abdulmohsen_alqasim',
    fallbackUrls: ['https://qurango.net/radio/abdulmohsen_alqasim']
  },
  {
    name: 'عبد البارئ الثبيتي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/abdelbari_altoubayti',
    fallbackUrls: ['https://qurango.net/radio/abdelbari_altoubayti']
  },
  {
    name: 'أحمد طالب بن حميد',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/a_binhameed',
    fallbackUrls: ['https://qurango.net/radio/a_binhameed']
  },
  {
    name: 'بدر التركي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/bader',
    fallbackUrls: ['https://qurango.net/radio/bader']
  },
  {
    name: 'علي جابر',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/ali_jaber',
    fallbackUrls: ['https://qurango.net/radio/ali_jaber']
  },
  {
    name: 'محمد أيوب',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/mohammed_ayyub',
    fallbackUrls: [
      'https://qurango.net/radio/mohammed_ayyub',
      'https://backup.qurango.net/radio/ayyoub2'
    ]
  },
  {
    name: 'محمد أيوب',
    subtitle: 'قراءة مميزة - رواية حفص',
    url: 'https://backup.qurango.net/radio/ayyoub2',
    fallbackUrls: [
      'https://qurango.net/radio/ayyoub2',
      'https://backup.qurango.net/radio/mohammed_ayyub'
    ]
  },
  {
    name: 'عبد الله خياط',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/abdullah_khayyat',
    fallbackUrls: ['https://qurango.net/radio/abdullah_khayyat']
  },

  // ─── نخبة القراء من العالم الإسلامي ───
  {
    name: 'مشاري راشد العفاسي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/mishary_alafasi',
    fallbackUrls: ['https://qurango.net/radio/mishary_alafasi']
  },
  {
    name: 'أبو بكر الشاطري',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/shaik_abu_bakr_al_shatri',
    fallbackUrls: ['https://qurango.net/radio/shaik_abu_bakr_al_shatri']
  },
  {
    name: 'سعد الغامدي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/saad_alghamdi',
    fallbackUrls: ['https://qurango.net/radio/saad_alghamdi']
  },
  {
    name: 'أحمد العجمي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/ahmad_alajmy',
    fallbackUrls: ['https://qurango.net/radio/ahmad_alajmy']
  },
  {
    name: 'فارس عباد',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/fares_abbad',
    fallbackUrls: ['https://qurango.net/radio/fares_abbad']
  },
  {
    name: 'إدريس أبكر',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/idrees_abkr',
    fallbackUrls: ['https://qurango.net/radio/idrees_abkr']
  },
  {
    name: 'ناصر القطامي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/nasser_alqatami',
    fallbackUrls: ['https://qurango.net/radio/nasser_alqatami']
  },
  {
    name: 'خالد الجليل',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/khalid_aljileel',
    fallbackUrls: ['https://qurango.net/radio/khalid_aljileel']
  },
  {
    name: 'محمد اللحيدان',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/mohammed_allohaidan',
    fallbackUrls: ['https://qurango.net/radio/mohammed_allohaidan']
  },
  {
    name: 'محمد جبريل',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/mohammed_jibreel',
    fallbackUrls: ['https://qurango.net/radio/mohammed_jibreel']
  },
  {
    name: 'هاني الرفاعي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/hani_arrifai',
    fallbackUrls: ['https://qurango.net/radio/hani_arrifai']
  },
  {
    name: 'عادل الكلباني',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/adel_alkhalbany',
    fallbackUrls: ['https://qurango.net/radio/adel_alkhalbany']
  },
  {
    name: 'صلاح بو خاطر',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/slaah_bukhatir',
    fallbackUrls: ['https://qurango.net/radio/slaah_bukhatir']
  },
  {
    name: 'عبد الله بصفر',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/abdullah_basfer',
    fallbackUrls: ['https://qurango.net/radio/abdullah_basfer']
  },
  {
    name: 'عبد الله المطرود',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/abdullah_almattrod',
    fallbackUrls: ['https://qurango.net/radio/abdullah_almattrod']
  },
  {
    name: 'خالد القحطاني',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/khaled_alqahtani',
    fallbackUrls: ['https://qurango.net/radio/khaled_alqahtani']
  },
  {
    name: 'خليفة الطنيجي',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/khalifa_altunaiji',
    fallbackUrls: ['https://qurango.net/radio/khalifa_altunaiji']
  },
  {
    name: 'حاتم فريد الواعر',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/hatem_fareed_alwaer',
    fallbackUrls: [
      'https://qurango.net/radio/hatem_fareed_alwaer',
      'https://backup.qurango.net/radio/mahmood_al_rifai'
    ]
  },
  {
    name: 'الزين محمد أحمد',
    subtitle: 'رواية حفص',
    url: 'https://backup.qurango.net/radio/alzain_mohammad_ahmad',
    fallbackUrls: ['https://qurango.net/radio/alzain_mohammad_ahmad']
  },
  {
    name: 'العيون الكوشي',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/aloyoon_alkoshi',
    fallbackUrls: ['https://qurango.net/radio/aloyoon_alkoshi']
  },
  {
    name: 'عمر القزابري',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/omar_alqazabri',
    fallbackUrls: ['https://qurango.net/radio/omar_alqazabri']
  },
  {
    name: 'القارئ ياسين',
    subtitle: 'رواية ورش عن نافع',
    url: 'https://backup.qurango.net/radio/alqaria_yassen',
    fallbackUrls: ['https://qurango.net/radio/alqaria_yassen']
  },

  // ─── التفسير والحديث والأذكار والسيرة ───
  {
    name: 'الرقية الشرعية',
    subtitle: 'رقية شرعية',
    url: 'https://backup.qurango.net/radio/roqiah',
    fallbackUrls: ['https://qurango.net/radio/roqiah']
  },
  {
    name: 'أذكار الصباح',
    subtitle: 'أذكار',
    url: 'https://backup.qurango.net/radio/athkar_sabah',
    fallbackUrls: ['https://qurango.net/radio/athkar_sabah']
  },
  {
    name: 'أذكار المساء',
    subtitle: 'أذكار',
    url: 'https://backup.qurango.net/radio/athkar_masa',
    fallbackUrls: ['https://qurango.net/radio/athkar_masa']
  },
  {
    name: 'قصص الأنبياء',
    subtitle: 'قصص',
    url: 'https://backup.qurango.net/radio/alanbiya',
    fallbackUrls: ['https://qurango.net/radio/alanbiya']
  },
  {
    name: 'صحيح البخاري',
    subtitle: 'حديث',
    url: 'https://backup.qurango.net/radio/saheh-bokharee',
    fallbackUrls: ['https://qurango.net/radio/saheh-bokharee']
  },
  {
    name: 'صحيح مسلم',
    subtitle: 'حديث',
    url: 'https://backup.qurango.net/radio/saheh-muslim',
    fallbackUrls: ['https://qurango.net/radio/saheh-muslim']
  },
  {
    name: 'المختصر في السيرة النبوية',
    subtitle: 'السيرة',
    url: 'https://backup.qurango.net/radio/almukhtasar_fi_alsiyra',
    fallbackUrls: [
      'https://qurango.net/radio/almukhtasar_fi_alsiyra',
      'https://backup.qurango.net/radio/fi_zilal_alsiyra'
    ]
  },
  {
    name: 'في ظلال السيرة النبوية',
    subtitle: 'السيرة',
    url: 'https://backup.qurango.net/radio/fi_zilal_alsiyra',
    fallbackUrls: [
      'https://qurango.net/radio/fi_zilal_alsiyra',
      'https://backup.qurango.net/radio/almukhtasar_fi_alsiyra'
    ]
  },
  {
    name: 'المختصر في تفسير القرآن الكريم',
    subtitle: 'تفسير',
    url: 'https://backup.qurango.net/radio/mukhtasartafsir',
    fallbackUrls: [
      'https://qurango.net/radio/mukhtasartafsir',
      'https://backup.qurango.net/radio/tafseer'
    ]
  },
  {
    name: 'تفسير القرآن الكريم للإمام الطبري',
    subtitle: 'تفسير',
    url: 'https://backup.qurango.net/radio/tabri',
    fallbackUrls: [
      'https://qurango.net/radio/tabri',
      'https://backup.qurango.net/radio/tafseer'
    ]
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
    searchPlaceholder: 'ابحث عن قارئ أو إذاعة...',
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
    searchPlaceholder: 'Search reciter or station...',
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
    searchPlaceholder: 'Rechercher un récitateur ou une radio...',
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
    searchPlaceholder: 'Buscar recitador o emisora...',
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
    searchPlaceholder: 'Kâri veya radyo ara...',
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
    searchPlaceholder: 'Cari qari atau stasiun radio...',
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
    searchPlaceholder: 'قاری یا ریڈیو تلاش کریں...',
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
    searchPlaceholder: 'Поиск чтеца или радиостанции...',
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
    searchPlaceholder: 'Rezitator oder Sender suchen...',
    themeTitle: 'Design wechseln',
    langTitle: 'Sprache ändern',
    playTitle: 'Wiedergabe / Pause',
    muteTitle: 'Stummschalten',
    volumeTitle: 'Lautstärke'
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
  'القارئ ياسين': 'Al-Qari Yassen'
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
  'القارئ ياسين': 'Аль-Кари Ясин'
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
  'رواية حفص - مجود': {
    en: 'Hafs Narration - Mujawwad (Melodic)',
    fr: 'Narration Hafs - Moujawwad',
    es: 'Narración Hafs - Muyawad',
    tr: 'Hafs Rivayeti - Mücevved',
    id: 'Riwayat Hafs - Mujawwad',
    ur: 'روایتِ حفص - مجود',
    ru: 'Риваят Хафс - Муджаввад',
    de: 'Hafs-Überlieferung - Mujawwad'
  },
  'رواية حفص - مرتل': {
    en: 'Hafs Narration - Murattal',
    fr: 'Narration Hafs - Mourattal',
    es: 'Narración Hafs - Murattal',
    tr: 'Hafs Rivayeti - Mürettel',
    id: 'Riwayat Hafs - Murattal',
    ur: 'روایتِ حفص - مرتل',
    ru: 'Риваят Хафс - Муратталь',
    de: 'Hafs-Überlieferung - Murattal'
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
  'رواية حفص': {
    en: 'Hafs Narration',
    fr: 'Narration Hafs',
    es: 'Narración Hafs',
    tr: 'Hafs Rivayeti',
    id: 'Riwayat Hafs',
    ur: 'روایتِ حفص',
    ru: 'Риваят Хафс',
    de: 'Hafs-Überlieferung'
  },
  'قراءة يعقوب الحضرمي (رويس وروح)': {
    en: 'Yaqoub Al-Hadrami Recitation (Ruways & Rawh)',
    fr: 'Lecture Yaqoub Al-Hadrami (Rouways et Rawh)',
    es: 'Lectura Yaqub Al-Hadrami (Ruways y Rawh)',
    tr: 'Yakub el-Hadramî Kıraati (Ruveys ve Ravh)',
    id: 'Qiraat Yaqub Al-Hadhrami (Ruwais & Rauh)',
    ur: 'قراءتِ یعقوب حضرمی (رویس و روح)',
    ru: 'Кыраат Якуба аль-Хадрами (Рувайс и Раух)',
    de: 'Yaqub al-Hadrami Lesart (Ruways & Rawh)'
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

let currentLang = 'ar';
let isPlaying = false;
let isLoading = false;
let hasConnectionError = false;
let currentStationIndex = 0;
let currentVolume = 1.0;
let activePlayRequestId = 0;

const playBtn = document.getElementById('playBtn');
const playIcon = document.getElementById('playIcon');
const stationList = document.getElementById('stationList');
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

function buildStationList() {
  stationList.innerHTML = '';
  stations.forEach((station, index) => {
    const item = document.createElement('div');
    item.className = 'station-item' + (index === currentStationIndex ? ' active' : '');
    item.dataset.index = index;
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

function filterStations(rawQuery) {
  const searchTerm = (rawQuery || '').trim().toLowerCase();
  const items = stationList.querySelectorAll('.station-item');

  items.forEach((item) => {
    const index = parseInt(item.dataset.index, 10);
    const station = stations[index];
    const searchable = [
      station.name,
      station.subtitle,
      translateStationName(station.name, currentLang),
      translateStationSubtitle(station.subtitle, currentLang),
      translateStationName(station.name, 'en'),
      translateStationSubtitle(station.subtitle, 'en'),
      translateStationName(station.name, 'fr')
    ]
      .join(' ')
      .toLowerCase();

    item.style.display = searchable.includes(searchTerm) ? 'flex' : 'none';
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

  document.documentElement.setAttribute('data-theme', newTheme);
  updateThemeIcon(newTheme);
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
  if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
}

init();
