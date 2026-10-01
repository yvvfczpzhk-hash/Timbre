// Synthétiseur de voix chantée réaliste pour tester TIMBRE : source glottale, formants fixes en Hz,
// vibrato, gigue, souffle (bruit d'aspiration) et bruit de pièce.
'use strict';
const FS = 48000;
function rngFactory(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const VOW = {
  a: [[730, 80], [1090, 90], [2440, 120], [3400, 150], [4300, 200]],
  i: [[270, 60], [2290, 100], [3010, 120], [3700, 150], [4300, 200]],
  u: [[300, 60], [870, 80], [2240, 120], [3400, 150], [4300, 200]],
  e: [[400, 70], [2000, 100], [2550, 120], [3500, 150], [4300, 200]],
  o: [[450, 70], [800, 80], [2500, 120], [3400, 150], [4300, 200]],
};
const midiToHz = (m, a4) => (a4 || 440) * Math.pow(2, (m - 69) / 12);
/**
 * f0fn(t) -> Hz (ou 0 = silence). opts: {dur, vowel, tilt (dB/oct au-delà de H1), h1h2 (dB, différence source),
 *   breath (rapport bruit d'aspiration, 0..1), snr (dB, bruit de pièce), jitter (fraction), shimmer (fraction), seed, amp}
 */
function synth(f0fn, o) {
  o = o || {};
  const dur = o.dur || 3, n = Math.round(dur * FS), r = rngFactory(o.seed || 7);
  const src = new Float64Array(n);
  let ph = 0, jit = 0, shim = 0;
  const tilt = o.tilt == null ? 12 : o.tilt, h1h2 = o.h1h2 == null ? 4 : o.h1h2;
  const envFn = o.env || (() => 1);
  for (let i = 0; i < n; i++) {
    const t = i / FS, f = f0fn(t);
    if (!(f > 0)) { ph = 0; src[i] = 0; continue; }
    // jitter/shimmer : marche aléatoire lissée
    jit = 0.995 * jit + 0.005 * gauss(r) * (o.jitter || 0.004) * 14;
    shim = 0.995 * shim + 0.005 * gauss(r) * (o.shimmer || 0.03) * 14;
    const fi = f * (1 + jit);
    ph += 2 * Math.PI * fi / FS; if (ph > 2 * Math.PI * 1e6) ph -= 2 * Math.PI * 1e6;
    let s = 0;
    const K = Math.floor(0.45 * FS / fi);
    for (let k = 1; k <= K; k++) {
      // spectre source : H1 renforcé de h1h2 dB par rapport à la pente, puis -tilt dB/octave
      let a = Math.pow(k, -tilt / 6.02);
      if (k === 1) a *= Math.pow(10, (h1h2 - tilt) / 20);   // H1 − H2 (source) = h1h2 dB
      s += a * Math.sin(k * ph);
    }
    src[i] = s * (1 + shim) * envFn(t);
  }
  // bruit d'aspiration (souffle) : bruit blanc modulé par l'enveloppe
  if (o.breath) {
    let rms = 0; for (let i = 0; i < n; i++) rms += src[i] * src[i]; rms = Math.sqrt(rms / n) || 1;
    for (let i = 0; i < n; i++) if (f0fn(i / FS) > 0) src[i] += o.breath * rms * gauss(r) * envFn(i / FS);
  }
  // filtre de formants (résonateurs de Klatt en cascade), formants fixes en Hz
  const F = VOW[o.vowel || 'a'];
  let y = src;
  for (const [Fc, Bw] of F) {
    const T = 1 / FS, C = -Math.exp(-2 * Math.PI * Bw * T), B = 2 * Math.exp(-Math.PI * Bw * T) * Math.cos(2 * Math.PI * Fc * T), A = 1 - B - C;
    const out = new Float64Array(n); let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) { const v = A * y[i] + B * y1 + C * y2; out[i] = v; y2 = y1; y1 = v; }
    y = out;
  }
  // rayonnement aux lèvres (+6 dB/oct)
  const rad = new Float64Array(n); for (let i = 1; i < n; i++) rad[i] = y[i] - 0.97 * y[i - 1];
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(rad[i]));
  const amp = o.amp || 0.3, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rad[i] / (pk || 1) * amp;
  if (o.snr != null) {
    let p = 0, c = 0; for (let i = 0; i < n; i++) if (f0fn(i / FS) > 0) { p += out[i] * out[i]; c++; }
    const sig = Math.sqrt(p / Math.max(1, c)), nz = sig / Math.pow(10, o.snr / 20);
    let b0 = 0, b1 = 0, b2 = 0;   // bruit rose approx.
    for (let i = 0; i < n; i++) { const w = gauss(r); b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; out[i] += nz * (b0 + b1 + b2 + w * 0.1848) / 3.5; }
  }
  return out;
}
/** Courbe de hauteur : note tenue avec vibrato (rate Hz, extent cents demi-amplitude), attaque optionnelle. */
function sustainF0(midi, o) {
  o = o || {};
  const f = midiToHz(midi + (o.offsetCents || 0) / 100, o.a4), t0 = o.start || 0.3, t1 = t0 + (o.len || 3);
  const ph0 = o.vibPhase || 0;
  return t => {
    if (t < t0 || t > t1) return 0;
    const u = t - t0;
    const vibOn = Math.min(1, Math.max(0, (u - (o.vibDelay == null ? 0.25 : o.vibDelay)) / 0.3));
    const vib = (o.vibExtent || 0) * vibOn * Math.sin(2 * Math.PI * (o.vibRate || 5.5) * u + ph0);
    const scoop = o.scoop ? o.scoop * Math.exp(-u / 0.06) : 0;
    const drift = (o.driftCps || 0) * u;
    return f * Math.pow(2, (vib + scoop + drift) / 1200);
  };
}
/** Suite de notes (midi[]) au tempo, legato ou détaché, à partir de t0. */
function melodyF0(notes, tempo, o) {
  o = o || {};
  const beat = 60 / tempo, t0 = o.start || 0.4, gap = o.detached ? 0.07 : 0;
  return t => {
    const u = t - t0; if (u < 0) return 0;
    const i = Math.floor(u / beat); if (i >= notes.length) return 0;
    const v = u - i * beat; if (v > beat - gap) return 0;
    const tr = o.trans == null ? 0.04 : o.trans;
    let m = notes[i] + (o.errs ? o.errs[i] / 100 : 0);
    if (i > 0 && v < tr && !o.detached) { const prev = notes[i - 1] + (o.errs ? o.errs[i - 1] / 100 : 0); m = prev + (m - prev) * (v / tr); }
    const vib = (o.vibExtent || 0) / 100 * Math.sin(2 * Math.PI * (o.vibRate || 5.5) * u);
    return midiToHz(m + vib, o.a4);
  };
}
function writeWav(path, x, fs) {
  const fsm = require('fs'); const n = x.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(fs, 24); buf.writeUInt32LE(fs * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + 2 * i);
  fsm.writeFileSync(path, buf);
}
module.exports = { FS, synth, sustainF0, melodyF0, midiToHz, writeWav, rngFactory, gauss, VOW };
