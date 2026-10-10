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

console.log('\n' + (count - fails) + '/' + count + ' tests réussis');
process.exit(fails ? 1 : 0);
