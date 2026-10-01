'use strict';
/*
 * Tests automatiques de TIMBRE (sans navigateur, sans dépendance) : node tests/run.js
 * Ils vérifient les mesures sur des voix de synthèse réalistes (justesse, vibrato, diapason, cassures,
 * bruit, densité), les étiquettes et modèles des exercices, le test d'oreille et le programme sur la durée.
 */
const { loadTimbre } = require('./load.js');
const S = require('./synth.js');
const TB = loadTimbre(), D = TB.dsp, M = TB.model, C = TB.catalog, St = TB.state, P = TB.planner;
const ctx = St.ctx(St.newState(), null);

let fails = 0, count = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); count++; console.log('✓ ' + name + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)'); }
  catch (e) { fails++; count++; console.log('✗ ' + name + '\n    ' + (e && e.message)); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'échec'); }
const sustain = (midi, o, so) => S.synth(S.sustainF0(midi, Object.assign({ len: 3 }, o)), Object.assign({ dur: 3.8, vowel: 'a', snr: 40 }, so));

/* ------------------------------------------------------------------ justesse */
test('justesse des tenues : ±5 cents, aucune erreur d’octave (Sol2–La5, a/i/ou, avec et sans vibrato)', () => {
  for (const vowel of ['a', 'i', 'u']) for (const midi of [43, 57, 71, 81]) for (const vib of [0, 40]) {
    const res = D.analyzeTake(sustain(midi, { vibExtent: vib }, { vowel, seed: midi + vib }), S.FS, { type: 'sustain', target: midi, tol: 25 });
    ok(Math.abs(res.err) < 5 && !res.octave, vowel + ' ' + D.noteName(midi) + ' vib ' + vib + ' : erreur ' + res.err + ' c, octave ' + res.octave);
  }
});

test('diapason 442 Hz : un chanteur juste sur le modèle est jugé juste', () => {
  const res = D.analyzeTake(sustain(62, { a4: 442, len: 4 }, { dur: 5 }), S.FS, { type: 'sustain', target: 62, tol: 8, a4: 442 });
  ok(Math.abs(res.err) < 2, 'erreur ' + res.err.toFixed(1) + ' c');
});

test('vibrato sain (5,5 Hz, ±60 c) bien centré : « Juste », pas « la note bouge trop »', () => {
  const res = D.analyzeTake(sustain(64, { vibExtent: 60, len: 5 }, { dur: 6 }), S.FS, { type: 'sustain', target: 64, tol: 20 });
  const j = C.EX.tenue.judge(res, { note: 64, tol: 20, dur: 5, mode: 'modele' }, ctx);
  ok(j.y === 1, 'y = ' + j.y + ' : ' + j.fb.map(f => f.text).join(' / '));
});

/* ------------------------------------------------------------------ mélodies */
function sungMelody(notes, tempo, o) {
  o = o || {};
  const beat = 60 / tempo, lead = 0.05 + 2 * beat + 0.12;
  return S.synth(S.melodyF0(notes, tempo, { start: lead, errs: o.errs }), { dur: lead + notes.length * beat + 1.5, vowel: 'a', snr: 40, seed: o.seed || 1 });
}
test('mélodies : chanteur juste noté juste, note fausse repérée', () => {
  for (const pat of ['p5', 'arp9', 'descTop']) {
    const notes = C.PATTERNS[pat].map(x => 50 + x);
    const res = D.analyzeTake(sungMelody(notes, 100), S.FS, { type: 'notes', targets: notes.map(m => ({ midi: m, dur: 0.6 })), tol: 25 });
    ok(res.score === 1, pat + ' : score ' + res.score);
  }
  const notes = C.PATTERNS.p5.map(x => 50 + x);
  const res = D.analyzeTake(sungMelody(notes, 92, { errs: notes.map((_, i) => (i === 2 ? 60 : 0)) }), S.FS, { type: 'notes', targets: notes.map(m => ({ midi: m, dur: 60 / 92 })), tol: 25 });
  ok(Math.abs(res.notes[2].err - 60) < 10 && res.score < 1, 'note 3 : ' + res.notes[2].err);
});

test('exercice de registre chanté à l’octave : message clair, sans « notes justes » contradictoire', () => {
  const notes = C.PATTERNS.p5.map(x => 62 + x);
  const res = D.analyzeTake(sungMelody(notes.map(m => m - 12), 92, { seed: 3 }), S.FS, { type: 'notes', targets: notes.map(m => ({ midi: m, dur: 60 / 92 })), tol: 25 });
  const j = C.judgeNotes(res, { tol: 25 }, ctx, null, { strictOctave: true });
  ok(res.octave === -12 && j.y === 0, 'octave ' + res.octave + ', y ' + j.y);
  ok(!/^\d+\/\d+ notes justes$/.test(j.fb[0].text) && /octave/.test(j.fb[0].text), j.fb[0].text);
});

/* ------------------------------------------------------------------ sirène */
function glide(o) {
  return t => { const u = t - 0.4, dur = 6; if (u < 0 || u > dur) return 0; const h = dur / 2; let m = u < h ? 48 + 26 * u / h : 74 - 26 * (u - h) / h;
    if (o.jumpAt && u < h && m > o.jumpAt) m += 3; return S.midiToHz(m + (o.vib || 0) / 100 * Math.sin(2 * Math.PI * 5.5 * u)); };
}
test('sirène : aucune fausse cassure sur des glissandos lisses, vraie cassure détectée', () => {
  let falseBreaks = 0;
  for (const vib of [0, 15, 30]) for (const seed of [1, 4, 7]) {
    const r = D.analyzeTake(S.synth(glide({ vib }), { dur: 7, vowel: 'u', snr: 35, seed }), S.FS, { type: 'glide' });
    falseBreaks += r.breaks.length;
  }
  ok(falseBreaks === 0, falseBreaks + ' fausse(s) cassure(s)');
  // saut de 3 demi-tons en montant vers Mi4 (et donc retombée de 3 demi-tons au sommet) : cassure repérée à Mi4
  const r = D.analyzeTake(S.synth(glide({ jumpAt: 64 }), { dur: 7, vowel: 'u', snr: 35, seed: 2 }), S.FS, { type: 'glide' });
  ok(r.breaks.length >= 1 && Math.abs(r.breaks[0].from - 64) < 1.5, 'cassures : ' + r.breaks.map(b => b.from.toFixed(1)).join(','));
});

/* ------------------------------------------------------------------ bruit et souffle */
test('rapport signal/bruit estimé (pièce bruyante signalée)', () => {
  const at = snr => D.analyzeTake(S.synth(S.sustainF0(55, { len: 3, start: 0.7 }), { dur: 4.2, vowel: 'a', snr, seed: snr }), S.FS, { type: 'sustain', target: 55, tol: 25 });
  const a = at(40), b = at(20), c = at(4);
  ok(a.quality.snr > b.quality.snr + 12, 'SNR estimés ' + a.quality.snr + ' / ' + b.quality.snr);
  ok(c.issues.includes('noise') && !a.issues.includes('noise'), 'alerte bruit : ' + c.issues + ' / ' + a.issues);
});

test('voix très soufflée : pas de fausse « mauvaise note »', () => {
  for (const seed of [1, 2, 3]) {
    const x = S.synth(S.sustainF0(59, { len: 3 }), { dur: 3.6, vowel: 'a', snr: 35, breath: 1.5, h1h2: 8.5, tilt: 16.5, seed: 59 * 3 + 15 + seed * 101 });
    const res = D.analyzeTake(x, S.FS, { type: 'sustain', target: 59, tol: 25 });
    const j = C.EX.tenue.judge(res, { note: 59, tol: 25, dur: 3, mode: 'modele' }, ctx);
    ok(j.y == null || Math.abs(res.err) < 100, 'graine ' + seed + ' : y ' + j.y + ', erreur ' + res.err);
  }
});

/* ------------------------------------------------------------------ densité */
function parleChante(midi, o) {
  o = o || {};
  const f = t => (t > 0.7 && t < 1.15 ? S.midiToHz(midi + 0.6 * Math.exp(-(t - 0.7) / 0.1)) : t > 1.5 && t < 6 ? S.midiToHz(midi) : 0);
  const a = S.synth(t => (t < 1.3 ? f(t) : 0), { dur: 6.6, vowel: 'a', snr: 45, seed: midi });
  const b = S.synth(t => (t >= 1.3 ? f(t) : 0), { dur: 6.6, vowel: 'a', snr: null, seed: midi + 1, breath: o.breath || 0, h1h2: 4 + 3 * (o.breath || 0), tilt: 12 + 3 * (o.breath || 0) });
  const x = new Float32Array(a.length); for (let i = 0; i < x.length; i++) x[i] = a[i] + b[i];
  const res = D.analyzeTake(x, S.FS, { type: 'sustain', target: midi, tol: 30, anchor: true });
  return C.EX['parle-chante'].judge(res, { note: midi, vowel: 'a' }, ctx);
}
test('« Du parlé au chanté » : même voix → même densité, à toutes les hauteurs ; tenue soufflée repérée', () => {
  for (const midi of [50, 57, 64, 69]) { const j = parleChante(midi); ok(j.y === 1, D.noteName(midi) + ' : y ' + j.y + ' ' + j.fb.map(f => f.text).join(' / ')); }
  const j = parleChante(60, { breath: 0.5 });
  ok(j.y != null && j.y < 1, 'souffle : y ' + j.y);
});

test('références de densité : on compare à voyelle, volume et bruit comparables', () => {
  const s = St.newState(), ts = Date.parse('2026-10-01T10:00:00');
  for (let i = 0; i < 5; i++) St.addDensity(s, 55, 20 + i * 0.1, ts, { vowel: 'a', snr: 45, levelDb: -20 });
  for (let i = 0; i < 5; i++) St.addDensity(s, 55, 12 + i * 0.1, ts, { vowel: 'ou', snr: 45, levelDb: -20 });
  const ra = St.densityRef(s, 55, { vowel: 'a', levelDb: -20, snr: 45 }), ro = St.densityRef(s, 55, { vowel: 'ou', levelDb: -20, snr: 45 });
  ok(ra.cpps > 19.5 && ro.cpps < 12.6, 'réf a ' + ra.cpps + ', réf ou ' + ro.cpps);
  ok(C.densityVerdict({ cpps: 15, levelDb: -20 }, 55, St.ctx(s, null), { vowel: 'a', snr: 20 }).noisy, 'pièce bruyante non signalée');
});

/* ------------------------------------------------------------------ exercices */
test('étiquettes dans l’ordre chanté, articles d’intervalles, modèles des exercices', () => {
  ok(C.patternSpan('desc', 48) === 'Sol3 → Do3', C.patternSpan('desc', 48));
  ok(C.patternSpan('descTop', 55) === 'Sol4 → Sol3', C.patternSpan('descTop', 55));
  ok(C.patternSpan('p5', 48) === 'Do3 → Sol3', C.patternSpan('p5', 48));
  ok(C.EX.descentes.label({ root: 48, tempo: 92, vowel: 'ya', pattern: 'desc' }).includes('Sol3 → Do3'), 'libellé descentes');
  ok(C.ivDef(6) === 'le triton' && C.ivDef(12) === 'l’octave' && C.ivIndef(6) === 'un triton', 'articles');
  const vfe = C.EX.vfe.steps({ base: 48 }).filter(s => s.t === 'listen' && s.play.kind === 'glide');
  ok(vfe.length === 2 && vfe.every(s => s.play.oneWay), 'glissés VFE à sens unique');
  ok(vfe[0].play.from < vfe[0].play.to && vfe[1].play.from > vfe[1].play.to, 'sens des glissés VFE');
  ok(C.EX.attaques.steps({ note: 55, dyn: 'mf', vowel: 'a' })[0].play.detached, 'attaques détachées');
  ok(C.EX.paille.steps({ sec: 90 }, { profile: { comfortLow: 60 } })[0].play.from === 60, 'échauffement à la tessiture du profil');
});

test('oreille fine (ZEST) : seuil estimé sans biais notable', () => {
  let seed = 11; const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  for (const t75 of [8, 25, 60]) {
    const est = [];
    for (let k = 0; k < 400; k++) {
      const z = C.zest.init(30, 0.8), th = t75 / 0.8714;
      for (let i = 0; i < 24; i++) { const d = C.zest.next(z); C.zest.update(z, d, rnd() < 0.5 + 0.47 * (1 - Math.exp(-Math.pow(d / th, 2)))); }
      est.push(C.zest.estimate(z).threshold);
    }
    const med = D.median(est);
    ok(med > t75 * 0.75 && med < t75 * 1.3, 'seuil ' + t75 + ' c → médiane ' + med.toFixed(1));
  }
});

/* ------------------------------------------------------------------ programme */
test('programme sur 20 semaines : aucun plantage, bilans faits, réussite ≈ 80 %', () => {
  let seed = 3; const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const day0 = Date.parse('2026-10-01T18:00:00'), s = St.newState(day0); s.onboarded = true;
  const truth = {}; M.COMPS.forEach(c => { truth[c.id] = 3 + 4 * rnd(); });
  let succ = 0, graded = 0; const bilans = [];
  for (let day = 0; day < 140; day++) {
    if (rnd() > 5 / 7) continue;
    const ts = day0 + day * 864e5, date = St.today(ts);
    const plan = P.plan(s, { date, checkin: { form: 3, usage: 'normal', symptoms: [] }, rand: rnd });
    const sess = St.startSession(s, plan, ts);
    for (const item of plan.items) {
      if (item.sec && !item.takes) continue;
      const ids = item.mix || [item.ex], n = item.fixed ? item.fixed.length : item.ladder ? 6 : item.takes;
      for (let k = 0; k < n; k++) {
        const ex = C.EX[ids[k % ids.length]], c2 = Object.assign(St.ctx(s, plan), { rangeShift: plan.rangeShift || 0 });
        let params, d;
        if (item.fixed) { params = item.fixed[Math.min(k, item.fixed.length - 1)]; d = ex.difficulty(params, c2); }
        else if (item.ladder) { params = { note: item.ladder.from + k, tol: item.ladder.tol }; d = ex.difficulty(params, c2); }
        else { const ch = C.choose(ex, M.dFor(s.skills[ex.comp].th, plan.targetP), c2, rnd); ok(ch, 'aucun candidat pour ' + ex.id); params = ch.params; d = ch.d; }
        ex.steps(params, c2); ex.label(params, c2);
        const pt = M.pSuccess(truth[ex.comp], d), u = rnd(), y = u < pt ? 1 : u < pt + (1 - pt) / 2 ? 0.5 : 0;   // réussi / presque / raté
        const judged = ex.kind === 'sing' ? { y, success: y === 1, metrics: {} } : { y: null, success: null };
        if (judged.y != null) { graded++; if (judged.success) succ++; }
        St.recordTake(s, { ex: ex.id, params, d, judged, ts }, ts);
        sess.takes.push({ ex: ex.id, params, d, judged });
      }
    }
    St.finishSession(s, sess, ts + 1500000, false);
    if (plan.type === 'B') { const rec = P.concludeBilan(s, sess, plan.bilan, ts); bilans.push(rec.week); if (plan.bilan === 'entree') s.program.start = date; }
  }
  ok([0, 4, 8, 12, 16].every(w => bilans.includes(w)), 'bilans : ' + bilans.join(','));
  ok(succ / graded > 0.65 && succ / graded < 0.9, 'réussite ' + (succ / graded).toFixed(2));
  ok(M.COMPS.every(c => isFinite(s.skills[c.id].th)), 'niveaux non finis');
});

test('correction d’une prise (« Mesure fausse ? ») : comptée une seule fois', () => {
  const s = St.newState(), ts = Date.parse('2026-10-01T10:05:00');
  const take = { ex: 'tenue', params: { note: 55, tol: 25, dur: 3, mode: 'modele' }, d: 3.2, judged: { y: 1, success: true, metrics: { err: 4 } }, res: { ok: true, issues: [], err: 4, snr: 45, voice: { cpps: 12, h1h2: 2, levelDb: -20 }, voiceMidi: 55 }, predicted: 'juste', ts };
  const snap = St.snapshot(s, 'tenue'); St.recordTake(s, take, ts);
  St.restore(s, 'tenue', snap); St.recordTake(s, Object.assign({}, take, { judged: { y: null, success: null }, self: 0.5, res: null, predicted: null }), ts);
  ok(s.items.tenue.n === 1 && !(s.series.tenueErr || []).length && !Object.values(s.dens).flat().length && s.calib.n === 0, 'double compte');
});

console.log('\n' + (count - fails) + '/' + count + ' tests réussis');
process.exit(fails ? 1 : 0);
