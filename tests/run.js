'use strict';
/*
 * Tests automatiques de TIMBRE (sans navigateur, sans dépendance) : node tests/run.js
 * (ONLY=<motif> pour n'en lancer qu'une partie, ex. ONLY="intervalle|durée" node tests/run.js)
 * Ils vérifient les mesures sur des voix de synthèse réalistes (justesse, vibrato, diapason, cassures,
 * bruit, densité), les étiquettes et modèles des exercices, le test d'oreille et le programme sur la durée.
 */
const { loadTimbre } = require('./load.js');
const S = require('./synth.js');
const TB = loadTimbre(), D = TB.dsp, M = TB.model, C = TB.catalog, St = TB.state, P = TB.planner;
const ctx = St.ctx(St.newState(), null);

let fails = 0, count = 0;
const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;     // ONLY=intervalle node tests/run.js
function test(name, fn) {
  if (only && !only.test(name)) return;
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

/* ------------------------------------------------------------- version 1.2 */
const rngOf = seed0 => { let seed = seed0; return () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; }; };

test('intervalle progressif : écouté, puis note de départ, puis nom seul', () => {
  const ex = C.EX.intervalle, base = { root: 50, iv: 7, dir: 1, tol: 35 }, at = mode => Object.assign({ mode }, base);
  const dm = ex.difficulty(at('modele'), ctx), dd = ex.difficulty(at('depart'), ctx), dn = ex.difficulty(at('nom'), ctx);
  ok(dm < dd && dd < dn, 'ordre des difficultés ' + [dm, dd, dn].map(v => v.toFixed(2)).join(' < '));
  const st = ex.steps(at('modele'));
  ok(st[0].play.kind === 'seq' && st[0].play.notes.join() === '50,57', 'modèle : la note de départ puis la quinte');
  ok(/pense à/.test(ex.steps(at('depart'))[1].label) && !/pense à/.test(ex.steps(at('nom'))[1].label), 'chanson-aide retirée au niveau « nom seul »');
  ok(st[1].rec.sec >= 6, 'pas assez de temps pour entendre la 2e note');
  ok(ex.calKey(at('depart')) === 'intervalle' && ex.calKey(at('modele')) === 'intervalle:modele', 'clés d’étalonnage');
});

test('un exercice hors de portée ne fait plus chuter sa compétence (intervalle sans modèle)', () => {
  const rnd = rngOf(17), s = St.newState(), ts0 = Date.parse('2026-10-02T18:00:00');
  s.skills.melodie = M.newSkill(4.3, 0.6);
  const c2 = St.ctx(s, { date: '2026-10-02' });
  for (let k = 0; k < 40; k++) {
    const ts = ts0 + k * 60000;
    // un intervalle « de tête » sur deux : toujours raté ; l'autre prise : écho, réussi selon le vrai niveau (4,3)
    if (k % 2 === 0) St.recordTake(s, { ex: 'intervalle', params: { root: 50, iv: 12, dir: 1, tol: 35, mode: 'depart' }, d: 1.2 + (k % 6) * 0.3, judged: { y: 0, success: false } }, ts);
    else {
      const ch = C.choose(C.EX.echo, M.dFor(s.skills.melodie.th, 0.8), c2, rnd), y = rnd() < M.pSuccess(4.3, ch.d) ? 1 : 0;
      St.recordTake(s, { ex: 'echo', params: ch.params, d: ch.d, judged: { y, success: y === 1 } }, ts);
    }
  }
  ok(s.skills.melodie.th > 3.6, 'mélodie entraînée vers le bas : ' + s.skills.melodie.th.toFixed(2));
  ok(s.offsets.intervalle.b > 1.5 && M.outOfReach(s.offsets.intervalle), 'intervalle non étalonné : b = ' + s.offsets.intervalle.b.toFixed(2));
  const picks = new Set(); for (let i = 0; i < 30; i++) picks.add(C.choose(C.EX.intervalle, M.dFor(s.skills.melodie.th, 0.8), c2, rnd).params.mode);
  ok(picks.size === 1 && picks.has('modele'), 'variante proposée : ' + Array.from(picks).join(','));
  ok(!C.allOutOfReach(C.EX.intervalle, s.offsets, Date.now()), 'la version guidée doit rester disponible');
});

test('phrase de chanson : rien coché = non noté', () => {
  const s = St.newState(), ts = Date.parse('2026-10-04T11:00:00'), th0 = s.skills.scene.th;
  St.recordTake(s, { ex: 'phrase', params: { sec: 20 }, d: 5, judged: { y: null, success: null }, self: null }, ts);
  ok(s.skills.scene.th === th0, 'une phrase sans avis a changé le niveau de scène');
  for (let k = 0; k < 6; k++) St.recordTake(s, { ex: 'phrase', params: { sec: 20 }, d: 5, judged: { y: null, success: null }, self: 0.75 }, ts);
  ok(s.skills.scene.th !== th0, 'une phrase notée doit compter');
});

test('journal des prises : variante et registre gardés', () => {
  const s = St.newState(), ts = Date.parse('2026-10-11T10:00:00');
  const sess = St.startSession(s, { type: 'J', week: 2, minutes: 30 }, ts);
  sess.takes.push({ ex: 'intervalle', params: { root: 50, iv: 7, dir: 1, tol: 35, mode: 'modele' }, d: 1, judged: { y: 1, success: true } });
  sess.takes.push({ ex: 'aigu-tenu', params: { note: 69, tol: 30, reg: 'tete' }, d: 5, judged: { y: 0.5, success: false } });
  sess.takes.push({ ex: 'tenue', params: { note: 55, tol: 25 }, d: 3, judged: { y: 1, success: true } });
  const c = St.finishSession(s, sess, ts + 600000, false);
  ok(c.takes[0].k === 'intervalle:modele' && c.takes[1].reg === 'tete' && c.takes[2].k === undefined, JSON.stringify(c.takes));
  ok(C.REG_CAP.tete === 0.5 && C.REG_CAP.mixte === 1, 'voix de tête = « presque »');
});

test('durée réelle des séances : rythme appris, montée progressive jusqu’aux minutes choisies', () => {
  const rnd = rngOf(5), day0 = Date.parse('2026-10-01T18:00:00'), s = St.newState(day0);
  s.onboarded = true; s.profile.sessionMin = 30; s.program.start = '2026-10-01';
  s.bilans.push({ date: '2026-09-30', week: 0, cycle: 1, kind: 'entree', before: {}, after: {}, measured: [] });
  const est = (plan, pace) => plan.items.reduce((a, it) => a + (it.sec && !it.takes ? it.sec : (it.takes || 1) * (it.mix ? 24 : P.takeSec(C.EX[it.ex])) * pace), 0) / 60;
  const seen = [];
  for (let i = 0; i < 9; i++) {
    const ts = day0 + i * 864e5, plan = P.plan(s, { date: St.today(ts), checkin: { form: 3, usage: 'normal', symptoms: [] }, rand: rnd });
    // ce chanteur enchaîne 35 % plus vite que les estimations
    const sess = St.startSession(s, plan, ts);
    let sec = 0;
    for (const it of plan.items) {
      if (it.sec && !it.takes) { sec += it.sec; sess.takes.push({ ex: it.ex, d: 0, judged: { y: null }, guided: true }); continue; }
      const ids = it.mix || [it.ex];
      for (let k = 0; k < (it.takes || 1); k++) { const ex = C.EX[ids[k % ids.length]]; sec += P.takeSec(ex) * 0.65; sess.takes.push({ ex: ex.id, params: {}, d: 3, judged: { y: 1, success: true } }); }
    }
    sess.activeMs = sec * 1000;
    St.finishSession(s, sess, ts + sess.activeMs, false);
    seen.push({ planned: plan.minutes, real: sec / 60, est: est(plan, P.pace(s)) });
  }
  const last = seen[seen.length - 1];
  ok(Math.abs(P.pace(s) - 0.65) < 0.08, 'rythme estimé ' + P.pace(s).toFixed(2));
  ok(last.planned === 30 && last.real > 25 && last.real < 34, 'séance finale : ' + last.real.toFixed(1) + ' min pour 30 demandées');
  for (let i = 1; i < seen.length; i++) ok(seen[i].real <= Math.max(seen[i - 1].real * 1.35, seen[i - 1].real + 4) + 3, 'montée trop brusque : ' + seen.map(x => x.real.toFixed(0)).join(' → '));
  // aucun bloc de souffle long ou d'aigu ne dépasse son plafond
  const plan = P.plan(s, { date: St.today(day0 + 10 * 864e5), checkin: { form: 3, usage: 'normal', symptoms: [] }, rand: rnd });
  for (const it of plan.items) if (it.ex && C.EX[it.ex].maxTakes) ok(it.takes <= C.EX[it.ex].maxTakes, it.ex + ' × ' + it.takes);
});

test('oreille fine au moins tous les 3 jours', () => {
  const rnd = rngOf(9), day0 = Date.parse('2026-10-01T18:00:00'), s = St.newState(day0);
  s.onboarded = true; s.program.start = '2026-10-01';
  s.bilans.push({ date: '2026-10-01', week: 0, cycle: 1, kind: 'entree', before: {}, after: {}, measured: [] });
  const days = [];
  for (let i = 0; i < 21; i++) {
    const ts = day0 + i * 864e5, plan = P.plan(s, { date: St.today(ts), checkin: { form: 3, usage: 'normal', symptoms: [] }, rand: rnd });
    const sess = St.startSession(s, plan, ts);
    for (const it of plan.items) if (it.ex === 'discri' || (it.mix && it.mix.includes('discri'))) { days.push(i); St.recordTake(s, { ex: 'discri', params: { cents: 30 }, d: 4, judged: { y: null, success: true, metrics: { jnd: 25 } } }, ts); }
    sess.takes.push({ ex: 'tenue', params: {}, d: 3, judged: { y: 1, success: true } });
    sess.activeMs = 20 * 60000;
    St.finishSession(s, sess, ts + sess.activeMs, false);
  }
  const gaps = days.slice(1).map((d, i) => d - days[i]);
  ok(days.length >= 6 && Math.max(...gaps, days[0]) <= 3, 'jours d’oreille fine : ' + days.join(','));
});

test('mise à jour 1.2 : niveaux recalculés depuis le bilan, une seule fois', () => {
  const s = St.newState(Date.parse('2026-09-26T10:00:00'));
  delete s.migr;                                                     // état d'une version précédente
  const before = { oreille: 5, tenue: 5, melodie: 4.15, souffle: 6, densite: 4.1, poitrine: 4.55, passage: 5.35, aigu: 5.85, agilite: 4.5, stabilite: 4.8, scene: 5.1 };
  const after = Object.assign({}, before, { melodie: 4.35, aigu: 8.25, oreille: 4.67 });
  s.bilans.push({ date: '2026-09-28', week: 0, cycle: 1, kind: 'entree', before, after, measured: ['oreille', 'melodie', 'aigu'] });
  const bts = Date.parse('2026-09-28T15:00:00');
  s.sessions.push({ id: 'b', date: '2026-09-28', ts: bts, type: 'B', week: 1, takes: [3.2, 3.6, 4.2, 4.9, 5.6, 6.2, 6.9, 7.5, 8.2].map(d => ({ ex: 'aigu-tenu', d, y: 1, ok: true })), done: true, minutes: 9 });
  const rnd = rngOf(23);
  for (let day = 1; day <= 10; day++) {
    const ts = bts + day * 864e5, takes = [];
    for (let k = 0; k < 6; k++) { const d = 2.6 + rnd() * 1.4, y = rnd() < M.pSuccess(4.3, d) ? 1 : 0; takes.push({ ex: 'echo', d: +d.toFixed(2), y, ok: y === 1 }); }
    for (let k = 0; k < 4; k++) takes.push({ ex: 'intervalle', d: 1.2 + 0.3 * k, y: day < 3 && k === 0 ? 1 : 0, ok: false });
    takes.push({ ex: 'phrase', d: 5, y: null, ok: null, self: 0 });
    takes.push({ ex: 'aigu-tenu', d: 8.2, y: 1, ok: true });
    s.sessions.push({ id: 's' + day, date: St.today(ts), ts, type: 'T', week: 1, takes, done: true, minutes: 14 });
  }
  // niveaux tels que l'ancienne version les avait laissés
  Object.assign(s.skills.melodie, { th: 1.5, sd: 0.45 }); Object.assign(s.skills.scene, { th: 3.4, sd: 0.6 }); Object.assign(s.skills.aigu, { th: 9.8, sd: 0.5 });
  St.migrate(s);
  const ch = s.migr.cal1.changes;
  ok(ch && ch.melodie[0] === 1.5, 'recalcul absent');
  ok(s.skills.melodie.th > 3.4, 'mélodie : ' + s.skills.melodie.th.toFixed(2));
  ok(Math.abs(s.skills.scene.th - 5.1) < 0.25, 'scène : ' + s.skills.scene.th.toFixed(2));
  ok(Math.abs(s.skills.aigu.th - 5.85) < 0.3, 'aigu (registre inconnu) : ' + s.skills.aigu.th.toFixed(2));
  ok(s.offsets.intervalle && s.offsets.intervalle.b > 1, 'intervalle non étalonné');
  const h = s.skills.aigu.hist.map(x => x[0]); ok(h.every((d, i) => !i || d >= h[i - 1]), 'historique dans le désordre : ' + h.join(','));
  const snap = JSON.stringify(s.skills); St.migrate(s);
  ok(JSON.stringify(s.skills) === snap, 'le recalcul doit être fait une seule fois');
  const fresh = St.migrate(St.newState()); ok(fresh.migr.cal1.changes == null, 'un état neuf n’a rien à recalculer');
});

test('programme de 20 semaines avec un exercice mal calibré : la compétence reste juste', () => {
  const rnd = rngOf(31), day0 = Date.parse('2026-10-01T18:00:00'), s = St.newState(day0); s.onboarded = true;
  const truth = {}; M.COMPS.forEach(c => { truth[c.id] = 3 + 4 * rnd(); });
  const misfit = { intervalle: 3.2, 'intervalle:nom': 3.6, vibrato: 2.5 };          // bien plus durs que prévu pour ce chanteur
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
        else if (item.ladder) { params = { note: item.ladder.from + k, tol: item.ladder.tol, reg: 'mixte' }; d = ex.difficulty(params, c2); }
        else { const ch = C.choose(ex, M.dFor(s.skills[ex.comp].th, plan.targetP), c2, rnd); params = ch.params; d = ch.d; }
        const pt = M.pSuccess(truth[ex.comp], d + (misfit[St.calKey(ex, params)] || 0)), u = rnd(), y = u < pt ? 1 : u < pt + (1 - pt) / 2 ? 0.5 : 0;
        const judged = ex.kind === 'sing' ? { y, success: y === 1, metrics: {} } : { y: null, success: null };
        St.recordTake(s, { ex: ex.id, params, d, judged, ts }, ts);
        sess.takes.push({ ex: ex.id, params, d, judged });
      }
    }
    St.finishSession(s, sess, ts + 1500000, false);
    if (plan.type === 'B') { P.concludeBilan(s, sess, plan.bilan, ts); if (plan.bilan === 'entree') s.program.start = date; }
  }
  const e = Math.abs(s.skills.melodie.th - truth.melodie);
  ok(e < 1, 'mélodie estimée ' + s.skills.melodie.th.toFixed(2) + ' pour ' + truth.melodie.toFixed(2));
  ok(s.offsets.intervalle && s.offsets.intervalle.b > 1, 'intervalle sans modèle non repéré comme plus dur');
});

test('« Du parlé au chanté » dans une pièce bruyante, puis ressenti : pas de plantage (1.2.1)', () => {
  // le cas rencontré : densité non jugée (bruit) → ressenti demandé → la séance s'arrêtait sur « value.toFixed »
  const s = St.newState(), p = { note: 57, vowel: 'a' }, c2 = St.ctx(s, null);
  const f = t => (t > 0.5 && t < 0.85) || (t > 1.3 && t < 5.5) ? S.midiToHz(57) : 0;
  const res = D.analyzeTake(S.synth(f, { dur: 6.5, vowel: 'a', snr: 18 }), S.FS, C.EX['parle-chante'].steps(p)[1].rec.spec);
  const j = C.EX['parle-chante'].judge(res, p, c2);
  ok(j.y == null && j.metrics.gap == null, 'le cas doit être « densité non jugée » : y = ' + j.y);
  St.recordTake(s, { ex: 'parle-chante', params: p, d: 2, judged: j, self: 0.5, res: null }, Date.now());
  ok(!(s.series.pcGap || []).length && s.items['parle-chante'].n === 1, 'prise mal enregistrée');
  // aucune série ni densité ne garde une valeur absente
  St.addSeries(s, 'melErr', null); St.addSeries(s, 'jnd', undefined); St.addDensity(s, 57, null);
  ok(!(s.series.melErr || []).length && !(s.series.jnd || []).length && !Object.values(s.dens).flat().length, 'valeur absente enregistrée');
  ok(D.median([null, 3, 5, null, 4]) === 4 && D.mean([null, 2, 4]) === 3, 'médiane/moyenne : null compté comme 0');
});

/* ------------------------------------------------------------- version 1.3 */
const tenor = () => { const s = St.newState(Date.parse('2026-10-01T18:00:00')); s.onboarded = true; s.program.start = '2026-10-01'; s.bilans.push({ date: '2026-10-01', week: 0, cycle: 1, kind: 'entree', before: {}, after: {}, measured: [] }); return s; };
const CK = { form: 3, usage: 'normal', symptoms: [] };

test('zones de hauteur : médium, voix pleine et passage plafonnés, quel que soit le niveau', () => {
  const s = tenor(), p = s.profile, Z = C.zones(St.ctx(s, null));
  ok(Z.medium === 64 && Z.chest === 65 && Z.bridge === 69 && Z.top === 74, 'zones du ténor : ' + JSON.stringify(Z));
  const zoneOf = { tenue: 'medium', echo: 'medium', memoire: 'medium', intervalle: 'medium', attaques: 'medium', 'parle-chante': 'medium', messa: 'medium', vibrato: 'medium', legato: 'medium', agilite: 'medium',
    descentes: 'chest', appel: 'chest', goug: 'bridge', pont: 'bridge', octaves: 'bridge', voyelle: 'bridge' };
  const rnd = rngOf(41);
  for (const lvl of [2, 5, 8, 9.8]) {
    const c2 = St.ctx(s, null);
    for (const [id, zn] of Object.entries(zoneOf)) {
      const ex = C.EX[id], cands = ex.candidates(c2, rnd);
      ok(cands.length > 0, id + ' : aucun candidat');
      const tops = cands.map(q => C.topOf(q));
      ok(Math.max(...tops) <= Z[zn], id + ' dépasse sa zone : ' + D.noteName(Math.max(...tops)) + ' > ' + D.noteName(Z[zn]));
      for (let k = 0; k < 8; k++) { const ch = C.choose(ex, M.dFor(lvl, M.TARGET_P), c2, rnd); ok(ch && C.topOf(ch.params) <= Z[zn] && Number.isFinite(ch.d), id + ' au niveau ' + lvl); ex.steps(ch.params, c2); ex.label(ch.params, c2); }
    }
    // sirène : légère jusqu'à une quarte au-dessus du passage, « a » juste au-dessus
    for (const q of C.EX.sirene.candidates(c2)) ok(q.hi <= (q.vowel === 'a' ? Z.bridge : p.passaggio[1] + 5), 'sirène ' + q.vowel + ' ' + D.noteName(q.hi));
  }
  // voix fatiguée : tout descend, l'aigu aussi
  const tired = C.zones(Object.assign(St.ctx(s, null), { rangeShift: -2 }));
  ok(tired.medium === 62 && tired.chest === 63 && tired.bridge === 67 && tired.top === 70, 'zones voix fatiguée : ' + JSON.stringify(tired));
  // la difficulté ne dépend plus de la hauteur pour monter : chaque exercice du médium a de la marge sans la note
  for (const id of ['attaques', 'legato', 'messa', 'parle-chante', 'descentes']) ok(C.maxDifficulty(C.EX[id], St.ctx(s, null)) >= 4.4, id + ' plafonne trop bas : ' + C.maxDifficulty(C.EX[id], St.ctx(s, null)).toFixed(1));
  // autres voix : mêmes règles
  const b = tenor(); Object.assign(b.profile, { low: 41, comfortLow: 45, passaggio: [59, 64], comfortHigh: 64, high: 69, speech: 47 });
  const cb = St.ctx(b, null), Zb = C.zones(cb);
  for (const [id, zn] of Object.entries(zoneOf)) { const cands = C.EX[id].candidates(cb, rnd); ok(cands.length && Math.max(...cands.map(q => C.topOf(q))) <= Zb[zn], 'baryton, ' + id); }
});

test('séance : l’aigu au milieu, jamais à froid, en nombre de prises plafonné ; la chanson à la fin', () => {
  const rnd = rngOf(77), s = tenor();
  Object.assign(s.profile, { sessionMin: 30 });
  for (const [k, th] of Object.entries({ oreille: 6.5, tenue: 5.2, melodie: 4.7, souffle: 4.8, densite: 5.2, poitrine: 5.8, passage: 6.3, aigu: 8.5, agilite: 5.8, stabilite: 5, scene: 4.9 })) Object.assign(s.skills[k], { th, sd: 0.5 });
  for (const e of C.EXERCISES) if (e.comp) s.items[e.id] = { n: 20, ok: 15, last: Date.parse('2026-10-20T10:00:00'), first: 1 };
  let highMax = 0, highSum = 0, sessions = 0, aiguSeen = 0;
  for (const week of [2, 6, 10, 14]) for (const type of ['T', 'J', 'A']) for (let i = 0; i < 12; i++) {
    const date = St.today(Date.parse('2026-10-01T18:00:00') + ((week - 1) * 7 + 2) * 864e5);
    const plan = P.plan(s, { date, checkin: CK, forceType: type, rand: rnd, minutes: 30 }), c2 = St.ctx(s, plan);
    const main = plan.items.filter(it => it.takes);
    const comps = main.map(it => it.comp), iA = comps.indexOf('aigu');
    ok(plan.highBudget >= 4 && plan.highBudget <= 12, 'budget d’aigu : ' + plan.highBudget);
    if (iA >= 0) {
      aiguSeen++;
      const sungBefore = main.slice(0, iA).filter(it => (it.mix || [it.ex]).some(id => C.EX[id].kind === 'sing')).length;
      ok(sungBefore >= 2, 'aigu trop tôt (' + type + ', S' + week + ') : ' + main.map(it => it.ex || it.mix.join('⇄')).join(' · '));
      ok(comps.filter(c => c === 'aigu').length === 1, 'deux blocs d’aigu');
      const iP = comps.indexOf('passage'); ok(iP < 0 || iP < iA, 'le passage doit précéder l’aigu');
    }
    ok(comps.filter(c => c === 'passage' || c === 'aigu').length <= (type === 'T' ? 2 : 1), 'trop de blocs de registres hauts (' + type + ')');
    if (type === 'J') ok(!comps.includes('aigu') && !comps.includes('passage'), 'registres hauts dans une séance de justesse');
    const iSong = main.findIndex(it => it.ex === 'phrase' || it.ex === 'simulation');
    if (iSong >= 0) ok(main.slice(iSong).every(it => it.comp === 'scene'), 'la chanson doit clore la séance : ' + main.map(it => it.ex || 'mix').join(' · '));
    const ids = main.filter(it => it.ex && it.ex !== 'phrase').map(it => it.ex);                // (le « mélange justesse » reprend exprès tenue, écho, intervalle)
    ok(new Set(ids).size === ids.length, 'exercice en double : ' + ids.join(' · '));
    // déroulé simulé : le plafond d'aigu tient
    let high = 0;
    for (const it of main) {
      const idl = it.mix || [it.ex];
      for (let k = 0; k < it.takes; k++) {
        const ex = C.EX[idl[k % idl.length]]; if (ex.kind !== 'sing' || !ex.comp) continue;
        const ch = C.choose(ex, M.dFor(s.skills[ex.comp].th, plan.targetP), Object.assign({}, c2, { maxNote: high >= plan.highBudget ? C.highFrom(s.profile) : null }), rnd);
        if (ch && C.isHigh(ch.params, s.profile)) high++;
      }
    }
    ok(high <= plan.highBudget, 'plafond d’aigu dépassé : ' + high + ' > ' + plan.highBudget);
    highMax = Math.max(highMax, high); highSum += high; sessions++;
  }
  ok(aiguSeen >= 10, 'bloc d’aigu trop rare pour tester : ' + aiguSeen);
  ok(highMax <= 12 && highSum / sessions < 6, 'prises aiguës par séance : max ' + highMax + ', moyenne ' + (highSum / sessions).toFixed(1));
  // voix fatiguée : pas de bloc d'aigu, budget nul
  const tired = P.plan(s, { date: '2026-10-20', checkin: { form: 2, usage: 'normal', symptoms: [] }, forceType: 'T', rand: rnd });
  ok(tired.highBudget === 0 && !tired.items.some(it => it.comp === 'aigu'), 'voix fatiguée : aigu présent');
});

test('rappel espacé : pas d’aigu sur une voix fatiguée, plafond de blocs de registres hauts respecté', () => {
  const rnd = rngOf(55), s = tenor(), day = Date.parse('2026-10-20T18:00:00');
  for (const e of C.EXERCISES) if (e.comp) s.items[e.id] = { n: 20, ok: 15, last: day - 2 * 864e5, first: 1 };
  for (const c of M.COMPS) Object.assign(s.skills[c.id], { th: 5.5, sd: 0.6, last: day - 2 * 864e5, lastMain: day - 2 * 864e5 });
  // l'aigu et le passage n'ont pas été travaillés depuis 12 jours : ils réclament un rappel
  for (const c of ['aigu', 'passage']) Object.assign(s.skills[c], { last: day - 12 * 864e5, lastMain: day - 12 * 864e5 });
  for (let i = 0; i < 40; i++) {
    for (const [type, form] of [['J', 2], ['J', 3], ['A', 3], ['T', 3], ['T', 2]]) {
      const plan = P.plan(s, { date: '2026-10-20', checkin: { form, usage: 'normal', symptoms: [] }, forceType: type, rand: rnd });
      const comps = plan.items.filter(it => it.takes).map(it => it.comp);
      if (form <= 2) ok(!comps.includes('aigu'), 'aigu proposé sur une voix fatiguée (' + type + ') : ' + comps.join(' · '));
      ok(comps.filter(c => c === 'passage' || c === 'aigu').length <= (type === 'T' ? 2 : 1), 'trop de blocs de registres hauts (' + type + ', forme ' + form + ') : ' + comps.join(' · '));
      const ids = plan.items.filter(it => it.ex && it.ex !== 'phrase').map(it => it.ex);
      ok(new Set(ids).size === ids.length, 'exercice en double : ' + ids.join(' · '));
    }
  }
});

test('bilan manqué : rattrapé pendant les deux semaines suivantes, puis plus proposé', () => {
  const s = tenor(), rnd = rngOf(3);
  // une séance tous les deux jours (pas de pause : une voix en reprise ne passe pas de bilan), sans bilan de semaine 4
  const upTo = d => { for (;;) { const last = s.sessions[s.sessions.length - 1], next = St.today(Date.parse((last ? last.date : '2026-09-30') + 'T12:00:00') + 2 * 864e5); if (next >= d) return; s.sessions.push({ id: 'x' + next, date: next, ts: Date.parse(next + 'T18:00:00'), type: 'T', week: 1, takes: [], done: true, minutes: 20, planned: 20 }); } };
  const typeOn = date => { upTo(date); return P.plan(s, { date, checkin: CK, rand: rnd }).type; };
  ok(typeOn('2026-11-01') === 'B' && typeOn('2026-11-09') === 'B', 'rattrapage en semaines 5 et 6 : ' + typeOn('2026-11-01') + ' / ' + typeOn('2026-11-09'));
  ok(typeOn('2026-11-13') !== 'B', 'semaine 7 : plus de bilan de rattrapage');
  s.bilans.push({ date: '2026-11-09', week: 4, cycle: 1, kind: 'etape', before: {}, after: {}, measured: [] });
  ok(typeOn('2026-11-10') !== 'B', 'bilan fait : plus proposé');
});

test('réussite alignée sur le verdict : 1 réussi, 0,5 presque, 0 raté — pour une note comme pour une mélodie', () => {
  const notes = C.PATTERNS.scale9.map(x => 50 + x), p = { tol: 25 }, spec = { type: 'notes', targets: notes.map(m => ({ midi: m, dur: 0.6 })), tol: 25 };
  const run = errs => C.judgeNotes(D.analyzeTake(sungMelody(notes, 100, { errs }), S.FS, spec), p, ctx);
  const a = run(notes.map(() => 0)); ok(a.y === 1 && a.success === true, 'tout juste : y = ' + a.y);
  const b = run(notes.map((_, i) => (i % 2 === 0 ? 40 : 0)));                    // 9 notes sur 17 un peu fausses
  ok(b.success === false && b.y === 0.5 && b.metrics.score > 0.6 && b.metrics.score < 0.8, 'presque : y = ' + b.y + ', score ' + b.metrics.score.toFixed(2));
  const c = run(notes.map((_, i) => (i % 3 ? 80 : 0)));                          // deux notes sur trois nettement fausses
  ok(c.success === false && c.y === 0, 'raté : y = ' + c.y + ', score ' + c.metrics.score.toFixed(2));
  for (const j of [a, b, c]) ok([0, 0.5, 1].includes(j.y) && (j.y === 1) === (j.success === true), 'y et verdict désaccordés');
  ok(M.TARGET_P === 0.85, 'cible de réussite');
});

test('durée : la montée progressive converge même quand la séance est finie plus vite que prévu', () => {
  // cas réel : 13 min prévues, 10 min réelles, puis de nouveau 13 prévues… la durée ne remontait jamais
  const s = tenor(); s.profile.sessionMin = 30;
  s.bilans.push({ date: '2026-10-29', week: 4, cycle: 1, kind: 'etape', before: {}, after: {}, measured: [] });      // bilan de la semaine 4 fait
  const day0 = Date.parse('2026-11-01T18:00:00'), rnd = rngOf(13), seen = [];
  const push = (i, type, planned, real, nPlan, nDone) => s.sessions.push({ id: 's' + i, date: St.today(day0 + i * 864e5), ts: day0 + i * 864e5, type, week: 5, planned, minutes: real, nPlan, nDone, takes: Array.from({ length: 30 }, () => ({ ex: 'tenue', d: 3, y: 1, ok: true })), done: true, load: 40 });
  push(0, 'J', 10, 9); push(1, 'A', 13, 6); push(2, 'T', 13, 10);              // anciennes séances (sans décompte des prises)
  ok(P.rampMinutes(s) === 18, 'rampe de départ : ' + P.rampMinutes(s));
  for (let i = 3; i < 12; i++) {
    const plan = P.plan(s, { date: St.today(day0 + i * 864e5), checkin: CK, rand: rnd });
    seen.push(plan.minutes);
    const skip = plan.type === 'A';                                               // blocs « chanson » passés : séance écourtée
    push(i, plan.type, plan.minutes, Math.round(plan.minutes * (skip ? 0.45 : 0.78)), 40, skip ? 22 : 40);
  }
  ok(seen[seen.length - 1] === 30, 'durée prévue : ' + seen.join(' → '));
  for (let i = 1; i < seen.length; i++) ok(seen[i] <= Math.max(seen[i - 1] * 1.36 + 1, seen[i - 1] + 5), 'montée trop brusque : ' + seen.join(' → '));
  ok(seen.indexOf(30) <= 6, 'montée trop lente : ' + seen.join(' → '));
  // le plan remplit la durée demandée, au rythme réel (blocs ajoutés si les plafonds de prises brident)
  const plan = P.plan(s, { date: St.today(day0 + 13 * 864e5), checkin: CK, rand: rnd, minutes: 30 }), pace = P.pace(s);
  const est = plan.items.reduce((a, it) => a + (it.sec && !it.takes ? it.sec : (it.takes || 1) * (it.mix ? 24 : P.takeSec(C.EX[it.ex])) * pace), 0) / 60;
  ok(est > 26 && est < 33, 'durée estimée du plan de 30 min : ' + est.toFixed(1));
});

test('fonction vocale (VFE) : au moins tous les trois jours, après l’échauffement ; réussite sans cliquet', () => {
  const rnd = rngOf(19), s = tenor(), day0 = Date.parse('2026-10-01T18:00:00'), days = [];
  s.profile.sessionMin = 25;
  for (let i = 0; i < 16; i++) {
    const ts = day0 + i * 864e5, plan = P.plan(s, { date: St.today(ts), checkin: CK, rand: rnd, minutes: 25 });
    const sess = St.startSession(s, plan, ts), iV = plan.items.findIndex(it => it.ex === 'vfe');
    if (iV >= 0) {
      days.push(i);
      ok(plan.items.slice(0, iV).every(it => it.sec && !it.takes), 'la VFE doit suivre l’échauffement');
      St.recordTake(s, { ex: 'vfe', params: { base: 48 }, d: 5, judged: { y: 1, success: true, metrics: { vfe: 15 + i } } }, ts);
    }
    sess.takes.push({ ex: 'tenue', params: {}, d: 3, judged: { y: 1, success: true } }); sess.activeMs = 20 * 60000;
    St.finishSession(s, sess, ts + sess.activeMs, false);
  }
  const gaps = days.slice(1).map((d, i) => d - days[i]);
  ok(days.length >= 5 && Math.max(...gaps, days[0]) <= 3, 'jours de VFE : ' + days.join(','));
  // une tenue égale à l'habitude est réussie, même si un record récent est plus long
  const s2 = tenor(); [14, 15, 16, 22, 16, 17].forEach((v, i) => St.addSeries(s2, 'vfe', v, day0 + i * 864e5));
  const c2 = St.ctx(s2, null), res = v => [{ mpt: v }, {}, {}, { mpt: 12 }, { mpt: 12 }, { mpt: 12 }, { mpt: 12 }];
  ok(c2.bestVfe === 22 && c2.refVfe === 16, 'références : ' + c2.bestVfe + ' / ' + c2.refVfe);
  const j = v => { const all = res(v); return C.EX.vfe.judge({ mpt: 12 }, { base: 48 }, c2, all); };
  ok(j(16).y === 1 && j(13).y === 0.5 && j(10).y === 0, 'tenue 16/13/10 s : ' + [j(16).y, j(13).y, j(10).y].join(' '));
  ok(/record/.test(j(23).fb[0].text), 'record non signalé');
});

test('pause comptée une seule fois, semaine affichée stable ; séance reprise', () => {
  const s = tenor(), t0 = Date.parse('2026-10-02T18:00:00');
  const mk = ts => St.startSession(s, { type: 'J', week: 1, minutes: 15, items: [{ ex: 'tenue', takes: 5 }] }, ts);
  const a = mk(t0); a.takes.push({ ex: 'tenue', params: {}, d: 3, judged: { y: 1, success: true } }); St.finishSession(s, a, t0 + 6e5, false);
  const back = t0 + 16 * 864e5, date = St.today(back);                           // 16 jours plus tard
  const wBefore = St.programWeek(s, date);
  const b = mk(back); b.takes.push({ ex: 'tenue', params: {}, d: 3, judged: { y: 1, success: true } });
  St.finishSession(s, b, back + 3e5, true);                                      // interrompue…
  ok(s.program.pausedDays === 12, 'pause après interruption : ' + s.program.pausedDays);
  b.takes.push({ ex: 'tenue', params: {}, d: 3, judged: { y: 1, success: true } });
  St.finishSession(s, b, back + 9e5, false);                                     // … puis reprise et terminée
  ok(s.program.pausedDays === 12, 'pause comptée deux fois : ' + s.program.pausedDays);
  ok(s.sessions.length === 2 && s.sessions[1].nDone === 2, 'journal : ' + s.sessions.length + ' séances');
  ok(St.programWeek(s, date) === wBefore, 'semaine avant/après la séance du retour : ' + wBefore + ' → ' + St.programWeek(s, date));
});

test('oreille fine : des réponses au hasard donnent un test « non concluant », qui ne compte pas', () => {
  const rnd = rngOf(5); let inconclusive = 0, valid = 0;
  for (let k = 0; k < 300; k++) {
    const z = C.zest.init(30, 0.8);
    for (let i = 0; i < 24; i++) C.zest.update(z, C.zest.next(z), rnd() < 0.5);
    const e = C.zest.estimate(z), j = C.EX.discri.judge({ threshold: e.threshold, lo80: e.lo80, hi80: e.hi80, correct: e.correct, n: e.n }, { cents: 30 });
    if (j.inconclusive) { inconclusive++; ok(!j.observe && j.y == null && j.success == null, 'test non concluant compté'); }
  }
  for (let k = 0; k < 300; k++) {
    const z = C.zest.init(30, 0.8), th = 20 / 0.8714;
    for (let i = 0; i < 24; i++) { const d = C.zest.next(z); C.zest.update(z, d, rnd() < 0.5 + 0.47 * (1 - Math.exp(-Math.pow(d / th, 2)))); }
    const e = C.zest.estimate(z), j = C.EX.discri.judge({ threshold: e.threshold, lo80: e.lo80, hi80: e.hi80, correct: e.correct, n: e.n }, { cents: 30 });
    if (!j.inconclusive && j.observe) valid++;
  }
  ok(inconclusive / 300 > 0.8, 'hasard repéré dans ' + Math.round(inconclusive / 3) + ' % des cas');
  ok(valid / 300 > 0.97, 'auditeur réel accepté dans ' + Math.round(valid / 3) + ' % des cas');
  ok(Number.isNaN(M.scale(null, M.SCALES.jnd)) && Number.isNaN(M.scale(undefined, M.SCALES.hiss)), 'une mesure absente ne doit pas donner un niveau');
});

test('« Du parlé au chanté » : jugé dans une pièce moyennement calme, pas dans le bruit', () => {
  const s = St.newState(), c2 = St.ctx(s, null);
  for (const vowel of ['a', 'é', 'o']) for (const dur of [5, 7]) {
    const p = { note: 57, vowel, dur }, st = C.EX['parle-chante'].steps(p), spec = st[1].rec.spec;
    ok(st[1].rec.sec === dur + 1.5 && /parlé/.test(st[1].label) && st[1].label.includes('« ' + vowel + ' ! »'), 'étapes ' + vowel + ' ' + dur);
    const f = t => (t > 0.5 && t < 0.85) || (t > 1.3 && t < dur + 0.5) ? S.midiToHz(57) : 0;
    const quiet = C.EX['parle-chante'].judge(D.analyzeTake(S.synth(f, { dur: dur + 1.5, vowel: 'a', snr: 24 }), S.FS, spec), p, c2);
    ok(quiet.y === 1 && Number.isFinite(quiet.metrics.gap), vowel + ' à 24 dB : y = ' + quiet.y + ' · ' + quiet.fb.map(x => x.text).join(' / '));
    ok(quiet.fb.some(x => x.text.includes('« ' + vowel + ' ! »')), 'retour sans la voyelle : ' + quiet.fb.map(x => x.text).join(' / '));
  }
  const p = { note: 57, vowel: 'a' }, spec = C.EX['parle-chante'].steps(p)[1].rec.spec;
  const f = t => (t > 0.5 && t < 0.85) || (t > 1.3 && t < 5.5) ? S.midiToHz(57) : 0;
  const noisy = C.EX['parle-chante'].judge(D.analyzeTake(S.synth(f, { dur: 6.5, vowel: 'a', snr: 12 }), S.FS, spec), p, c2);
  ok(noisy.y == null, 'à 12 dB la densité ne doit pas être jugée : y = ' + noisy.y);
  // tenue soufflée dans une pièce moyennement calme (20 dB réels) : encore repérée
  const fA = t => (t > 1.1 && t < 1.45) ? S.midiToHz(57) : 0, fS = t => (t > 1.9 && t < 6.6) ? S.midiToHz(57) : 0;
  const sa = S.synth(fA, { dur: 7.2, vowel: 'a', seed: 11, breath: 0.02, amp: 0.3 }), sb = S.synth(fS, { dur: 7.2, vowel: 'a', seed: 12, breath: 0.35, h1h2: 10, amp: 0.3 });
  const x = new Float32Array(sa.length), r = S.rngFactory(80); let pw = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) { x[i] = sa[i] + sb[i]; if (fS(i / S.FS) > 0) { pw += x[i] * x[i]; cnt++; } }
  const nz = Math.sqrt(pw / cnt) / Math.pow(10, 20 / 20); for (let i = 0; i < x.length; i++) x[i] += nz * S.gauss(r) * 0.5;
  const br = C.EX['parle-chante'].judge(D.analyzeTake(x, S.FS, spec), p, c2);
  ok(br.y != null && br.y < 1, 'tenue soufflée, pièce moyennement calme : y = ' + br.y + ' · ' + br.fb.map(q => q.text).join(' / '));
});

test('vibrato en trois temps : son droit, ondulation guidée, vibrato libre', () => {
  const ex = C.EX.vibrato, c2 = St.ctx(tenor(), null);
  ok(ex.calKey({ mode: 'droit' }) === 'vibrato:droit' && ex.calKey({ mode: 'onde' }) === 'vibrato:onde' && ex.calKey({ mode: 'libre' }) === 'vibrato' && ex.calKey({}) === 'vibrato', 'clés d’étalonnage');
  const dD = ex.difficulty({ note: 55, mode: 'droit', wob: 18, dur: 4 }, c2), dO = ex.difficulty({ note: 55, mode: 'onde', rate: 3 }, c2), dL = ex.difficulty({ note: 55, mode: 'libre' }, c2);
  ok(dD < dO && dO < dL, 'progression droit < onde < libre : ' + [dD, dO, dL].join(' '));
  // son droit
  const pD = { note: 55, mode: 'droit', wob: 13, dur: 6 }, specD = ex.steps(pD)[1].rec.spec;
  const straight = ex.judge(D.analyzeTake(sustain(55, { len: 6 }, { dur: 7.5 }), S.FS, specD), pD);
  ok(straight.y === 1, 'son droit : y = ' + straight.y + ' · ' + straight.fb.map(x => x.text).join(' / '));
  const wavy = ex.judge(D.analyzeTake(sustain(55, { len: 6, vibExtent: 45, vibDelay: 0.2 }, { dur: 7.5 }), S.FS, specD), pD);
  ok(wavy.y < 1, 'note qui vibre jugée droite : y = ' + wavy.y);
  // ondulation guidée : 2 s droit puis 3, 4 ou 5 oscillations par seconde
  for (const rate of [3, 4, 5]) {
    const pO = { note: 55, mode: 'onde', rate }, st = ex.steps(pO), specO = st[1].rec.spec;
    ok(st[0].play.vibRate === rate && specO.minRate < 3 && specO.split, 'étapes de l’ondulation à ' + rate + ' Hz');
    const good = ex.judge(D.analyzeTake(sustain(55, { len: 6, vibExtent: 45, vibRate: rate, vibDelay: 2.2 }, { dur: 7.5, seed: rate }), S.FS, specO), pO);
    ok(good.y === 1, 'ondulation à ' + rate + ' Hz : y = ' + good.y + ' · ' + good.fb.map(x => x.text).join(' / '));
    const none = ex.judge(D.analyzeTake(sustain(55, { len: 6 }, { dur: 7.5, seed: 9 }), S.FS, specO), pO);
    ok(none.y < 1 && none.fb.some(x => x.kind === 'tip'), 'pas d’ondulation : y = ' + none.y);
  }
  const off = ex.judge(D.analyzeTake(sustain(55, { len: 6, vibExtent: 45, vibRate: 6.5, vibDelay: 2.2 }, { dur: 7.5 }), S.FS, ex.steps({ note: 55, mode: 'onde', rate: 3 })[1].rec.spec), { note: 55, mode: 'onde', rate: 3 });
  ok(off.y === 0.5, 'ondulation trop rapide pour le modèle : y = ' + off.y);
  // vibrato libre : inchangé
  const pL = { note: 55, mode: 'libre' }, free = ex.judge(D.analyzeTake(sustain(55, { len: 6, vibExtent: 50, vibRate: 5.5, vibDelay: 2.6 }, { dur: 7.5 }), S.FS, ex.steps(pL)[1].rec.spec), pL);
  ok(free.y === 1, 'vibrato libre : y = ' + free.y + ' · ' + free.fb.map(x => x.text).join(' / '));
});

test('attaques nettes plus rapides (♩=76, 92) et messa di voce à écart demandé', () => {
  for (const tempo of [60, 76, 92]) {
    const p = { note: 55, dyn: 'mf', vowel: 'é', tempo }, st = C.EX.attaques.steps(p), spec = st[1].rec.spec, beat = 60 / tempo, lead = 0.05 + 2 * beat + 0.15;
    const f = t => { const u = t - lead; if (u < 0) return 0; const i = Math.floor(u / beat); return i < 5 && u - i * beat < 0.6 * beat ? S.midiToHz(55) : 0; };
    const j = C.EX.attaques.judge(D.analyzeTake(S.synth(f, { dur: st[1].rec.sec + 2 * beat, vowel: 'e', snr: 40 }), S.FS, spec), p);
    ok(j.y === 1, 'attaques à ♩=' + tempo + ' : y = ' + j.y + ' · ' + j.fb.map(x => x.text).join(' / '));
  }
  const c2 = St.ctx(tenor(), null);
  ok(C.EX.messa.difficulty({ note: 55, dur: 8, range: 16 }, c2) > C.EX.messa.difficulty({ note: 55, dur: 8, range: 8 }, c2) + 1, 'l’écart demandé doit compter');
  const swell = dB => { const env = t => { const u = Math.max(0, Math.min(1, (t - 0.3) / 6)); return Math.pow(10, (-dB + dB * (1 - Math.abs(2 * u - 1))) / 20); }; return D.analyzeTake(S.synth(S.sustainF0(55, { len: 6 }), { dur: 7.5, vowel: 'a', snr: 45, env }), S.FS, { type: 'sustain', target: 55, tol: 30 }); };
  const r12 = swell(13);
  ok(C.EX.messa.judge(r12, { note: 55, dur: 6, range: 8 }, c2).y === 1, 'écart de 13 dB pour 8 demandés');
  ok(C.EX.messa.judge(r12, { note: 55, dur: 6, range: 20 }, c2).y < 1, 'écart de 13 dB pour 20 demandés');
});

test('justesse signée : séries « trop bas / trop haut », tendance d’un bloc', () => {
  const s = tenor(), ts = Date.parse('2026-10-05T10:00:00');
  [-14, -9, -22, 6, -11].forEach((err, i) => St.recordTake(s, { ex: 'tenue', params: { note: 55, tol: 20, dur: 3, mode: 'modele' }, d: 3, judged: { y: 1, success: true, metrics: { err } } }, ts + i * 1000));
  St.recordTake(s, { ex: 'tenue', params: { note: 55, tol: 20 }, d: 3, judged: { y: 0, success: false, metrics: { err: -180 } } }, ts + 9000);      // fausse note : hors tendance
  St.recordTake(s, { ex: 'echo', params: { root: 50, mel: [0, 2, 4], tol: 25 }, d: 3, judged: { y: 1, success: true, metrics: { bias: -8.123456, meanAbs: 12 } } }, ts + 10000);
  ok(s.series.tenueBias.length === 5 && s.series.tenueBias.map(x => x[1]).join() === '-14,-9,-22,6,-11', 'série des tenues : ' + JSON.stringify(s.series.tenueBias));
  ok(s.series.melBias.length === 1 && s.series.melBias[0][1] === -8.12 && s.series.tenueErr.length === 6, 'série des mélodies');
});

test('mise à jour 1.3 : courbes reconstruites, étalonnage rajeuni, journal allégé — une seule fois', () => {
  const s = St.newState(Date.parse('2026-06-01T10:00:00')); s.onboarded = true;
  delete s.migr.v13;                                                              // état de la version 1.2
  const t0 = Date.parse('2026-06-02T18:00:00');
  for (let i = 0; i < 60; i++) {
    const ts = t0 + i * 2.5 * 864e5, takes = [];
    for (let k = 0; k < 8; k++) takes.push({ ex: 'tenue', d: 3.123456, y: 1, ok: true, self: null, pred: null, m: { err: -12.3456789 + k, inTol: 0.87654321 } });
    for (let k = 0; k < 8; k++) takes.push({ ex: 'appel', d: 4.5, y: 0.75, ok: k % 3 === 0, self: null, pred: null, m: { score: 0.75, bias: -17.123456, meanAbs: 28.7654321, allGood: false } });
    takes.push({ ex: 'phrase', d: 5, y: null, ok: null, self: 0.5 });
    s.sessions.push({ id: 's' + i, date: St.today(ts), ts, type: 'T', week: 1, takes, done: true, minutes: 14, planned: 15, load: 50, checkin: { form: 3, usage: 'normal', symptoms: [], ok: true } });
  }
  s.offsets = { appel: { b: 0.31, n: 44, ema: 0.79, last: t0 }, tenue: { b: 0.01, n: 110, ema: 0.73, last: t0 }, vibrato: { b: 2.03, n: 14, ema: 0.48, last: t0 } };
  const now = s.sessions[59].date, skills = JSON.stringify(s.skills);
  St.compactOld(s, '2026-06-03');                         // rien d'ancien à cette date
  ok(!s.sessions.some(x => x.arch), 'archivage prématuré');
  St.upgrade13(s); s.migr.v13 = { at: now, seen: false };
  ok(s.series.tenueBias.length === 480 && s.series.tenueBias[0][1] === -12.35 && s.series.melBias.length === 480, 'courbes : ' + (s.series.tenueBias || []).length + ' / ' + (s.series.melBias || []).length);
  ok(s.offsets.appel.n === 2 && s.offsets.appel.b === 0.31 && s.offsets.tenue.n === 110, 'étalonnage des exercices note par note');
  ok(s.offsets.vibrato.b === 0 && s.offsets.vibrato.n === 2, 'vibrato libre sur la nouvelle échelle : b = ' + s.offsets.vibrato.b);
  ok(s.sessions[0].takes[0].m.err === -12.35 && s.sessions[0].takes[0].d === 3.12, 'mesures arrondies');
  ok(JSON.stringify(s.skills) === skills, 'les niveaux ne doivent pas bouger');
  const sizeBefore = JSON.stringify(s).length, n = St.compactOld(s, now), arch = s.sessions.filter(x => x.arch);
  ok(n === arch.length && n > 5 && n < 20, 'séances résumées : ' + n);
  ok(arch.every(x => x.takes.length === 0 && x.arch.n === 17 && x.arch.by.tenue[0] === 8 && x.arch.by.tenue[1] === 8 && x.arch.by.appel[1] === 3 && x.arch.m === 17 && x.minutes === 14), 'résumé d’une séance : ' + JSON.stringify(arch[0].arch));
  ok(s.sessions.slice(-40).every(x => !x.arch && x.takes.length === 17), 'les séances récentes gardent leur détail');
  ok(JSON.stringify(s).length < 0.9 * sizeBefore, 'journal non allégé : ' + sizeBefore + ' → ' + JSON.stringify(s).length);
  ok(St.compactOld(s, now) === 0, 'archivage à refaire');
  // les écrans et le planificateur lisent un journal résumé sans erreur
  const plan = P.plan(s, { date: now, checkin: CK, rand: rngOf(3) });
  ok(plan.items.length > 3 && Number.isFinite(P.pace(s)) && P.rampMinutes(s) > 0, 'plan après archivage');
  // croissance : un an à six séances par semaine reste loin de la limite de Safari
  const big = St.newState(Date.parse('2025-11-01T10:00:00'));
  for (let i = 0; i < 312; i++) { const ts = Date.parse('2025-11-02T18:00:00') + i * (7 / 6) * 864e5; big.sessions.push({ id: 's' + i, date: St.today(ts), ts, type: 'T', week: 1, done: true, minutes: 30, planned: 30, load: 90, takes: Array.from({ length: 75 }, (_, k) => ({ ex: 'echo', d: 4.56, y: 1, ok: true, self: null, pred: null, m: { score: 0.94, bias: -8.23, meanAbs: 10.02, allGood: false }, hi: 62 })) }); }
  const before = JSON.stringify(big).length; St.compactOld(big, big.sessions[311].date);
  ok(before > 2500000 && JSON.stringify(big).length < 1200000, 'un an de séances : ' + before + ' → ' + JSON.stringify(big).length + ' caractères');
});

console.log('\n' + (count - fails) + '/' + count + ' tests réussis');
process.exit(fails ? 1 : 0);
