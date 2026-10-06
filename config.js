// Observer capture page - configuration. Plain constants; no secrets. Every number here is PROVISIONAL
// (observer/CLAUDE.md rule 6) and is reported in the pilot report. Decisions: Noon_Qalam_Decisions_2026-09-24_Observer.md.
window.OBS_CONFIG = {
  PAGE_VERSION: 'capture@0.1.2',

  // Where chunks, levels and status go. The Apps Script web app URL (endpoint/README.md). Set at deploy time.
  ENDPOINT_URL: 'https://script.google.com/macros/s/AKfycby2SsJmqh99krANRgVxgte3EN2sPTFUi3o3fLhfiMGkCbnvwBg2atMij0L2S4EbQczZ/exec',   // deployed 3 October 2026; every new version of the script keeps this address

  // Recording (DESIGN 3.3, 3.4). O14: 20-minute chunks. HP_HZ: high-pass before metering and recording (P0: 50 Hz mains hum).
  CHUNK_MINUTES: 20,
  AUDIO_BITS_PER_SECOND: 16000,
  HP_HZ: 120,
  LEVEL_WINDOW_S: 10,          // one level row per 10 s (obs_levels)
  VOICED_FLOOR_RMS: 0.01,      // PROVISIONAL: a 100 ms frame above this counts as voiced (voiced_fraction)

  // Timetable (DESIGN 3.5). Used only when the endpoint is unreachable and nothing is cached: invariant 7.
  SCHEDULE_REFRESH_S: 3600,
  DEFAULT_SHIFTS: [
    { shift: 1, start: '08:00', end: '11:00' },
    { shift: 2, start: '11:00', end: '14:00' }
  ],
  TIMEZONE_OFFSET: '+05:00',   // PKT; the page writes local wall-clock times with this offset

  // Upload (DESIGN 3.7). O7: during class by default; a flag moves it to end of shift without a code change.
  UPLOAD_DURING_CLASS: true,
  BACKOFF_BASE_S: 30,
  BACKOFF_CAP_S: 600,
  QUEUE_CAP_BYTES: 150 * 1024 * 1024,   // ~3 days of audio; beyond it the oldest chunk is dropped and logged
  STATUS_EVERY_S: 60,            // a heartbeat each minute during a shift
  STATUS_IDLE_EVERY_S: 600,      // and every ten minutes outside one (0.1.2)
  REFUSED_RETRY_S: 3600,         // an upload the endpoint refused is kept and tried again hourly (0.1.2)
  LEVELS_BATCH_S: 60,

  // Clock (DESIGN 3.6). The worker ticks every second; the page derives state from the clock, never from "a timer fired".
  TICK_S: 1,

  // Mic selection (DESIGN 3.2). The input whose label matches this is the classroom mic; never trust the default.
  MIC_LABEL_PATTERN: /usb/i
};
