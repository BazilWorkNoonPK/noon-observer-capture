// Observer capture page - clock (DESIGN 3.6, P0 finding of 25 September 2026). A dedicated worker's timer is not
// subject to Chrome's intensive throttling of hidden tabs (a main-thread timer fired 42 s late at Gulshan-e-Yaseen).
// It posts the wall-clock time once a second; the page derives every state change from that time and its schedule.
let tickMs = 1000;
self.onmessage = (e) => {
  if (e.data && e.data.tick_s) tickMs = Math.max(250, e.data.tick_s * 1000);
};
setInterval(() => self.postMessage({ now: Date.now() }), tickMs);
