// Observer capture page - level meter (DESIGN 3.3). Runs on the audio thread, so Chrome's hidden-tab timer
// throttling does not touch it. Receives the high-passed mono signal and posts one window every LEVEL_WINDOW_S
// seconds: { t_ms, rms, peak, voiced_fraction }. Linear RMS 0-1, never dB (invariant 3).
class LevelProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = (options && options.processorOptions) || {};
    this.windowFrames = Math.round((p.windowSeconds || 10) * sampleRate);
    this.frameFrames = Math.round(0.1 * sampleRate);          // 100 ms frames for voiced_fraction
    this.voicedFloor = p.voicedFloorRms || 0.01;
    this.reset();
  }
  reset() {
    this.sumSq = 0; this.n = 0; this.peak = 0;
    this.frameSumSq = 0; this.frameN = 0; this.frames = 0; this.voicedFrames = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]; const sq = v * v;
      this.sumSq += sq; this.n++;
      const a = v < 0 ? -v : v; if (a > this.peak) this.peak = a;
      this.frameSumSq += sq; this.frameN++;
      if (this.frameN >= this.frameFrames) {
        const frameRms = Math.sqrt(this.frameSumSq / this.frameN);
        this.frames++; if (frameRms >= this.voicedFloor) this.voicedFrames++;
        this.frameSumSq = 0; this.frameN = 0;
      }
    }
    if (this.n >= this.windowFrames) {
      this.port.postMessage({
        t_ms: Date.now(),
        rms: Math.sqrt(this.sumSq / this.n),
        peak: this.peak,
        voiced_fraction: this.frames ? this.voicedFrames / this.frames : 0
      });
      this.reset();
    }
    return true;
  }
}
registerProcessor('observer-level', LevelProcessor);
