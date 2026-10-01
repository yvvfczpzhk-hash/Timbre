'use strict';
/*
 * Tests des modèles sonores dans un vrai moteur Web Audio (Chromium, via Playwright) :
 *   npx playwright install chromium   (une fois)   puis   node tests/browser.js
 * Ils vérifient que chaque note jouée est à la bonne hauteur (seule ou dans une mélodie), que le timbre d'une
 * note ne change pas selon le contexte, le sens des glissés, les attaques détachées et l'absence de saturation.
 */
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require(path.join(process.execPath, '..', '..', 'lib', 'node_modules', 'playwright'))); } catch (e2) {
    console.log('Playwright absent : npm i -D playwright (ou npx playwright install chromium), puis relance.'); process.exit(0);
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForFunction(() => window.TB && TB.audio && TB.dsp);
  const r = await page.evaluate(async () => {
    const A = TB.audio, D = TB.dsp, C = TB.catalog, out = { fails: [] };
    const fail = m => out.fails.push(m);
    const pitchOf = (pcm, sr, a, b) => {
      const tr = D.trackPitch(D.resample(pcm, sr, 16000), {}), v = [];
      for (let t = Math.round(a / tr.hop); t < Math.round(b / tr.hop) && t < tr.n; t++) if (tr.voiced[t]) v.push(tr.midi[t]);
      return D.median(v);
    };
    const peakHz = (pcm, sr, t0) => {
      const N = 8192, a = Math.round(t0 * sr), re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N && a + i < pcm.length; i++) re[i] = pcm[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
      D.fft(re, im, false);
      let bk = 1, bv = 0; for (let k = 1; k < N / 2; k++) { const f = k * sr / N, p = re[k] * re[k] + im[k] * im[k]; if (f < 2000 && p > bv) { bv = p; bk = k; } }
      return bk * sr / N;
    };
    // 1) notes seules, voix et piano : ±2 cents
    for (const timbre of ['voix', 'piano']) for (const m of [45, 52, 60, 67, 76]) {
      const { pcm, sr } = await A.renderOffline({ kind: 'note', midi: m, dur: 1.6 }, { timbre, vowel: 'a' }, 48000);
      const e = (pitchOf(pcm, sr, 0.3, 1.5) - m) * 100;
      if (!(Math.abs(e) < 2)) fail(timbre + ' ' + D.noteName(m) + ' : ' + e.toFixed(1) + ' c');
    }
    // 2) mélodies à la voix : chaque note à ±2 cents
    for (const [pat, root, tempo, vowel] of [['scale9', 50, 160, 'a'], ['arp9', 52, 100, 'goug'], ['octave', 55, 88, 'wi'], ['descTop', 55, 104, 'ou']]) {
      const notes = C.PATTERNS[pat].map(x => root + x), beat = 60 / tempo;
      const { pcm, sr } = await A.renderOffline({ kind: 'seq', notes, tempo }, { timbre: 'voix', vowel }, 48000);
      notes.forEach((m, i) => { const e = (pitchOf(pcm, sr, 0.03 + (i + 0.15) * beat, 0.03 + (i + 0.85) * beat) - m) * 100; if (!(Math.abs(e) < 2)) fail(pat + ' note ' + (i + 1) + ' : ' + e.toFixed(1) + ' c'); });
    }
    // 3) même note, même timbre seule ou en début de mélodie (formants fixes)
    for (const [pat, root, vowel] of [['scale9', 50, 'a'], ['arp9', 50, 'goug']]) {
      const iso = await A.renderOffline({ kind: 'note', midi: root, dur: 1.2 }, { timbre: 'voix', vowel }, 48000);
      const seq = await A.renderOffline({ kind: 'seq', notes: C.PATTERNS[pat].map(x => root + x), tempo: 120 }, { timbre: 'voix', vowel }, 48000);
      const a = peakHz(iso.pcm, 48000, 0.25), b = peakHz(seq.pcm, 48000, 0.05);
      if (Math.abs(a - b) > 15) fail('timbre ' + pat + ' : pic ' + a.toFixed(0) + ' Hz seule, ' + b.toFixed(0) + ' Hz en mélodie');
    }
    // 4) glissés du protocole VFE : montant puis descendant, sans retour
    const gl = C.EX.vfe.steps({ base: 48 }).filter(s => s.t === 'listen' && s.play.kind === 'glide');
    for (const st of gl) {
      const { pcm, sr } = await A.renderOffline(st.play, { timbre: 'voix' }, 16000), d = st.play.dur;
      const p0 = pitchOf(pcm, sr, 0.15, 0.35), p1 = pitchOf(pcm, sr, d - 0.35, d - 0.1);
      if (Math.sign(p1 - p0) !== Math.sign(st.play.to - st.play.from) || Math.abs(p1 - st.play.to) > 1.5) fail(st.label + ' : ' + p0.toFixed(1) + ' → ' + p1.toFixed(1));
    }
    // 5) « Attaques nettes » : 5 notes séparées par de vrais silences
    {
      const st = C.EX.attaques.steps({ note: 55, dyn: 'mf', vowel: 'a' })[0];
      const { pcm, sr } = await A.renderOffline(st.play, { timbre: 'voix', vowel: 'a' }, 16000);
      let gaps = 0, inGap = false, mx = 0; const env = [];
      for (let i = 0; i + 160 <= pcm.length; i += 160) { let e = 0; for (let j = 0; j < 160; j++) e += pcm[i + j] * pcm[i + j]; env.push(e); mx = Math.max(mx, e); }
      for (let k = 30; k < 5 * 100; k++) { const low = env[k] < mx * 1e-3; if (low && !inGap) gaps++; inGap = low; }
      if (gaps < 4) fail('attaques : ' + gaps + ' silences au lieu de 4');
    }
    // 6) volume maximal : forte, mais sans saturer la sortie
    A.setUserVolume(2);
    const { pcm } = await A.renderOffline({ kind: 'seq', notes: [48, 52, 55, 60, 55, 52, 48], tempo: 100 }, { timbre: 'voix', vowel: 'a' }, 48000);
    A.setUserVolume(1);
    let pk = 0; for (const v of pcm) pk = Math.max(pk, Math.abs(v));
    if (!(pk < 1)) fail('saturation à 200 % : crête ' + pk.toFixed(3));
    return out;
  });
  for (const f of r.fails) console.log('✗ ' + f);
  if (errors.length) console.log('✗ erreurs JS : ' + errors.join(' | '));
  console.log(r.fails.length || errors.length ? 'ÉCHEC' : '✓ modèles sonores : hauteur, timbre, glissés, attaques et volume conformes');
  await browser.close();
  process.exit(r.fails.length || errors.length ? 1 : 0);
})();
