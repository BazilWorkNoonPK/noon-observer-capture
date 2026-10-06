// Observer capture page - the logic. DESIGN.md section 3; findings of P0 (P0_RESULT.md) are marked "P0:".
// Plain JavaScript, no framework. Everything the page decides comes from the clock and the schedule (3.5, 3.6).
(() => {
  'use strict';
  const C = window.OBS_CONFIG;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ state
  const S = {
    deviceId: null, token: null,
    schedule: null, scheduleFetchedAt: 0, scheduleSource: 'none',
    stream: null, track: null, micLabel: null, micHow: null, micDeviceId: null, micLost: false, reopenTimer: null,
    ctx: null, dest: null, ctxRunning: false,
    rec: null, cur: null, chunkStartMs: 0, chunkSeq: 0, stopping: false, starting: false, clockOffsetS: null,
    session: null,                      // { id, shift, cohort_code, periods, startedAt }
    levels: [], levelsSeq: 0, lastLevelsFlush: 0, lastStatus: 0, lastTick: 0,
    inFlight: false, lastUpload: null, queueDepth: 0, queueBytes: 0,
    state: 'starting', detail: '', log: [], worker: null, db: null
  };

  // ------------------------------------------------------------------ log and UI
  function log(line) {
    const t = new Date().toISOString().slice(11, 19);
    S.log.push(`${t} ${line}`); if (S.log.length > 300) S.log.shift();
    const el = $('log'); if (el) { el.textContent = S.log.slice(-60).join('\n'); }
  }
  function setState(word, detail) {
    if (word !== S.state && (word === 'no_mic' || word === 'error')) S.lastStatus = 0;   // a problem is reported at the next tick, not in ten minutes
    S.state = word; S.detail = detail || '';
    const el = $('stateWord'); el.className = 'state ' + word;
    el.textContent = { recording: 'Recording', waiting: 'Waiting for shift', no_mic: 'No USB mic', error: 'Error', starting: 'Starting', standby: 'Standby' }[word] || word;
    $('stateDetail').textContent = S.detail;
  }
  function render() {
    $('pageVersion').textContent = C.PAGE_VERSION;
    $('deviceId').textContent = S.deviceId || '– (setup needed)';
    $('campus').textContent = (S.schedule && S.schedule.campus_name) || '–';
    $('schedule').textContent = S.schedule ? S.schedule.shifts.map(s => `shift ${s.shift} ${s.start}–${s.end}${s.cohort_code ? ' ' + s.cohort_code : ''}`).join(' · ') + ` (${S.scheduleSource})` : '–';
    $('session').textContent = S.session ? S.session.id : '–';
    $('chunk').textContent = S.cur && S.cur.rec.state === 'recording' ? `#${S.cur.seq} since ${new Date(S.cur.startMs).toTimeString().slice(0, 8)}` : '–';
    $('queue').textContent = `${S.queueDepth} items, ${(S.queueBytes / 1024 / 1024).toFixed(1)} MB`;
    $('lastUpload').textContent = S.lastUpload || 'none yet';
    $('micLabel').textContent = S.micLabel || '–';
    $('micHow').textContent = S.micHow || '–';
    document.body.classList.toggle('needs-setup', !S.deviceId || !S.stream);
    $('setupText').textContent = !S.deviceId
      ? 'This machine has no device id. Open the startup address HQ gave you, the one with ?device= and &token=, once.'
      : 'The microphone is not open yet. Press Allow microphone; Chrome asks once.';
  }

  // Desk and acceptance testing only: ?test=<minutes> records from now for that long regardless of the timetable,
  // and ?chunk=<minutes> shortens the chunks. Both are logged and every manifest of such a session carries test: true.
  const TEST = (() => {
    const q = new URLSearchParams(location.search);
    const minutes = Number(q.get('test') || 0), chunk = Number(q.get('chunk') || 0);
    return minutes > 0 ? { minutes, chunk: chunk > 0 ? chunk : null, startedAt: Date.now(), fake: q.get('fake') === '1' } : null;
  })();
  // ?fake=1 (with ?test=): a synthetic source instead of the mic (a 440 Hz tone, soft noise and a deliberate 50 Hz hum),
  // so the recording path and the high-pass filter can be checked on a machine with no microphone at all.
  // The endpoint: config.js, or the local stand-in (observer/tools/local_endpoint.py) when the page is served from localhost.
  // Served from this machine, the page always talks to the local stand-in, never to Noon's real endpoint.
  const ENDPOINT = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? location.origin + '/api' : C.ENDPOINT_URL;

  // ------------------------------------------------------------------ time (local wall clock with the configured offset)
  const offsetMin = (() => { const m = /([+-])(\d\d):(\d\d)/.exec(C.TIMEZONE_OFFSET); return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])); })();
  function localParts(ms) { const d = new Date(ms + offsetMin * 60000); return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16), iso: d.toISOString().slice(0, 19) + C.TIMEZONE_OFFSET }; }
  const isoLocal = (ms) => localParts(ms).iso;

  // ------------------------------------------------------------------ identity (3.1)
  function loadIdentity() {
    const q = new URLSearchParams(location.search);
    if (q.get('device') && q.get('token')) {
      localStorage.setItem('obs_device', q.get('device')); localStorage.setItem('obs_token', q.get('token'));
      const keep = new URLSearchParams(); ['test', 'chunk', 'fake'].forEach(k => { if (q.get(k)) keep.set(k, q.get(k)); });
      history.replaceState(null, '', location.pathname + (keep.toString() ? '?' + keep : ''));   // the token never stays in the address bar or history
      log(`identity stored from URL: ${q.get('device')}`);
    }
    S.deviceId = localStorage.getItem('obs_device'); S.token = localStorage.getItem('obs_token');
    if (!S.deviceId) { setState('error', 'No device id on this machine. Open the startup address HQ gave you once.'); }
  }

  // ------------------------------------------------------------------ schedule (3.5)
  function defaultSchedule() {
    if (TEST) {
      // A test run is split into two back-to-back shifts, as a real day is (08:00-11:00 then 11:00-14:00), so the
      // hand-over between shifts is exercised too (6 October 2026). Test sessions carry a T suffix in their id.
      const hm = (min) => localParts(TEST.startedAt + min * 60000).hm;
      const a = hm(0), m = hm(TEST.minutes / 2), b0 = hm(TEST.minutes), b = b0 < a ? '23:59' : b0;
      const shifts = (m > a && m < b)
        ? [{ shift: 1, start: a, end: m, cohort_code: null, periods: [] }, { shift: 2, start: m, end: b, cohort_code: null, periods: [] }]
        : [{ shift: 1, start: a, end: b, cohort_code: null, periods: [] }];
      return { campus_name: 'TEST', timetabled: false, test: true, shifts };
    }
    return { campus_name: null, timetabled: false, shifts: C.DEFAULT_SHIFTS.map(s => ({ ...s, cohort_code: null, periods: [] })) };
  }
  const chunkMinutes = () => (TEST && TEST.chunk) || C.CHUNK_MINUTES;
  async function fetchSchedule() {
    S.scheduleFetchedAt = Date.now();
    if (TEST) { S.schedule = defaultSchedule(); S.scheduleSource = `test ${TEST.minutes} min, chunks ${chunkMinutes()} min`; log(`TEST MODE: ${S.scheduleSource}`); render(); return; }
    try {
      const sentAt = Date.now();
      const r = await fetch(`${ENDPOINT}?device=${encodeURIComponent(S.deviceId)}&token=${encodeURIComponent(S.token)}`, { redirect: 'follow' });
      const j = await r.json(); noteServerTime(j, sentAt);
      if (j && j.ok && j.shifts) { S.schedule = { campus_name: j.campus_name, timetabled: true, shifts: j.shifts }; S.scheduleSource = 'endpoint'; localStorage.setItem('obs_schedule', JSON.stringify(S.schedule)); log('schedule from endpoint'); render(); return; }
      log(`schedule refused: ${j && j.reason}`);
    } catch (e) { log(`schedule fetch failed: ${e.message}`); }
    if (!S.schedule) {
      const cached = localStorage.getItem('obs_schedule');
      if (cached) { S.schedule = JSON.parse(cached); S.scheduleSource = 'cache'; log('schedule from cache'); }
      else { S.schedule = defaultSchedule(); S.scheduleSource = 'default'; log('schedule: default windows (untimetabled)'); }
    }
    render();
  }
  function currentShift(ms) { const hm = localParts(ms).hm; return (S.schedule ? S.schedule.shifts : []).find(s => s.start <= hm && hm < s.end) || null; }
  function currentPeriod(shift, ms) { const hm = localParts(ms).hm; return (shift.periods || []).find(p => p.start <= hm && hm < p.end) || null; }

  // ------------------------------------------------------------------ microphone (3.2; P0: choose by label, handle a dead stream)
  const CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  async function openFakeSource() {
    if (!S.ctx) { S.ctx = new (window.AudioContext || window.webkitAudioContext)(); await S.ctx.audioWorklet.addModule('level-worklet.js'); }
    const ctx = S.ctx, out = ctx.createMediaStreamDestination();
    const tone = ctx.createOscillator(); tone.frequency.value = 440; const tg = ctx.createGain(); tg.gain.value = 0.05;
    const hum = ctx.createOscillator(); hum.frequency.value = 50; const hg = ctx.createGain(); hg.gain.value = 0.3;     // louder than the tone, as at Gulshan-e-Yaseen
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.02;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    tone.connect(tg); tg.connect(out); hum.connect(hg); hg.connect(out); noise.connect(out);
    tone.start(); hum.start(); noise.start();
    S.stream = out.stream; S.track = out.stream.getAudioTracks()[0]; S.micLabel = 'FAKE synthetic source (tone + noise + 50 Hz hum)';
    S.micHow = 'fake'; S.micDeviceId = null; S.micLost = false;
    log('fake source open'); await buildGraph(); render(); return true;
  }
  async function openMic() {
    if (TEST && TEST.fake) return openFakeSource();
    try {
      if (S.stream) S.stream.getTracks().forEach(t => t.stop());
      let stream = await navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS });   // permission + labels
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      const usb = inputs.find(d => C.MIC_LABEL_PATTERN.test(d.label) && !/^(default|communications) - /i.test(d.label))
               || inputs.find(d => C.MIC_LABEL_PATTERN.test(d.label));
      if (usb && stream.getAudioTracks()[0].getSettings().deviceId !== usb.deviceId) {
        stream.getTracks().forEach(t => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...CONSTRAINTS, deviceId: { exact: usb.deviceId } } });
      }
      S.stream = stream; S.track = stream.getAudioTracks()[0]; S.micLabel = S.track.label; S.micDeviceId = S.track.getSettings().deviceId;
      S.micHow = usb ? 'USB name' : 'default (no USB mic found)'; S.micLost = false;
      S.track.onended = onMicLost;
      log(`mic open: "${S.micLabel}" via ${S.micHow}; ${JSON.stringify(S.track.getSettings())}`);
      await buildGraph();
      if (!usb) setState('no_mic', S.session ? `Recording from "${S.micLabel}" because no USB mic was found.`
                                              : `No USB mic found. "${S.micLabel}" would be used if a shift started now.`);
      render();
      return true;
    } catch (e) {
      log(`mic open failed: ${e.name} ${e.message}`);
      setState('no_mic', `Microphone not available: ${e.name}. ${e.name === 'NotAllowedError' ? 'Press Allow microphone.' : 'Check the cable.'}`);
      S.stream = null; render(); return false;
    }
  }
  function onMicLost() {
    log('mic stream ended (unplugged?)'); S.micLost = true;
    if (S.rec && S.rec.state === 'recording') stopChunk('mic_lost');
    setState('no_mic', 'The USB mic disappeared. Trying to reopen it.');
    scheduleReopen(2000);
  }
  function scheduleReopen(ms) { clearTimeout(S.reopenTimer); S.reopenTimer = setTimeout(tryReopen, ms); }
  async function tryReopen() {
    if (!S.micLost) return;
    const ok = await openMic();
    if (ok && S.micHow === 'USB name') { log('mic reopened'); if (S.session) startChunk(); }
    else scheduleReopen(15000);
  }
  navigator.mediaDevices.addEventListener('devicechange', () => { log('devicechange'); if (S.micLost || S.micHow !== 'USB name') scheduleReopen(1500); });

  // Web Audio graph: source -> high-pass (P0: 50 Hz hum) -> destination (recorded) and level worklet (3.3).
  async function buildGraph() {
    if (!S.ctx) {
      S.ctx = new (window.AudioContext || window.webkitAudioContext)();
      await S.ctx.audioWorklet.addModule('level-worklet.js');
    }
    if (S.graph) { try { S.graph.src.disconnect(); } catch (_) {} }
    const src = S.ctx.createMediaStreamSource(S.stream);
    const hp1 = S.ctx.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = C.HP_HZ; hp1.Q.value = 0.707;
    const hp2 = S.ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = C.HP_HZ; hp2.Q.value = 0.707;
    const dest = S.ctx.createMediaStreamDestination();
    const worklet = new AudioWorkletNode(S.ctx, 'observer-level', { processorOptions: { windowSeconds: C.LEVEL_WINDOW_S, voicedFloorRms: C.VOICED_FLOOR_RMS } });
    src.connect(hp1); hp1.connect(hp2); hp2.connect(dest); hp2.connect(worklet);
    worklet.port.onmessage = (e) => onLevel(e.data);
    S.graph = { src, hp1, hp2, worklet }; S.dest = dest;
    await ensureContextRunning();
  }
  // Chrome may keep an AudioContext suspended until the page has had a click. Without it the filtered stream is silent,
  // so the page falls back to recording the raw mic (hp_hz 0 in the manifest) and says so; any click resumes it.
  async function ensureContextRunning() {
    try { await S.ctx.resume(); } catch (_) {}
    S.ctxRunning = S.ctx.state === 'running';
    if (!S.ctxRunning) log('audiocontext suspended: recording raw mic, no level meter, until a click on this page');
    return S.ctxRunning;
  }
  ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, async () => {
    if (S.ctx && !S.ctxRunning && await ensureContextRunning()) { log('audiocontext resumed by a click'); if (S.rec && S.rec.state === 'recording') { stopChunk('graph_resumed'); } }
  }));

  // ------------------------------------------------------------------ level (3.3)
  function onLevel(w) {
    const pct = Math.max(0, Math.min(100, Math.round((Math.log10(Math.max(w.rms, 1e-5)) + 4) / 4 * 100)));   // display only, relative
    $('meterBar').style.width = pct + '%';
    if (!S.session) return;
    S.levels.push({ t: isoLocal(w.t_ms), rms: +w.rms.toFixed(5), peak: +w.peak.toFixed(4), voiced_fraction: +w.voiced_fraction.toFixed(3) });
  }
  function flushLevels(force) {
    if (!S.levels.length) return;
    if (!force && Date.now() - S.lastLevelsFlush < C.LEVELS_BATCH_S * 1000) return;
    const rows = S.levels; S.levels = []; S.lastLevelsFlush = Date.now(); S.levelsSeq++;
    saveSeq(S.session.id);
    enqueue({ kind: 'levels', id: `${S.session.id}_L${String(S.levelsSeq).padStart(4, '0')}`, session_id: S.session.id, rows });
  }

  // ------------------------------------------------------------------ chunks (3.4)
  // Everything one chunk needs is captured in `cur` when it starts (6 October 2026). MediaRecorder delivers a stopped
  // chunk a moment later, by which time the next chunk, or at 11:00 the next shift, may already have begun; reading
  // shared state then mixed the two. The chunk's number is reserved at its start and kept across reloads, so a crash
  // leaves a gap in the numbers and never reuses one.
  function startChunk() {
    if (!S.stream || !S.session || S.micLost || S.starting) return;
    if (S.cur && S.cur.rec.state === 'recording') return;                      // one recorder at a time
    const filtered = !!(S.ctxRunning && S.dest);
    const stream = filtered ? S.dest.stream : S.stream;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime || undefined, audioBitsPerSecond: C.AUDIO_BITS_PER_SECOND }); }
    catch (e) { log(`recorder failed: ${e.message}`); setState('error', `Cannot record: ${e.message}`); return; }
    const cur = { rec, chunks: [], startMs: Date.now(), session: S.session, seq: S.chunkSeq, filtered, reason: null };
    S.chunkSeq++; saveSeq(S.session.id);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) cur.chunks.push(e.data); };
    rec.onstop = () => finalizeChunk(cur);
    S.cur = cur; S.rec = rec; S.chunkStartMs = cur.startMs;
    rec.start();
    // Recording from anything but the USB mic stays flagged as no_mic, so the heartbeat and the coverage line show it.
    const fallback = S.micHow !== 'USB name' && S.micHow !== 'fake';
    setState(fallback ? 'no_mic' : 'recording', fallback
      ? `Recording from "${S.micLabel}" because no USB mic was found. ${S.session.id} · chunk #${cur.seq}`
      : `${S.session.id} · chunk #${cur.seq} · mic "${S.micLabel}"${filtered ? '' : ' · raw (no filter)'}`);
    log(`chunk start #${cur.seq} ${filtered ? 'filtered' : 'raw'}`);
    render();
  }
  function stopChunk(reason) { if (S.cur && S.cur.rec.state === 'recording') { S.cur.reason = reason; S.cur.rec.stop(); } }
  async function finalizeChunk(cur) {
    const endMs = Date.now(); const session = cur.session; const seq = cur.seq; const reason = cur.reason || 'boundary';
    const blob = new Blob(cur.chunks, { type: cur.rec.mimeType || 'audio/webm' }); cur.chunks = [];
    if (blob.size === 0) { log(`chunk #${seq} empty, dropped (${reason})`); }
    else {
      const sha = await sha256Hex(blob);
      const shift = session.shift; const period = currentPeriod(shift, cur.startMs);
      const manifest = {
        chunk_id: `${session.id}_${String(seq).padStart(3, '0')}`, session_id: session.id, seq,
        started_at: isoLocal(cur.startMs), ended_at: isoLocal(endMs), mic_label: S.micLabel, bytes: blob.size, sha256: sha,
        page_version: C.PAGE_VERSION, hp_hz: cur.filtered ? C.HP_HZ : 0, mic_lost: reason === 'mic_lost', end_reason: reason,
        device_clock_offset_s: S.clockOffsetS,
        campus_name: S.schedule.campus_name, cohort_code: shift.cohort_code, shift: shift.shift, timetabled: !!S.schedule.timetabled,
        period: period ? { subject: period.subject, mode: period.mode } : null, mime: blob.type, test: !!TEST
      };
      log(`chunk #${seq} done ${(blob.size / 1024).toFixed(0)} KB (${reason})`);
      await enqueue({ kind: 'chunk', id: manifest.chunk_id, session_id: session.id, manifest, blob });
    }
    // keep going: same session, next chunk (unless the session ended, the mic is gone, or another chunk already began)
    if (S.session === session && S.cur === cur && reason !== 'mic_lost' && reason !== 'session_end' && !S.stopping) startChunk();
    render();
  }
  async function sha256Hex(blob) {
    const buf = await blob.arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------ sessions and the tick (3.5, 3.6)
  // Chunk and levels numbers per session, kept in localStorage so a reload mid-shift continues the numbering instead
  // of restarting at 0 and replacing the recordings already made under those names (6 October 2026).
  const seqKey = (sid) => 'obs_seq_' + sid;
  function loadSeq(sid) {
    try { const v = JSON.parse(localStorage.getItem(seqKey(sid))); if (v && Number.isInteger(v.chunk)) return v; } catch (_) {}
    return { chunk: 0, levels: 0 };
  }
  function saveSeq(sid) { try { localStorage.setItem(seqKey(sid), JSON.stringify({ chunk: S.chunkSeq, levels: S.levelsSeq })); } catch (_) {} }
  function forgetOtherDays(date) {
    try { Object.keys(localStorage).filter(k => k.startsWith('obs_seq_') && !k.includes('_' + date + '_')).forEach(k => localStorage.removeItem(k)); } catch (_) {}
  }
  async function beginSession(shift, ms) {
    const date = localParts(ms).date;
    const id = `${S.deviceId}_${date}_${shift.shift}${TEST ? 'T' : ''}`;
    S.session = { id, shift, startedAt: ms }; S.starting = true;              // set first: the next tick must not begin it twice
    S.levels = []; S.lastLevelsFlush = ms;
    // Continue after the highest number already used: the saved counter, or anything of this session still in the
    // upload queue (a page older than this fix saved no counter).
    const saved = loadSeq(id); let qChunk = -1, qLevels = 0;
    try {
      for (const i of await allItems()) {
        if (i.session_id !== id) continue;
        if (i.kind === 'chunk') qChunk = Math.max(qChunk, Number(i.manifest && i.manifest.seq));
        if (i.kind === 'levels') qLevels = Math.max(qLevels, Number(String(i.id).slice(-4)) || 0);
      }
    } catch (_) {}
    S.chunkSeq = Math.max(saved.chunk, qChunk + 1); S.levelsSeq = Math.max(saved.levels, qLevels);
    saveSeq(id); forgetOtherDays(date); S.starting = false;
    log(`session begin ${id} (${S.scheduleSource})${S.chunkSeq ? `, continuing at chunk #${S.chunkSeq}` : ''}`);
    if (S.session && S.session.id === id) startChunk();
  }
  function endSession() {
    if (!S.session) return;
    log(`session end ${S.session.id}`);
    flushLevels(true);
    stopChunk('session_end');
    S.session = null;
    setState('waiting', 'Next shift starts on the timetable.');
    render();
  }
  function onTick(now) {
    S.lastTick = now;
    if (!S.deviceId) return;
    if (now - S.scheduleFetchedAt > C.SCHEDULE_REFRESH_S * 1000) fetchSchedule();
    if (!S.schedule) return;
    const shift = currentShift(now);
    const wantId = shift ? `${S.deviceId}_${localParts(now).date}_${shift.shift}${TEST ? 'T' : ''}` : null;
    if (S.session && S.session.id !== wantId) endSession();
    if (shift && !S.session && S.stream && !S.micLost) beginSession(shift, now);
    if (!shift && !S.session && S.state !== 'no_mic') setState('waiting', `Next shift on the timetable. Mic "${S.micLabel || '–'}".`);
    if (S.session && S.rec && S.rec.state === 'recording' && now - S.chunkStartMs >= chunkMinutes() * 60000) stopChunk('boundary');
    if (S.session && !S.rec && !S.starting && S.stream && !S.micLost) startChunk();
    flushLevels(false);
    // A heartbeat each minute during a shift, every ten minutes outside one: an all-day page made 1,440 files a day.
    const every = (S.session ? C.STATUS_EVERY_S : C.STATUS_IDLE_EVERY_S) * 1000;
    if (now - S.lastStatus >= every) { S.lastStatus = now; sendStatus(); }
    pump();
  }

  // ------------------------------------------------------------------ status (6.4): fire-and-forget, never queued
  async function sendStatus() {
    if (!S.deviceId) return;
    const body = { kind: 'status', device_id: S.deviceId, token: S.token, at: isoLocal(Date.now()), state: S.state,
                   mic_label: S.micLabel, queue_depth: S.queueDepth, queue_bytes: S.queueBytes, page_version: C.PAGE_VERSION,
                   session_id: S.session ? S.session.id : null, detail: S.detail, hidden: document.hidden, ctx_running: S.ctxRunning,
                   schedule_source: S.scheduleSource, clock_offset_s: S.clockOffsetS };
    try {
      const sentAt = Date.now();
      const r = await fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' }, redirect: 'follow' });
      noteServerTime(await r.json(), sentAt);
    } catch (_) { /* status is best effort; the next one comes at the next interval */ }
  }
  // The laptop's clock against the endpoint's (6 October 2026). Sessions are named and timed by the laptop's clock, and
  // a refurbished laptop's can be wrong; the offset travels in every manifest and heartbeat so the error is visible.
  function noteServerTime(j, sentAt) {
    const server = j && Date.parse(j.server_time);
    if (!isFinite(server)) return;
    S.clockOffsetS = Math.round((server - (sentAt + Date.now()) / 2) / 1000);
  }

  // ------------------------------------------------------------------ queue (3.7): IndexedDB, oldest first, one in flight
  function openDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('observer', 1);
      r.onupgradeneeded = () => { const st = r.result.createObjectStore('queue', { keyPath: 'id' }); st.createIndex('created', 'created'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  function tx(mode, fn) {
    return new Promise((res, rej) => { const t = S.db.transaction('queue', mode); const st = t.objectStore('queue'); const out = fn(st); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); });
  }
  async function enqueue(item) {
    item.created = Date.now(); item.attempts = 0; item.next_at = 0;
    await tx('readwrite', st => st.put(item));
    await refreshQueueStats();
    while (S.queueBytes > C.QUEUE_CAP_BYTES) {           // cap: drop the oldest chunk, and say so
      const oldest = await oldestItem(i => i.kind === 'chunk'); if (!oldest) break;
      await tx('readwrite', st => st.delete(oldest.id)); log(`queue over cap: dropped ${oldest.id}`); await refreshQueueStats();
    }
    render();
  }
  async function allItems() { return tx('readonly', st => st.getAll()); }
  async function oldestItem(pred) { const items = (await allItems()).filter(pred || (() => true)).sort((a, b) => a.created - b.created); return items[0] || null; }
  async function refreshQueueStats() { const items = await allItems(); S.queueDepth = items.length; S.queueBytes = items.reduce((n, i) => n + (i.blob ? i.blob.size : JSON.stringify(i).length), 0); }
  // A refusal (the endpoint answered and said no, e.g. bad_token or sha_mismatch) is kept and retried hourly; a
  // temporary failure (no network, no answer, an answer that is not JSON, a reason starting write_failed or
  // config_error) within minutes, up to BACKOFF_CAP_S. In 0.1.1 every refusal but bad_token was retried every ten
  // minutes for ever, re-sending a 20-minute recording ~144 times a day over the campus link (6 October 2026).
  const TEMPORARY = /^(write_failed|config_error|server_error)/;
  async function pump() {
    if (S.inFlight || !S.db || !navigator.onLine) return;
    if (!C.UPLOAD_DURING_CLASS && S.session) return;
    S.inFlight = true;
    try {
      const now = Date.now();
      const item = await oldestItem(i => (i.next_at || 0) <= now);
      if (item) {
        let ack = null, why = null;
        try { ack = await postItem(item); } catch (e) { why = e.message; }
        if (ack && ack.ok) { await tx('readwrite', st => st.delete(item.id)); S.lastUpload = `${item.id} at ${new Date().toTimeString().slice(0, 8)}`; log(`uploaded ${item.id}`); }
        else if (ack && ack.reason && !TEMPORARY.test(ack.reason)) { log(`endpoint refused ${item.id}: ${ack.reason}; kept, tried again hourly`); await defer(item, C.REFUSED_RETRY_S, ack.reason); }
        else { await defer(item, null, why || (ack && ack.reason) || 'no answer'); }
        await refreshQueueStats(); render();
      }
    } catch (e) { log(`queue error: ${e.message}`); }
    finally { S.inFlight = false; }                     // never left set: a stuck flag would stop every upload
  }
  async function defer(item, seconds, why) {
    item.attempts = (item.attempts || 0) + 1;
    const wait = seconds != null ? seconds : Math.min(C.BACKOFF_CAP_S, C.BACKOFF_BASE_S * 2 ** (item.attempts - 1));
    item.next_at = Date.now() + wait * 1000;
    await tx('readwrite', st => st.put(item));
    log(`upload of ${item.id} deferred ${wait}s (attempt ${item.attempts}${why ? ': ' + why : ''})`);
  }
  async function postItem(item) {
    const body = { kind: item.kind, device_id: S.deviceId, token: S.token, id: item.id, session_id: item.session_id };
    if (item.kind === 'chunk') { body.manifest = item.manifest; body.audio_b64 = await blobToBase64(item.blob); }
    if (item.kind === 'levels') { body.rows = item.rows; }
    const sentAt = Date.now();
    const r = await fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' }, redirect: 'follow' });
    const j = await r.json(); noteServerTime(j, sentAt);
    return j;
  }
  function blobToBase64(blob) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); }); }

  // ------------------------------------------------------------------ boot
  async function boot() {
    window.addEventListener('error', (e) => log(`error: ${e.message}`));
    document.addEventListener('visibilitychange', () => log(`tab ${document.hidden ? 'hidden' : 'visible'}`));
    $('btnAllow').onclick = () => openMic();
    loadIdentity(); render();
    S.db = await openDb(); await refreshQueueStats();
    if (S.deviceId) { await fetchSchedule(); await openMic(); }
    S.worker = new Worker('clock-worker.js'); S.worker.postMessage({ tick_s: C.TICK_S });
    S.worker.onmessage = (e) => onTick(e.data.now);
    if (S.stream && S.state !== 'no_mic') setState('waiting', 'Ready. Recording starts on the timetable.');
    render();
  }

  // One recorder per machine (6 October 2026). The Windows setup opens the page from the Startup folder and from
  // Chrome's own startup page, so two tabs are likely, and two recorders would share one session's numbers and one
  // upload queue. The first tab holds a Web Lock; any other tab waits on standby and takes over if the first closes.
  if (navigator.locks) {
    navigator.locks.request('observer-recorder', { ifAvailable: true }, async (lock) => {
      if (lock) { await boot(); return new Promise(() => {}); }                // held for the life of the tab
      setState('standby', 'Another Observer tab on this machine is recording. This tab takes over if that one closes.');
      log('standby: another Observer tab holds the recorder');
      return navigator.locks.request('observer-recorder', async () => {
        log('the other tab closed; taking over');
        await boot(); return new Promise(() => {});
      });
    });
  } else {
    boot();
  }
})();
