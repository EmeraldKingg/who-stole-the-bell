// A small synthesized "ding" so we don't need an audio file.
let ctx;

export function ding() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [880, 1320, 1760].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.25 / (i + 1), now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 1.5);
    });
  } catch {
    // Audio can be blocked by the browser; the game works fine without it.
  }
}
