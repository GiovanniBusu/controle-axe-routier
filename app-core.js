/* ============================================================
   Logique applicative pure (sans DOM) — construction du modèle,
   génération Excel (data), DXF (texte) et Rapport (HTML).
   Testable en Node (ne dépend que de RoadEngine).
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.AppCore = factory(root.RoadEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (RoadEngine) {
  'use strict';

  const VEHICLES = RoadEngine.NORMALIZED_VEHICLES;

  // ---------- Reconstruction du profil en long (points pour tracé) ----------
  function buildProfileSegments(vertRaw, vertElements) {
    if (!vertRaw || vertRaw.length < 2) return [];
    const segs = [];
    let elev = vertRaw[0].elev;
    for (const el of vertElements) {
      if (el.type === 'Tangente') {
        const elevEnd = elev + el.grade * (el.kmEnd - el.kmStart);
        segs.push({
          type: 'Tangente', status: el.status, checks: el.checks,
          pts: [{ sta: el.kmStart, elev: elev }, { sta: el.kmEnd, elev: elevEnd }],
          kmStart: el.kmStart, kmEnd: el.kmEnd,
        });
        elev = elevEnd;
      } else if (el.type === 'RayonVertical') {
        const L = el.length, gIn = el.gradeIn, gOut = el.gradeOut;
        const pts = [];
        const n = 12;
        for (let i = 0; i <= n; i++) {
          const s = el.kmStart + (L * i) / n;
          const ds = s - el.kmStart;
          const e = elev + gIn * ds + ((gOut - gIn) / (2 * L)) * ds * ds;
          pts.push({ sta: s, elev: e });
        }
        segs.push({
          type: 'RayonVertical', status: el.status, checks: el.checks,
          pts, kmStart: el.kmStart, kmEnd: el.kmEnd, radius: el.radius, shape: el.shape,
        });
        elev = pts[pts.length - 1].elev;
      }
    }
    return segs;
  }

  // ---------- Libellés / couleurs de statut ----------
  const STATUS_LABEL = { ok: 'Conforme', tolerance: 'Tolérance', fail: 'NON CONFORME', info: 'Info' };
  const STATUS_COLORS = { // fg, bg (HTML) — rgb Excel déduits
    ok: ['#1a7f37', '#e6f4ea'], tolerance: ['#9a4b00', '#ffe3c2'], fail: ['#b42318', '#fde8e8'], info: ['#555555', '#eeeeee'],
  };
  const XL_COLORS = { // ARGB sans alpha
    ok: ['006100', 'C6EFCE'], tolerance: ['7F3F00', 'FFC000'], fail: ['9C0006', 'FFC7CE'], info: ['404040', 'EDEDED'],
  };
  const ACI = { ok: 3, tolerance: 30, fail: 1, info: 8 }; // couleurs AutoCAD : vert, orange, rouge, gris

  const CALC_LABELS = {
    horiz: 'Géométrie horizontale', devers: 'Dévers', derapage: 'Dérapage', deltaI: 'Δi (rampe de dévers)',
    vert: 'Géométrie verticale', visib: "Distance de visibilité / d'arrêt", giro: 'Giration', surl: 'Surlargeur',
  };

  function stats(vals) {
    const v = vals.filter(x => x != null && isFinite(x));
    if (!v.length) return null;
    return { min: Math.min.apply(null, v), moy: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max.apply(null, v), n: v.length };
  }
  function findCheck(el, key) { return (el.checks || []).find(c => c.key === key); }

  // ---------- Construction du modèle complet pour un alignement ----------
  function buildModel(alignment, params) {
    const Vp = params.Vp || 80;
    const fTRegime = params.fTRegime || 'ch';
    const fLRegime = params.fLRegime || 'ch_autres';
    const fT = params.fT != null ? params.fT : RoadEngine.suggestFT(Vp, fTRegime);
    const fL = params.fL != null ? params.fL : RoadEngine.suggestFL(Vp, fLRegime);
    const q = params.q != null ? params.q : 0.07; // q_design — dévers max de calcul (7%), pour R_min uniquement
    const tr = params.tr != null ? params.tr : 2.0;
    const vehicleKey = params.vehicleKey || 'Bus12';
    const vehicle = VEHICLES[vehicleKey] || VEHICLES.Bus12;
    const toleranceH = params.toleranceH > 0 ? params.toleranceH : 0; // fraction (tracé en plan)
    const toleranceV = params.toleranceV > 0 ? params.toleranceV : 0; // fraction (profil en long)
    const visibCase = params.visibCase || 'A';
    const largeurVoie = params.largeurVoie > 0 ? params.largeurVoie : 3.0;
    const deltaIMax = params.deltaIMax != null ? params.deltaIMax : 1.5;
    const deltaIMinMode = params.deltaIMinMode || 'formule';
    const calc = Object.assign({}, RoadEngine.CALC_DEFAULT, params.calc || {});

    const horizEval = RoadEngine.evaluateHorizontal(alignment.horiz, {
      Vp, fT, fTRegime, q, tolerance: toleranceH, calc, largeurVoie, deltaIMax, deltaIMinMode,
    });

    const planSegments = horizEval.map(el => {
      let pts = [];
      try { pts = RoadEngine.sampleElement(el); } catch (e) { pts = []; }
      return { type: el.type, status: el.status, checks: el.checks, pts, idx: el.idx, kmStart: el.kmStart, kmEnd: el.kmEnd };
    });

    // Giration : anneau OETV (art. 40) uniquement sous le seuil de rayon (manœuvres), sinon balayage indicatif.
    const giroThreshold = params.giroRadiusThreshold != null ? params.giroRadiusThreshold : 30;
    const gabaritResults = [];
    if (calc.giro) {
      for (const el of horizEval) {
        if (el.type === 'Curve' && el.radius) {
          const sw = RoadEngine.swept(el.radius, vehicle.E, vehicle.L, vehicle.Pa);
          const isGiration = el.radius <= giroThreshold;
          let oetv = null;
          if (isGiration && sw.domainOk) oetv = RoadEngine.checkOETVring(sw.Re, sw.Ri);
          let status;
          if (isGiration) status = !sw.domainOk ? 'fail' : (oetv ? (oetv.ok ? 'ok' : 'fail') : 'info');
          else status = 'info';
          gabaritResults.push({
            idx: el.idx, kmStart: el.kmStart, kmEnd: el.kmEnd, radius: el.radius,
            vehicleKey, vehicleLabel: vehicle.label, isGiration,
            domainOk: sw.domainOk, Ri: sw.Ri, Re: sw.Re, B: sw.B, oetv, status,
          });
        }
      }
    }

    let vertElements = [];
    let profileSegments = [];
    if (alignment.vertRaw && alignment.vertRaw.length >= 2) {
      vertElements = RoadEngine.evaluateVertical(RoadEngine.buildVerticalElements(alignment.vertRaw), { Vp, fL, fLRegime, tr, tolerance: toleranceV, calc, visibCase });
      profileSegments = buildProfileSegments(alignment.vertRaw, vertElements);
    }

    // Surlargeur en courbe (VSS 40 105b). Ra = rayon extérieur de la voie = R_axe + largeur de voie.
    const surlargeurCatKey = params.surlargeurCatKey || 'B';
    const surlargeurResults = [];
    if (calc.surl) {
      for (const el of horizEval) {
        if (el.type === 'Curve' && el.radius) {
          const phiTotalGon = el.delta != null ? Math.abs(el.delta) * (200 / Math.PI) : null;
          const Ra = el.radius + largeurVoie;
          const res = RoadEngine.evaluateSurlargeur(Ra, phiTotalGon, surlargeurCatKey);
          surlargeurResults.push(Object.assign({ idx: el.idx, kmStart: el.kmStart, kmEnd: el.kmEnd, radius: el.radius }, res,
            { status: !res.applicable ? 'info' : (res.dispense ? 'ok' : 'info') }));
        }
      }
    }

    function countStatus(list) {
      const c = { ok: 0, tolerance: 0, fail: 0, info: 0 };
      list.forEach(x => { c[x.status] = (c[x.status] || 0) + 1; });
      return c;
    }
    const curves = horizEval.filter(e => e.type === 'Curve' && findCheck(e, 'devers'));
    const synth = {
      horiz: countStatus(horizEval),
      vert: countStatus(vertElements),
      gabarit: countStatus(gabaritResults),
      surlargeur: countStatus(surlargeurResults),
      devers: stats(curves.map(e => findCheck(e, 'devers').value)),
      deltaI: stats(horizEval.filter(e => e.type === 'Spiral' && e.deltaI != null).map(e => e.deltaI)),
    };

    return {
      name: alignment.name, staStart: alignment.staStart, length: alignment.length,
      computedEnd: alignment.computedEnd,
      params: { Vp, fT, fTRegime, fL, fLRegime, q, tr, vehicleKey, vehicleLabel: vehicle.label, surlargeurCatKey,
        surlargeurCatLabel: (RoadEngine.SURLARGEUR_CATEGORIES[surlargeurCatKey] || RoadEngine.SURLARGEUR_CATEGORIES.B).label,
        toleranceH, toleranceV, visibCase, largeurVoie, deltaIMax, deltaIMinMode, calc, giroRadiusThreshold: giroThreshold },
      horizEval, planSegments,
      gabaritResults, vertElements, profileSegments,
      surlargeurResults,
      synth,
    };
  }

  // ---------- Libellés de détail (tous les contrôles d'un élément) ----------
  function checkIcon(c) {
    if (c.severity === 'info') return 'ℹ';
    return c.state === 'ok' ? '✔' : (c.state === 'tolerance' ? '⚠' : '✖');
  }
  function detailLines(el) {
    return (el.checks || []).map(c => `${checkIcon(c)} ${c.detail}`);
  }
  function detailPlain(el) { return detailLines(el).join('\n'); }

  // Nature des non-conformités (contrôles bloquants hors limite)
  const NATURE = {
    Rmin: 'Rayon < R_min', Amin: 'Paramètre A < R/3', Amax: 'Paramètre A > R',
    S: 'Clothoïdes en S : A1/A2 hors [2/3 ; 3/2]', derapage: 'Dérapage : f_T requis > f_T admissible',
    dImax: 'Δi > Δi_max', dImin: 'Δi < Δi_min',
    RvConf: 'Rv < Rv confort', SD: 'Visibilité insuffisante (S < distance requise)', imax: 'Déclivité > i_max',
  };
  function natureList(el) { // [{txt, state}]
    return (el.checks || []).filter(c => c.severity !== 'info' && c.state !== 'ok')
      .map(c => ({ txt: NATURE[c.key] || c.label, state: c.state }));
  }
  function natureText(el) {
    return natureList(el).map(n => n.txt + (n.state === 'tolerance' ? ' (dans la tolérance)' : '')).join(' ; ');
  }

  function fmt(x, d) { return x == null || !isFinite(x) ? '' : +Number(x).toFixed(d); }

  // Quels blocs / colonnes sont demandés
  function active(p) {
    const c = p.calc;
    return {
      hz: !!(c.horiz || c.devers || c.derapage || c.deltaI), vz: !!(c.vert || c.visib),
      horiz: !!c.horiz, devers: !!c.devers, derapage: !!c.derapage, deltaI: !!c.deltaI,
      vert: !!c.vert, visib: !!c.visib, giro: !!c.giro, surl: !!c.surl,
      sReq: !!(c.visib && (p.visibCase === 'B' || p.visibCase === 'D')),
    };
  }

  function paramsRows(model) {
    const p = model.params, a = active(p);
    const pairs = [['Axe', model.name], ['Vitesse projet Vp', p.Vp + ' km/h']];
    if (a.horiz || a.derapage) pairs.push(['f_T (R_min)', p.fT + ' (' + p.fTRegime + ')']);
    if (a.horiz) pairs.push(['q_design', (p.q * 100).toFixed(0) + ' %']);
    if (a.visib) {
      pairs.push(['f_L (D_a)', p.fL + ' (' + p.fLRegime + ')']);
      pairs.push(['Temps de réaction t', p.tr + ' s']);
      pairs.push(['Cas de visibilité', (RoadEngine.VISIB_CASES[p.visibCase] || RoadEngine.VISIB_CASES.A).label]);
    }
    if (a.deltaI || a.surl) pairs.push(['Largeur de voie', p.largeurVoie + ' m']);
    if (a.deltaI) {
      pairs.push(['Δi max', p.deltaIMax + ' %']);
      pairs.push(['Δi min', p.deltaIMinMode === 'none' ? 'non contrôlé' : '0,1·a = ' + (0.1 * p.largeurVoie).toFixed(2) + ' %']);
    }
    if (a.hz) pairs.push(['Tolérance horizontale', (p.toleranceH * 100).toFixed(1).replace(/\.0$/, '') + ' %']);
    if (a.vz) pairs.push(['Tolérance verticale', (p.toleranceV * 100).toFixed(1).replace(/\.0$/, '') + ' %']);
    if (a.giro) { pairs.push(['Véhicule gabarit', p.vehicleLabel]); pairs.push(['Seuil giration', p.giroRadiusThreshold + ' m']); }
    if (a.surl) pairs.push(['Catégorie surlargeur', p.surlargeurCatLabel]);
    const rows = [];
    for (let i = 0; i < pairs.length; i += 3) {
      const r = [];
      pairs.slice(i, i + 3).forEach(pr => { r.push(pr[0], pr[1]); });
      rows.push(r);
    }
    return rows;
  }

  // Légende adaptée aux calculs demandés : [[titre, description]]
  function legendItems(model) {
    const p = model.params, a = active(p), L = [];
    L.push(['✔ Conforme', 'Toutes les limites respectées']);
    L.push(['⚠ Tolérance', 'Hors limite mais dans la tolérance indiquée (orange)']);
    L.push(['✖ Non conforme', 'Au moins une limite dépassée au-delà de la tolérance (rouge)']);
    L.push(['ℹ Indicatif', 'Valeur de référence sans effet sur le statut']);
    if (a.horiz) L.push(['Géométrie horizontale', 'R ≥ R_min = V²/(127·(f_T+q)) · R/3 ≤ A ≤ R · clothoïdes en S : 2/3 ≤ A1/A2 ≤ 3/2 · L_Gmax = 15·Vp (info : L_Gmin, L arc min, Tab.1 VSS 40 100a)']);
    if (a.devers) L.push(['Dévers', 'p = 2 + 5·R_min(Vp, 7 %)/R, borné [3 % ; 7 %] (information)']);
    if (a.derapage) L.push(['Dérapage', 'f_T requis = V²/(127·R) − p/100 ≤ f_T admissible (TRAN 17.6.3, formule 17.31)']);
    if (a.deltaI) L.push(['Δi (rampe de dévers)', 'Δi = (p2·a2 ± p1·a1)/L (Formule 23.4) ; Δi_min = 0,1·a (Formule 23.5) ≤ Δi ≤ Δi_max']);
    if (a.vert) L.push(['Géométrie verticale', 'Rv ≥ Rv confort = (V/3,6)²/0,8 · |i| ≤ i_max (VSS 40 110) · tv = Rv·|Δi|/2 · fv = tv²/(2·Rv) (info : Rv optimum Tab.2, i_min 0,5 %)']);
    if (a.visib) L.push(['Distances de visibilité', "D_a = V·t/3,6 + V²/(254·(f_L ± i)) · S1 = 2·√Rv (cas A/C), S2 = √(8·Rv) (cas B/D) ≥ D_a (A, C), D_r = 2·D_a (B), D_d (D) — Formule 21.6"]);
    if (a.giro) L.push(['Giration', 'Anneau OETV art. 40 : De ≤ 25,00 m, Di ≥ 10,60 m (rayons ≤ seuil) ; sinon largeur balayée B indicative']);
    if (a.surl) L.push(['Surlargeur', 'e = Ra − √(Ra² − D²), Ra = R + largeur de voie (VSS 40 105b) ; dispense si e ≤ 0,10 m']);
    return L;
  }

  // ---------- Export Excel : données (valeurs, formules, styles) ----------
  // Cellule = primitive | { v, f, status, bold, wrap, head }  — f peut être une fonction (L, r) => formule, L(clé) = lettre de colonne
  function colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  function buildTable(cols, items) {
    // cols : [{k, h, w}] ; items : [{k: valeur|cellule, ...}]
    const idx = {}; cols.forEach((c, i) => { idx[c.k] = colLetter(i); });
    const L = k => idx[k];
    const rows = [cols.map(c => ({ v: c.h, head: true }))];
    items.forEach((it, n) => {
      const r = n + 2;
      rows.push(cols.map(c => {
        const x = it[c.k];
        if (x && typeof x === 'object' && typeof x.f === 'function') return Object.assign({}, x, { f: x.f(L, r) });
        return x == null ? '' : x;
      }));
    });
    return { rows, L, last: items.length + 1, widths: cols.map(c => c.w) };
  }

  function buildWorkbookData(model) {
    const sheets = [];
    const p = model.params, a = active(p);
    const stat = s => ({ v: STATUS_LABEL[s], status: s });

    // ----- Horizontal -----
    let hT = null;
    if (a.hz) {
      const cols = [{ k: 'idx', h: '#', w: 5 }, { k: 'type', h: 'Type', w: 20 }, { k: 'd', h: 'Chaînage début (m)', w: 14 }, { k: 'f', h: 'Chaînage fin (m)', w: 14 },
        { k: 'len', h: 'Longueur (m)', w: 12 }, { k: 'ra', h: 'Rayon R / paramètre A (m)', w: 16 }];
      if (a.horiz) cols.push({ k: 'ang', h: 'Angle au centre (gon)', w: 14 });
      if (a.devers) cols.push({ k: 'dv', h: 'Dévers p (%)', w: 11 });
      if (a.derapage) cols.push({ k: 'ft', h: 'f_T requis', w: 11 });
      if (a.deltaI) cols.push({ k: 'di', h: 'Δi (%)', w: 10 }, { k: 'dmin', h: 'Δi min (%)', w: 10 }, { k: 'dmax', h: 'Δi max (%)', w: 10 });
      cols.push({ k: 'st', h: 'Statut', w: 15 }, { k: 'nat', h: 'Nature des non-conformités', w: 38 }, { k: 'det', h: 'Détail des contrôles', w: 80 });
      const items = model.horizEval.map(el => {
        const dv = findCheck(el, 'devers'), dr = findCheck(el, 'derapage');
        return {
          idx: el.idx, type: RoadEngine.typeLabelFR(el.type), d: fmt(el.kmStart, 2), f: fmt(el.kmEnd, 2),
          len: { v: fmt(el.kmEnd - el.kmStart, 2), f: (L, r) => `${L('f')}${r}-${L('d')}${r}` },
          ra: el.radius != null ? fmt(el.radius, 2) : (el.A != null ? fmt(el.A, 2) : ''),
          ang: el.type === 'Curve' && el.delta != null ? fmt(Math.abs(el.delta) * 200 / Math.PI, 4) : '',
          dv: dv ? fmt(dv.value, 2) : '', ft: dr ? fmt(dr.value, 3) : '',
          di: el.deltaI != null ? fmt(el.deltaI, 3) : '', dmin: el.deltaIMin != null ? fmt(el.deltaIMin, 3) : '', dmax: el.deltaIMax != null ? fmt(el.deltaIMax, 3) : '',
          st: stat(el.status), nat: { v: natureText(el), wrap: true }, det: { v: detailPlain(el), wrap: true },
        };
      });
      hT = buildTable(cols, items);
    }
    // ----- Vertical -----
    let vT = null;
    if (a.vz && model.vertElements.length) {
      const cols = [{ k: 'idx', h: '#', w: 5 }, { k: 'type', h: 'Type', w: 22 }, { k: 'd', h: 'Chaînage début (m)', w: 14 }, { k: 'f', h: 'Chaînage fin (m)', w: 14 },
        { k: 'len', h: 'Longueur (m)', w: 12 }, { k: 'rv', h: 'Rv (m)', w: 11 }, { k: 'gi', h: 'Déclivité entrée (%)', w: 13 }, { k: 'go', h: 'Déclivité sortie (%)', w: 13 }];
      if (a.vert) cols.push({ k: 'tv', h: 'Tangente tv (m)', w: 12 }, { k: 'fv', h: 'Flèche fv (m)', w: 11 });
      if (a.visib) { cols.push({ k: 'da', h: "Distance d'arrêt D_a (m)", w: 15 }, { k: 'sd', h: 'Distance de visibilité S (m)', w: 17 }); if (a.sReq) cols.push({ k: 'sr', h: 'Distance requise D_r / D_d (m)', w: 17 }); }
      cols.push({ k: 'st', h: 'Statut', w: 15 }, { k: 'nat', h: 'Nature des non-conformités', w: 38 }, { k: 'det', h: 'Détail des contrôles', w: 80 });
      const items = model.vertElements.map(el => {
        const rc = el.type === 'RayonVertical';
        return {
          idx: el.idx, type: RoadEngine.typeLabelFR(el.type), d: fmt(el.kmStart, 2), f: fmt(el.kmEnd, 2),
          len: { v: fmt(el.kmEnd - el.kmStart, 2), f: (L, r) => `${L('f')}${r}-${L('d')}${r}` },
          rv: rc ? fmt(el.radius, 1) : '', gi: fmt((rc ? el.gradeIn : el.grade) * 100, 3), go: fmt((rc ? el.gradeOut : el.grade) * 100, 3),
          tv: rc ? { v: fmt(el.tv, 2), f: (L, r) => `${L('rv')}${r}*ABS(${L('go')}${r}-${L('gi')}${r})/100/2` } : '',
          fv: rc ? { v: fmt(el.fv, 3), f: (L, r) => `${L('tv')}${r}^2/(2*${L('rv')}${r})` } : '',
          da: el.sA != null ? fmt(el.sA, 1) : '',
          sd: el.sD != null ? { v: fmt(el.sD, 1), f: (L, r) => (el.visibCase && el.visibCase.sCase === 2 ? `SQRT(8*${L('rv')}${r})` : `2*SQRT(${L('rv')}${r})`) } : '',
          sr: rc && el.sReq != null ? fmt(el.sReq, 1) : '',
          st: stat(el.status), nat: { v: natureText(el), wrap: true }, det: { v: detailPlain(el), wrap: true },
        };
      });
      vT = buildTable(cols, items);
    }

    // ----- Synthèse -----
    const rng = (sh, T, k) => `${sh}!$${T.L(k)}$2:$${T.L(k)}$${Math.max(T.last, 2)}`;
    const counts = (sh, T, o) => ['Conforme', 'Tolérance', 'NON CONFORME', 'Info'].map((lab, i) => {
      const key = ['ok', 'tolerance', 'fail', 'info'][i];
      return { v: o[key] || 0, f: `COUNTIF(${rng(sh, T, 'st')},"${lab}")` };
    });
    const H = (t) => ({ v: t, head: true });
    const synthRows = [[H('Paramètres de contrôle'), H(''), H(''), H(''), H(''), H('')]];
    paramsRows(model).forEach(r => synthRows.push(r.map((c, i) => (i % 2 === 0 ? { v: c, bold: true } : c))));
    synthRows.push([]);
    synthRows.push([H('Contrôle'), H('Conforme'), H('Tolérance'), H('Non conforme'), H('Info')]);
    if (hT) synthRows.push(['Tracé en plan (horizontal)'].concat(counts('Horizontal', hT, model.synth.horiz)));
    if (vT) synthRows.push(['Profil en long (vertical)'].concat(counts('Vertical', vT, model.synth.vert)));
    if (a.giro && model.gabaritResults.length) synthRows.push(['Gabarit / giration', model.synth.gabarit.ok || 0, '', model.synth.gabarit.fail || 0, model.synth.gabarit.info || 0]);
    if (a.surl && model.surlargeurResults.length) synthRows.push(['Surlargeur (dispensées / info)', model.synth.surlargeur.ok || 0, '', '', model.synth.surlargeur.info || 0]);
    const sd = model.synth.devers, si = model.synth.deltaI;
    if (hT && (a.devers || a.deltaI)) {
      synthRows.push([]);
      synthRows.push([H('Statistiques'), H('Minimum'), H('Moyen'), H('Maximum')]);
      const stRow = (lab, s, k, d) => synthRows.push([lab,
        s ? { v: fmt(s.min, d), f: `MIN(${rng('Horizontal', hT, k)})` } : '', s ? { v: fmt(s.moy, d), f: `AVERAGE(${rng('Horizontal', hT, k)})` } : '', s ? { v: fmt(s.max, d), f: `MAX(${rng('Horizontal', hT, k)})` } : '']);
      if (a.devers) stRow('Dévers p (%)', sd, 'dv', 2);
      if (a.deltaI) stRow('Δi (%)', si, 'di', 3);
    }
    synthRows.push([]);
    synthRows.push([H('Légende'), H('Signification'), H(''), H(''), H(''), H('')]);
    legendItems(model).forEach((l, i) => {
      const st = ['ok', 'tolerance', 'fail', 'info'][i];
      synthRows.push([st ? { v: l[0], status: st } : { v: l[0], bold: true }, { v: l[1], wrap: true }]);
    });
    sheets.push({ name: 'Synthèse', rows: synthRows, cols: [30, 40, 26, 22, 24, 30], merges: 'legend' });
    if (hT) sheets.push({ name: 'Horizontal', rows: hT.rows, cols: hT.widths, freeze: true });
    if (vT) sheets.push({ name: 'Vertical', rows: vT.rows, cols: vT.widths, freeze: true });

    if (a.giro && model.gabaritResults.length) {
      const gRows = [['#', 'Chaînage', 'Rayon (m)', 'Giration (R≤seuil) ?', 'Véhicule', 'Ri (m)', 'Re (m)', 'Largeur balayée B (m)', 'De anneau (m)', 'Di anneau (m)', 'Statut'].map(h => ({ v: h, head: true }))];
      model.gabaritResults.forEach((g, k) => {
        const r = k + 2;
        gRows.push([
          g.idx, fmt(g.kmStart, 2), fmt(g.radius, 2), g.isGiration ? 'Oui' : 'Non (courant)', g.vehicleLabel,
          g.Ri != null ? fmt(g.Ri, 2) : 'hors domaine', g.Re != null ? fmt(g.Re, 2) : 'hors domaine',
          g.B != null ? { v: fmt(g.B, 2), f: `G${r}-F${r}` } : '',
          g.oetv ? { v: fmt(g.oetv.De, 2), f: `2*G${r}` } : '', g.oetv ? { v: fmt(g.oetv.Di, 2), f: `2*F${r}` } : '',
          stat(g.status),
        ]);
      });
      sheets.push({ name: 'Gabarit', rows: gRows, cols: [5, 11, 11, 18, 22, 10, 10, 18, 14, 14, 15], freeze: true });
    }

    if (a.surl && model.surlargeurResults.length) {
      const slRows = [['#', 'Chaînage', 'Rayon axe (m)', 'Largeur voie (m)', 'Ra = R + largeur (m)', 'Catégorie', 'D (m)', 'e max (m)', 'Φ_Grenz (gon)', 'Dispensée ?', 'Détail'].map(h => ({ v: h, head: true }))];
      model.surlargeurResults.forEach((s, k) => {
        const r = k + 2;
        slRows.push([
          s.idx, fmt(s.kmStart, 2), fmt(s.radius, 2), p.largeurVoie, { v: fmt(s.radius + p.largeurVoie, 2), f: `C${r}+D${r}` },
          s.category ? s.category.label : '', s.D != null ? s.D : '',
          s.e != null ? { v: fmt(s.e, 3), f: `E${r}-SQRT(E${r}^2-G${r}^2)` } : '', s.phiGrenz != null ? fmt(s.phiGrenz, 1) : '',
          s.applicable ? (s.dispense ? 'Oui' : 'Non') : 'Hors domaine',
          { v: s.applicable ? s.detail : s.reason, wrap: true },
        ]);
      });
      sheets.push({ name: 'Surlargeur', rows: slRows, cols: [5, 11, 13, 12, 16, 40, 8, 11, 13, 14, 80], freeze: true });
    }
    return sheets;
  }

  // Construit un classeur SheetJS stylé (xlsx-js-style) à partir de buildWorkbookData.
  function buildWorkbook(XLSX, model) {
    const wb = XLSX.utils.book_new();
    const thin = { style: 'thin', color: { rgb: 'BFBFBF' } };
    const border = { top: thin, bottom: thin, left: thin, right: thin };
    buildWorkbookData(model).forEach(sh => {
      const ws = {};
      let maxC = 0;
      sh.rows.forEach((row, r) => {
        row.forEach((cell, c) => {
          if (cell === '' || cell == null || (typeof cell === 'object' && cell.v === '' && !cell.head && !cell.f)) return;
          const o = (typeof cell === 'object') ? cell : { v: cell };
          const z = { v: o.v };
          z.t = typeof o.v === 'number' ? 'n' : 's';
          if (o.f) z.f = o.f;
          const st = { alignment: { vertical: 'top', wrapText: !!o.wrap }, border };
          if (o.head) { st.font = { bold: true, color: { rgb: 'FFFFFF' } }; st.fill = { patternType: 'solid', fgColor: { rgb: '1A3C6E' } }; st.alignment.wrapText = true; st.alignment.vertical = 'center'; }
          if (o.bold) st.font = { bold: true };
          if (o.status) { const col = XL_COLORS[o.status] || XL_COLORS.info; st.font = { bold: true, color: { rgb: col[0] } }; st.fill = { patternType: 'solid', fgColor: { rgb: col[1] } }; st.alignment.horizontal = 'center'; }
          z.s = st;
          ws[XLSX.utils.encode_cell({ r, c })] = z;
          if (c > maxC) maxC = c;
        });
      });
      ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(sh.rows.length - 1, 0), c: maxC } });
      if (sh.cols) ws['!cols'] = sh.cols.map(w => ({ wch: w }));
      if (sh.freeze) ws['!views'] = [{ state: 'frozen', ySplit: 1 }];
      if (sh.merges === 'legend') { // la description de légende occupe les colonnes B à F
        const start = sh.rows.findIndex(r => r[0] && r[0].v === 'Légende');
        ws['!merges'] = [];
        for (let r = start; r < sh.rows.length; r++) ws['!merges'].push({ s: { r, c: 1 }, e: { r, c: 5 } });
      }
      XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
    });
    return wb;
  }

  // ---------- Export Rapport (HTML autonome) ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function statusBadge(status) {
    const lab = STATUS_LABEL[status] || STATUS_LABEL.info;
    const [fg, bg] = STATUS_COLORS[status] || STATUS_COLORS.info;
    return `<span style="color:${fg};background:${bg};padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap;">${lab}</span>`;
  }
  function detailHTML(el) {
    const items = (el.checks || []).map(c => {
      const col = c.severity === 'info' ? '#555' : (STATUS_COLORS[c.state] || STATUS_COLORS.info)[0];
      return `<li style="color:${col};">${checkIcon(c)} ${esc(c.detail)}</li>`;
    });
    return items.length ? `<ul class="det">${items.join('')}</ul>` : '—';
  }
  function natureHTML(el) {
    const l = natureList(el);
    if (!l.length) return '—';
    return `<ul class="det">${l.map(n => `<li style="color:${STATUS_COLORS[n.state][0]};font-weight:600;">${n.state === 'tolerance' ? '⚠' : '✖'} ${esc(n.txt)}${n.state === 'tolerance' ? ' (dans la tolérance)' : ''}</li>`).join('')}</ul>`;
  }

  function buildReportHTML(model) {
    const now = new Date().toISOString().slice(0, 10);
    const p = model.params, a = active(p);
    function tableRows(rows) { return rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join(''); }
    const n = (x, d) => x == null || !isFinite(x) ? '—' : Number(x).toFixed(d);
    const th = cols => '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>';

    // Horizontal
    const hCols = ['#', 'Type', 'Chaînage début', 'Chaînage fin', 'Longueur (m)', 'R / A (m)'];
    if (a.devers) hCols.push('Dévers p'); if (a.derapage) hCols.push('f_T requis'); if (a.deltaI) hCols.push('Δi');
    hCols.push('Statut', 'Nature des non-conformités', 'Détail des contrôles');
    const hRows = model.horizEval.map(el => {
      const dv = findCheck(el, 'devers'), dr = findCheck(el, 'derapage');
      const r = [el.idx, RoadEngine.typeLabelFR(el.type), n(el.kmStart, 2), n(el.kmEnd, 2), n(el.length, 2),
        el.radius != null ? 'R = ' + n(el.radius, 1) : (el.A != null ? 'A = ' + n(el.A, 1) : '—')];
      if (a.devers) r.push(dv ? n(dv.value, 2) + ' %' : '—');
      if (a.derapage) r.push(dr ? n(dr.value, 3) : '—');
      if (a.deltaI) r.push(el.deltaI != null ? n(el.deltaI, 3) + ' %' : '—');
      r.push(statusBadge(el.status), natureHTML(el), detailHTML(el));
      return r;
    });
    // Vertical
    const vCols = ['#', 'Type', 'Chaînage début', 'Chaînage fin', 'Longueur (m)', 'Rv (m) / i'];
    if (a.vert) vCols.push('tv (m)', 'fv (m)');
    if (a.visib) { vCols.push("Distance d'arrêt D_a (m)", 'Distance de visibilité S (m)'); if (a.sReq) vCols.push('Distance requise D_r / D_d (m)'); }
    vCols.push('Statut', 'Nature des non-conformités', 'Détail des contrôles');
    const vRows = model.vertElements.map(el => {
      const r = [el.idx, RoadEngine.typeLabelFR(el.type), n(el.kmStart, 2), n(el.kmEnd, 2), n(el.length, 2),
        el.radius != null ? 'Rv = ' + n(el.radius, 0) : 'i = ' + n(el.grade * 100, 2) + ' %'];
      if (a.vert) r.push(el.tv != null ? n(el.tv, 2) : '—', el.fv != null ? n(el.fv, 3) : '—');
      if (a.visib) { r.push(el.sA != null ? n(el.sA, 1) : '—', el.sD != null ? n(el.sD, 1) : '—'); if (a.sReq) r.push(el.type === 'RayonVertical' ? n(el.sReq, 1) : '—'); }
      r.push(statusBadge(el.status), natureHTML(el), detailHTML(el));
      return r;
    });
    const gRows = model.gabaritResults.map(g => [
      g.idx, n(g.kmStart, 2), n(g.radius, 1), g.isGiration ? 'Oui' : 'Non', esc(g.vehicleLabel),
      g.B != null ? n(g.B, 2) : '—', statusBadge(g.status)]);
    const slRows = (model.surlargeurResults || []).map(s => [
      s.idx, n(s.kmStart, 2), n(s.radius, 1), s.applicable && s.e != null ? n(s.e, 3) + ' m' : '—',
      statusBadge(s.status), esc(s.applicable ? s.detail : s.reason)]);

    const meta = paramsRows(model).map(r => {
      let h = '<tr>';
      for (let i = 0; i < r.length; i += 2) h += `<th>${esc(r[i])}</th><td>${esc(r[i + 1])}</td>`;
      return h + '</tr>';
    }).join('');
    const calcOn = Object.keys(CALC_LABELS).filter(k => p.calc[k]).map(k => CALC_LABELS[k]).join(' · ');
    const sd = model.synth.devers, si = model.synth.deltaI;
    const statRow = (lab, s, d, u) => `<tr><th>${lab}</th><td>${s ? n(s.min, d) + ' ' + u : '—'}</td><td>${s ? n(s.moy, d) + ' ' + u : '—'}</td><td>${s ? n(s.max, d) + ' ' + u : '—'}</td></tr>`;
    const card = (lab, c) => {
      const tot = (c.ok || 0) + (c.tolerance || 0) + (c.fail || 0);
      return `<div class="card">${lab}<br><b>${c.ok || 0} / ${tot}</b>conformes${c.tolerance ? ` · <span style="color:#9a4b00;font-weight:600">${c.tolerance} en tolérance</span>` : ''}${c.fail ? ` · <span style="color:#b42318;font-weight:600">${c.fail} non conf.</span>` : ''}</div>`;
    };
    const stats = (a.devers ? statRow('Dévers p', sd, 2, '%') : '') + (a.deltaI ? statRow('Δi (rampe de dévers)', si, 3, '%') : '');
    const legend = legendItems(model).map((l, i) => {
      const st = ['ok', 'tolerance', 'fail', 'info'][i];
      return `<tr><td style="white-space:nowrap;">${st ? statusBadge(st) : '<b>' + esc(l[0]) + '</b>'}</td><td>${esc(l[1])}</td></tr>`;
    }).join('');

    return `<!doctype html><html><head><meta charset="utf-8"><title>Rapport — Axe ${esc(model.name)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#222;max-width:1100px;margin:30px auto;padding:0 20px;}
h1{font-size:22px;border-bottom:3px solid #1a3c6e;padding-bottom:8px;}
h2{font-size:17px;color:#1a3c6e;margin-top:28px;}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;}
td{padding:4px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top;}
th{background:#1a3c6e;color:#fff;text-align:left;padding:6px 8px;vertical-align:top;}
table.meta th{background:#eef2f8;color:#1a3c6e;width:14%;font-weight:600;}
table.meta td{width:19%;border:1px solid #dde3ee;}
.note{color:#555;font-size:13px;}
.summary{display:flex;gap:16px;margin:12px 0;flex-wrap:wrap;}
.card{border:1px solid #ddd;border-radius:8px;padding:10px 14px;min-width:170px;}
.card b{font-size:20px;display:block;}
ul.det{margin:0;padding-left:16px;list-style:none;font-size:12px;} ul.det li{margin:1px 0;}
footer{margin-top:40px;font-size:11px;color:#888;border-top:1px solid #eee;padding-top:8px;}
@media print{body{max-width:none;margin:10px;} h2{break-after:avoid;} tr{break-inside:avoid;}}
</style></head><body>
<h1>Rapport de contrôle géométrique — Axe « ${esc(model.name)} »</h1>
<p class="note">Généré le ${now}</p>
<table class="meta">${meta}</table>
<p class="note">Valeurs contrôlées : ${esc(calcOn || 'aucune')}</p>

<h2>Synthèse</h2>
<div class="summary">
 ${a.hz ? card('Tracé en plan', model.synth.horiz) : ''}
 ${a.vz && model.vertElements.length ? card('Profil en long', model.synth.vert) : ''}
 ${a.giro && model.gabaritResults.length ? card('Gabarit / giration', model.synth.gabarit) : ''}
 ${a.surl && model.surlargeurResults.length ? `<div class="card">Surlargeur dispensées<br><b>${model.synth.surlargeur.ok || 0} / ${model.surlargeurResults.length}</b>courbes</div>` : ''}
</div>
${stats ? `<table class="meta" style="width:60%"><tr><th></th><th>Minimum</th><th>Moyen</th><th>Maximum</th></tr>${stats}</table>` : ''}

${a.hz ? `<h2>Géométrie horizontale (tracé en plan)</h2>
<table>${th(hCols)}
${tableRows(hRows)}</table>` : ''}

${a.vz && model.vertElements.length ? `<h2>Géométrie verticale (profil en long)</h2>
<table>${th(vCols)}
${tableRows(vRows)}</table>` : ''}

${a.giro && gRows.length ? `<h2>Gabarit véhicule / giration (OETV)</h2>
<p class="note">L'anneau de giration OETV (art. 40 : De ≤ 25.00 m, Di ≥ 10.60 m) n'est évalué comme critère conforme/non conforme que pour les rayons ≤ ${p.giroRadiusThreshold} m (carrefours, raquettes). Pour les courbes courantes, seule la largeur balayée B est donnée à titre indicatif.</p>
<table><tr><th>#</th><th>Chaînage</th><th>Rayon axe (m)</th><th>Giration ?</th><th>Véhicule</th><th>Largeur balayée B (m)</th><th>Statut</th></tr>
${tableRows(gRows)}</table>` : ''}

${a.surl && slRows.length ? `<h2>Surlargeur en courbe (VSS 40 105b)</h2>
<p class="note">Catégorie : ${esc(p.surlargeurCatLabel)}. Ra = R_axe + largeur de voie (${p.largeurVoie} m). Φ = angle de l'arc circulaire seul.</p>
<table><tr><th>#</th><th>Chaînage</th><th>Rayon (m)</th><th>e max (m)</th><th>Statut</th><th>Détail</th></tr>
${tableRows(slRows)}</table>` : ''}

<h2>Légende</h2>
<table>${legend}</table>

<footer>Document généré automatiquement par l'outil de contrôle d'axe routier (référentiel VSS/OETV/OCR, cours TRAN). À valider par un ingénieur qualifié avant usage contractuel.</footer>
</body></html>`;
  }

  /*DXFTPL-START*/
  const DXF_PRE = "  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1015\n  9\n$ACADMAINTVER\n 70\n6\n  9\n$DWGCODEPAGE\n  3\nANSI_1252\n  9\n$INSBASE\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$EXTMIN\n 10\n1e+20\n 20\n1e+20\n 30\n1e+20\n  9\n$EXTMAX\n 10\n-1e+20\n 20\n-1e+20\n 30\n-1e+20\n  9\n$LIMMIN\n 10\n0.0\n 20\n0.0\n  9\n$LIMMAX\n 10\n420.0\n 20\n297.0\n  9\n$ORTHOMODE\n 70\n0\n  9\n$REGENMODE\n 70\n1\n  9\n$FILLMODE\n 70\n1\n  9\n$QTEXTMODE\n 70\n0\n  9\n$MIRRTEXT\n 70\n1\n  9\n$LTSCALE\n 40\n1.0\n  9\n$ATTMODE\n 70\n1\n  9\n$TEXTSIZE\n 40\n2.5\n  9\n$TRACEWID\n 40\n1.0\n  9\n$TEXTSTYLE\n  7\nStandard\n  9\n$CLAYER\n  8\n0\n  9\n$CELTYPE\n  6\nByLayer\n  9\n$CECOLOR\n 62\n256\n  9\n$CELTSCALE\n 40\n1.0\n  9\n$DISPSILH\n 70\n0\n  9\n$DIMSCALE\n 40\n1.0\n  9\n$DIMASZ\n 40\n2.5\n  9\n$DIMEXO\n 40\n0.625\n  9\n$DIMDLI\n 40\n3.75\n  9\n$DIMRND\n 40\n0.0\n  9\n$DIMDLE\n 40\n0.0\n  9\n$DIMEXE\n 40\n1.25\n  9\n$DIMTP\n 40\n0.0\n  9\n$DIMTM\n 40\n0.0\n  9\n$DIMTXT\n 40\n2.5\n  9\n$DIMCEN\n 40\n2.5\n  9\n$DIMTSZ\n 40\n0.0\n  9\n$DIMTOL\n 70\n0\n  9\n$DIMLIM\n 70\n0\n  9\n$DIMTIH\n 70\n0\n  9\n$DIMTOH\n 70\n0\n  9\n$DIMSE1\n 70\n0\n  9\n$DIMSE2\n 70\n0\n  9\n$DIMTAD\n 70\n1\n  9\n$DIMZIN\n 70\n8\n  9\n$DIMBLK\n  1\n\n  9\n$DIMASO\n 70\n1\n  9\n$DIMSHO\n 70\n1\n  9\n$DIMPOST\n  1\n\n  9\n$DIMAPOST\n  1\n\n  9\n$DIMALT\n 70\n0\n  9\n$DIMALTD\n 70\n3\n  9\n$DIMALTF\n 40\n0.03937007874\n  9\n$DIMLFAC\n 40\n1.0\n  9\n$DIMTOFL\n 70\n1\n  9\n$DIMTVP\n 40\n0.0\n  9\n$DIMTIX\n 70\n0\n  9\n$DIMSOXD\n 70\n0\n  9\n$DIMSAH\n 70\n0\n  9\n$DIMBLK1\n  1\n\n  9\n$DIMBLK2\n  1\n\n  9\n$DIMSTYLE\n  2\nISO-25\n  9\n$DIMCLRD\n 70\n0\n  9\n$DIMCLRE\n 70\n0\n  9\n$DIMCLRT\n 70\n0\n  9\n$DIMTFAC\n 40\n1.0\n  9\n$DIMGAP\n 40\n0.625\n  9\n$DIMJUST\n 70\n0\n  9\n$DIMSD1\n 70\n0\n  9\n$DIMSD2\n 70\n0\n  9\n$DIMTOLJ\n 70\n0\n  9\n$DIMTZIN\n 70\n8\n  9\n$DIMALTZ\n 70\n0\n  9\n$DIMALTTZ\n 70\n0\n  9\n$DIMUPT\n 70\n0\n  9\n$DIMDEC\n 70\n2\n  9\n$DIMTDEC\n 70\n2\n  9\n$DIMALTU\n 70\n2\n  9\n$DIMALTTD\n 70\n3\n  9\n$DIMTXSTY\n  7\nStandard\n  9\n$DIMAUNIT\n 70\n0\n  9\n$DIMADEC\n 70\n0\n  9\n$DIMALTRND\n 40\n0.0\n  9\n$DIMAZIN\n 70\n0\n  9\n$DIMDSEP\n 70\n44\n  9\n$DIMATFIT\n 70\n3\n  9\n$DIMFRAC\n 70\n0\n  9\n$DIMLDRBLK\n  1\n\n  9\n$DIMLUNIT\n 70\n2\n  9\n$DIMLWD\n 70\n-2\n  9\n$DIMLWE\n 70\n-2\n  9\n$DIMTMOVE\n 70\n0\n  9\n$LUNITS\n 70\n2\n  9\n$LUPREC\n 70\n4\n  9\n$SKETCHINC\n 40\n1.0\n  9\n$FILLETRAD\n 40\n10.0\n  9\n$AUNITS\n 70\n0\n  9\n$AUPREC\n 70\n2\n  9\n$MENU\n  1\n.\n  9\n$ELEVATION\n 40\n0.0\n  9\n$PELEVATION\n 40\n0.0\n  9\n$THICKNESS\n 40\n0.0\n  9\n$LIMCHECK\n 70\n0\n  9\n$CHAMFERA\n 40\n0.0\n  9\n$CHAMFERB\n 40\n0.0\n  9\n$CHAMFERC\n 40\n0.0\n  9\n$CHAMFERD\n 40\n0.0\n  9\n$SKPOLY\n 70\n0\n  9\n$TDCREATE\n 40\n2461328.3717939816\n  9\n$TDUCREATE\n 40\n2458532.153996898\n  9\n$TDUPDATE\n 40\n2461328.3717939816\n  9\n$TDUUPDATE\n 40\n2458532.1544311\n  9\n$TDINDWG\n 40\n0.0\n  9\n$TDUSRTIMER\n 40\n0.0\n  9\n$USRTIMER\n 70\n1\n  9\n$ANGBASE\n 50\n0.0\n  9\n$ANGDIR\n 70\n0\n  9\n$PDMODE\n 70\n0\n  9\n$PDSIZE\n 40\n0.0\n  9\n$PLINEWID\n 40\n0.0\n  9\n$SPLFRAME\n 70\n0\n  9\n$SPLINETYPE\n 70\n6\n  9\n$SPLINESEGS\n 70\n8\n  9\n$HANDSEED\n  5\n39\n  9\n$SURFTAB1\n 70\n6\n  9\n$SURFTAB2\n 70\n6\n  9\n$SURFTYPE\n 70\n6\n  9\n$SURFU\n 70\n6\n  9\n$SURFV\n 70\n6\n  9\n$UCSBASE\n  2\n\n  9\n$UCSNAME\n  2\n\n  9\n$UCSORG\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSXDIR\n 10\n1.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSYDIR\n 10\n0.0\n 20\n1.0\n 30\n0.0\n  9\n$UCSORTHOREF\n  2\n\n  9\n$UCSORTHOVIEW\n 70\n0\n  9\n$UCSORGTOP\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGBOTTOM\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGLEFT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGRIGHT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGFRONT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGBACK\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSBASE\n  2\n\n  9\n$PUCSNAME\n  2\n\n  9\n$PUCSORG\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSXDIR\n 10\n1.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSYDIR\n 10\n0.0\n 20\n1.0\n 30\n0.0\n  9\n$PUCSORTHOREF\n  2\n\n  9\n$PUCSORTHOVIEW\n 70\n0\n  9\n$PUCSORGTOP\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGBOTTOM\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGLEFT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGRIGHT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGFRONT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGBACK\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$USERI1\n 70\n0\n  9\n$USERI2\n 70\n0\n  9\n$USERI3\n 70\n0\n  9\n$USERI4\n 70\n0\n  9\n$USERI5\n 70\n0\n  9\n$USERR1\n 40\n0.0\n  9\n$USERR2\n 40\n0.0\n  9\n$USERR3\n 40\n0.0\n  9\n$USERR4\n 40\n0.0\n  9\n$USERR5\n 40\n0.0\n  9\n$WORLDVIEW\n 70\n1\n  9\n$SHADEDGE\n 70\n3\n  9\n$SHADEDIF\n 70\n70\n  9\n$TILEMODE\n 70\n1\n  9\n$MAXACTVP\n 70\n64\n  9\n$PINSBASE\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PLIMCHECK\n 70\n0\n  9\n$PEXTMIN\n 10\n1e+20\n 20\n1e+20\n 30\n1e+20\n  9\n$PEXTMAX\n 10\n-1e+20\n 20\n-1e+20\n 30\n-1e+20\n  9\n$PLIMMIN\n 10\n0.0\n 20\n0.0\n  9\n$PLIMMAX\n 10\n420.0\n 20\n297.0\n  9\n$UNITMODE\n 70\n0\n  9\n$VISRETAIN\n 70\n1\n  9\n$PLINEGEN\n 70\n0\n  9\n$PSLTSCALE\n 70\n1\n  9\n$TREEDEPTH\n 70\n3020\n  9\n$CMLSTYLE\n  2\nStandard\n  9\n$CMLJUST\n 70\n0\n  9\n$CMLSCALE\n 40\n20.0\n  9\n$PROXYGRAPHICS\n 70\n1\n  9\n$MEASUREMENT\n 70\n1\n  9\n$CELWEIGHT\n370\n-1\n  9\n$ENDCAPS\n280\n0\n  9\n$JOINSTYLE\n280\n0\n  9\n$LWDISPLAY\n290\n0\n  9\n$INSUNITS\n 70\n6\n  9\n$HYPERLINKBASE\n  1\n\n  9\n$STYLESHEET\n  1\n\n  9\n$XEDIT\n290\n1\n  9\n$CEPSNTYPE\n380\n0\n  9\n$PSTYLEMODE\n290\n1\n  9\n$FINGERPRINTGUID\n  2\n{733B805E-6C41-40FB-857D-EE28DA268F3B}\n  9\n$VERSIONGUID\n  2\n{9B318CDA-7E6B-4F9F-890B-D29C204C535D}\n  9\n$EXTNAMES\n290\n1\n  9\n$PSVPSCALE\n 40\n0.0\n  9\n$OLESTARTUP\n290\n0\n  0\nENDSEC\n  0\nSECTION\n  2\nCLASSES\n  0\nCLASS\n  1\nACDBDICTIONARYWDFLT\n  2\nAcDbDictionaryWithDefault\n  3\nObjectDBX Classes\n 90\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nSUN\n  2\nAcDbSun\n  3\nSCENEOE\n 90\n1153\n280\n0\n281\n0\n  0\nCLASS\n  1\nVISUALSTYLE\n  2\nAcDbVisualStyle\n  3\nObjectDBX Classes\n 90\n4095\n280\n0\n281\n0\n  0\nCLASS\n  1\nMATERIAL\n  2\nAcDbMaterial\n  3\nObjectDBX Classes\n 90\n1153\n280\n0\n281\n0\n  0\nCLASS\n  1\nSCALE\n  2\nAcDbScale\n  3\nObjectDBX Classes\n 90\n1153\n280\n0\n281\n0\n  0\nCLASS\n  1\nTABLESTYLE\n  2\nAcDbTableStyle\n  3\nObjectDBX Classes\n 90\n4095\n280\n0\n281\n0\n  0\nCLASS\n  1\nMLEADERSTYLE\n  2\nAcDbMLeaderStyle\n  3\nACDB_MLEADERSTYLE_CLASS\n 90\n4095\n280\n0\n281\n0\n  0\nCLASS\n  1\nDICTIONARYVAR\n  2\nAcDbDictionaryVar\n  3\nObjectDBX Classes\n 90\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nCELLSTYLEMAP\n  2\nAcDbCellStyleMap\n  3\nObjectDBX Classes\n 90\n1152\n280\n0\n281\n0\n  0\nCLASS\n  1\nMENTALRAYRENDERSETTINGS\n  2\nAcDbMentalRayRenderSettings\n  3\nSCENEOE\n 90\n1024\n280\n0\n281\n0\n  0\nCLASS\n  1\nACDBDETAILVIEWSTYLE\n  2\nAcDbDetailViewStyle\n  3\nObjectDBX Classes\n 90\n1025\n280\n0\n281\n0\n  0\nCLASS\n  1\nACDBSECTIONVIEWSTYLE\n  2\nAcDbSectionViewStyle\n  3\nObjectDBX Classes\n 90\n1025\n280\n0\n281\n0\n  0\nCLASS\n  1\nRASTERVARIABLES\n  2\nAcDbRasterVariables\n  3\nISM\n 90\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nACDBPLACEHOLDER\n  2\nAcDbPlaceHolder\n  3\nObjectDBX Classes\n 90\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nLAYOUT\n  2\nAcDbLayout\n  3\nObjectDBX Classes\n 90\n0\n280\n0\n281\n0\n  0\nENDSEC\n  0\nSECTION\n  2\nTABLES\n  0\nTABLE\n  2\nVPORT\n  5\n8\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n  0\nVPORT\n  5\n23\n330\n8\n100\nAcDbSymbolTableRecord\n100\nAcDbViewportTableRecord\n  2\n*Active\n 70\n0\n 10\n0.0\n 20\n0.0\n 11\n1.0\n 21\n1.0\n 12\n0.0\n 22\n0.0\n 13\n0.0\n 23\n0.0\n 14\n0.5\n 24\n0.5\n 15\n0.5\n 25\n0.5\n 16\n0.0\n 26\n0.0\n 36\n1.0\n 17\n0.0\n 27\n0.0\n 37\n0.0\n 40\n1000.0\n 41\n1.34\n 42\n50.0\n 43\n0.0\n 44\n0.0\n 50\n0.0\n 51\n0.0\n 71\n0\n 72\n1000\n 73\n1\n 74\n3\n 75\n0\n 76\n0\n 77\n0\n 78\n0\n281\n0\n 65\n0\n146\n0.0\n  0\nENDTAB\n  0\nTABLE\n  2\nLTYPE\n  5\n2\n330\n0\n100\nAcDbSymbolTable\n 70\n3\n  0\nLTYPE\n  5\n24\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nByBlock\n 70\n0\n  3\n\n 72\n65\n 73\n0\n 40\n0.0\n  0\nLTYPE\n  5\n25\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nByLayer\n 70\n0\n  3\n\n 72\n65\n 73\n0\n 40\n0.0\n  0\nLTYPE\n  5\n26\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nContinuous\n 70\n0\n  3\n\n 72\n65\n 73\n0\n 40\n0.0\n  0\nENDTAB\n  0\nTABLE\n  2\nLAYER\n  5\n1\n330\n0\n100\nAcDbSymbolTable\n 70\n9\n  0\nLAYER\n  5\n27\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\n0\n 70\n0\n 62\n7\n  6\nContinuous\n370\n-3\n390\n13\n  0\nLAYER\n  5\n28\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nDefpoints\n 70\n0\n 62\n7\n  6\nContinuous\n290\n0\n370\n-3\n390\n13\n  0\nLAYER\n  5\n2F\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nAXE_SITUATION\n 70\n0\n 62\n7\n  6\nContinuous\n370\n-3\n390\n13\n  0\nLAYER\n  5\n30\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nAXE_SITUATION_PARAM\n 70\n0\n 62\n7\n  6\nContinuous\n370\n-3\n390\n13\n  0\nLAYER\n  5\n31\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nAXE_SITUATION_REPERE\n 70\n0\n 62\n8\n  6\nContinuous\n370\n-3\n390\n13\n  0\nLAYER\n  5\n32\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nAXE_ETENDU\n 70\n0\n 62\n7\n  6\nContinuous\n370\n-3\n390\n13\n  0\nLAYER\n  5\n33\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nAXE_ETENDU_PARAM\n 70\n0\n 62\n7\n  6\nContinuous\n370\n-3\n390\n13\n  0\nLAYER\n  5\n34\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nAXE_ETENDU_REPERE\n 70\n0\n 62\n8\n  6\nContinuous\n370\n-3\n390\n13\n  0\nLAYER\n  5\n35\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nAXE_CONTROLE_NP\n 70\n0\n 62\n5\n  6\nContinuous\n290\n0\n370\n-3\n390\n13\n  0\nENDTAB\n  0\nTABLE\n  2\nSTYLE\n  5\n5\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n  0\nSTYLE\n  5\n29\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbTextStyleTableRecord\n  2\nStandard\n 70\n0\n 40\n0.0\n 41\n1.0\n 50\n0.0\n 71\n0\n 42\n2.5\n  3\ntxt\n  4\n\n  0\nENDTAB\n  0\nTABLE\n  2\nVIEW\n  5\n7\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n  0\nENDTAB\n  0\nTABLE\n  2\nUCS\n  5\n6\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n  0\nENDTAB\n  0\nTABLE\n  2\nAPPID\n  5\n3\n330\n0\n100\nAcDbSymbolTable\n 70\n3\n  0\nAPPID\n  5\n2A\n330\n3\n100\nAcDbSymbolTableRecord\n100\nAcDbRegAppTableRecord\n  2\nACAD\n 70\n0\n  0\nAPPID\n  5\n36\n330\n3\n100\nAcDbSymbolTableRecord\n100\nAcDbRegAppTableRecord\n  2\nHATCHBACKGROUNDCOLOR\n 70\n0\n  0\nAPPID\n  5\n37\n330\n3\n100\nAcDbSymbolTableRecord\n100\nAcDbRegAppTableRecord\n  2\nEZDXF\n 70\n0\n  0\nENDTAB\n  0\nTABLE\n  2\nDIMSTYLE\n  5\n4\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n100\nAcDbDimStyleTable\n  0\nDIMSTYLE\n105\n2B\n330\n4\n100\nAcDbSymbolTableRecord\n100\nAcDbDimStyleTableRecord\n  2\nStandard\n 70\n0\n  3\n\n  4\n\n 40\n1.0\n 41\n2.5\n 42\n0.625\n 43\n3.75\n 44\n1.25\n 45\n0.0\n 46\n0.0\n 47\n0.0\n 48\n0.0\n140\n2.5\n141\n2.5\n142\n0.0\n143\n0.03937007874\n144\n1.0\n145\n0.0\n146\n1.0\n147\n0.625\n148\n0.0\n 71\n0\n 72\n0\n 73\n0\n 74\n0\n 75\n0\n 76\n0\n 77\n1\n 78\n8\n 79\n3\n170\n0\n171\n3\n172\n1\n173\n0\n174\n0\n175\n0\n176\n0\n177\n0\n178\n0\n179\n2\n271\n2\n272\n2\n273\n2\n274\n3\n275\n0\n276\n0\n277\n2\n278\n44\n279\n0\n280\n0\n281\n0\n282\n0\n283\n0\n284\n8\n285\n0\n286\n0\n288\n0\n289\n3\n371\n-2\n372\n-2\n  0\nENDTAB\n  0\nTABLE\n  2\nBLOCK_RECORD\n  5\n9\n330\n0\n100\nAcDbSymbolTable\n 70\n2\n  0\nBLOCK_RECORD\n  5\n17\n330\n9\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*Model_Space\n340\n1A\n  0\nBLOCK_RECORD\n  5\n1B\n330\n9\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*Paper_Space\n340\n1E\n  0\nENDTAB\n  0\nENDSEC\n  0\nSECTION\n  2\nBLOCKS\n  0\nBLOCK\n  5\n18\n330\n17\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockBegin\n  2\n*Model_Space\n 70\n0\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  3\n*Model_Space\n  1\n\n  0\nENDBLK\n  5\n19\n330\n17\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockEnd\n  0\nBLOCK\n  5\n1C\n330\n1B\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockBegin\n  2\n*Paper_Space\n 70\n0\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  3\n*Paper_Space\n  1\n\n  0\nENDBLK\n  5\n1D\n330\n1B\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockEnd\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n";
  const DXF_POST = "  0\nENDSEC\n  0\nSECTION\n  2\nOBJECTS\n  0\nDICTIONARY\n  5\nA\n330\n0\n100\nAcDbDictionary\n281\n1\n  3\nACAD_COLOR\n350\nB\n  3\nACAD_GROUP\n350\nC\n  3\nACAD_LAYOUT\n350\nD\n  3\nACAD_MATERIAL\n350\nE\n  3\nACAD_MLEADERSTYLE\n350\nF\n  3\nACAD_MLINESTYLE\n350\n10\n  3\nACAD_PLOTSETTINGS\n350\n11\n  3\nACAD_PLOTSTYLENAME\n350\n12\n  3\nACAD_SCALELIST\n350\n14\n  3\nACAD_TABLESTYLE\n350\n15\n  3\nACAD_VISUALSTYLE\n350\n16\n  3\nEZDXF_META\n350\n2D\n  0\nDICTIONARY\n  5\nB\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nDICTIONARY\n  5\nC\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nDICTIONARY\n  5\nD\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nModel\n350\n1A\n  3\nLayout1\n350\n1E\n  0\nDICTIONARY\n  5\nE\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nByBlock\n350\n1F\n  3\nByLayer\n350\n20\n  3\nGlobal\n350\n21\n  0\nDICTIONARY\n  5\nF\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nStandard\n350\n2C\n  0\nDICTIONARY\n  5\n10\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nStandard\n350\n22\n  0\nDICTIONARY\n  5\n11\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nACDBDICTIONARYWDFLT\n  5\n12\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nNormal\n350\n13\n100\nAcDbDictionaryWithDefault\n340\n13\n  0\nACDBPLACEHOLDER\n  5\n13\n330\n12\n  0\nDICTIONARY\n  5\n14\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nDICTIONARY\n  5\n15\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nDICTIONARY\n  5\n16\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nLAYOUT\n  5\n1A\n330\nD\n100\nAcDbPlotSettings\n  1\n\n  4\nA3\n  6\n\n 40\n7.5\n 41\n20.0\n 42\n7.5\n 43\n20.0\n 44\n420.0\n 45\n297.0\n 46\n0.0\n 47\n0.0\n 48\n0.0\n 49\n0.0\n140\n0.0\n141\n0.0\n142\n1.0\n143\n1.0\n 70\n1024\n 72\n1\n 73\n0\n 74\n5\n  7\n\n 75\n16\n 76\n0\n 77\n2\n 78\n300\n147\n1.0\n148\n0.0\n149\n0.0\n100\nAcDbLayout\n  1\nModel\n 70\n1\n 71\n0\n 10\n0.0\n 20\n0.0\n 11\n420.0\n 21\n297.0\n 12\n0.0\n 22\n0.0\n 32\n0.0\n 14\n1e+20\n 24\n1e+20\n 34\n1e+20\n 15\n-1e+20\n 25\n-1e+20\n 35\n-1e+20\n146\n0.0\n 13\n0.0\n 23\n0.0\n 33\n0.0\n 16\n1.0\n 26\n0.0\n 36\n0.0\n 17\n0.0\n 27\n1.0\n 37\n0.0\n 76\n1\n330\n17\n  0\nLAYOUT\n  5\n1E\n330\nD\n100\nAcDbPlotSettings\n  1\n\n  4\nA3\n  6\n\n 40\n7.5\n 41\n20.0\n 42\n7.5\n 43\n20.0\n 44\n420.0\n 45\n297.0\n 46\n0.0\n 47\n0.0\n 48\n0.0\n 49\n0.0\n140\n0.0\n141\n0.0\n142\n1.0\n143\n1.0\n 70\n0\n 72\n1\n 73\n0\n 74\n5\n  7\n\n 75\n16\n 76\n0\n 77\n2\n 78\n300\n147\n1.0\n148\n0.0\n149\n0.0\n100\nAcDbLayout\n  1\nLayout1\n 70\n1\n 71\n1\n 10\n0.0\n 20\n0.0\n 11\n420.0\n 21\n297.0\n 12\n0.0\n 22\n0.0\n 32\n0.0\n 14\n1e+20\n 24\n1e+20\n 34\n1e+20\n 15\n-1e+20\n 25\n-1e+20\n 35\n-1e+20\n146\n0.0\n 13\n0.0\n 23\n0.0\n 33\n0.0\n 16\n1.0\n 26\n0.0\n 36\n0.0\n 17\n0.0\n 27\n1.0\n 37\n0.0\n 76\n1\n330\n1B\n  0\nMATERIAL\n  5\n1F\n102\n{ACAD_REACTORS\n330\nE\n102\n}\n330\nE\n100\nAcDbMaterial\n  1\nByBlock\n  2\n\n 70\n0\n 40\n1.0\n 71\n1\n 41\n1.0\n 91\n-1023410177\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 44\n0.5\n 73\n0\n 45\n1.0\n 46\n1.0\n 77\n1\n  4\n\n 78\n1\n 79\n1\n170\n1\n 48\n1.0\n171\n1\n  6\n\n172\n1\n173\n1\n174\n1\n140\n1.0\n141\n1.0\n175\n1\n  7\n\n176\n1\n177\n1\n178\n1\n143\n1.0\n179\n1\n  8\n\n270\n1\n271\n1\n272\n1\n145\n1.0\n146\n1.0\n273\n1\n  9\n\n274\n1\n275\n1\n276\n1\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 94\n63\n  0\nMATERIAL\n  5\n20\n102\n{ACAD_REACTORS\n330\nE\n102\n}\n330\nE\n100\nAcDbMaterial\n  1\nByLayer\n  2\n\n 70\n0\n 40\n1.0\n 71\n1\n 41\n1.0\n 91\n-1023410177\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 44\n0.5\n 73\n0\n 45\n1.0\n 46\n1.0\n 77\n1\n  4\n\n 78\n1\n 79\n1\n170\n1\n 48\n1.0\n171\n1\n  6\n\n172\n1\n173\n1\n174\n1\n140\n1.0\n141\n1.0\n175\n1\n  7\n\n176\n1\n177\n1\n178\n1\n143\n1.0\n179\n1\n  8\n\n270\n1\n271\n1\n272\n1\n145\n1.0\n146\n1.0\n273\n1\n  9\n\n274\n1\n275\n1\n276\n1\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 94\n63\n  0\nMATERIAL\n  5\n21\n102\n{ACAD_REACTORS\n330\nE\n102\n}\n330\nE\n100\nAcDbMaterial\n  1\nGlobal\n  2\n\n 70\n0\n 40\n1.0\n 71\n1\n 41\n1.0\n 91\n-1023410177\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 44\n0.5\n 73\n0\n 45\n1.0\n 46\n1.0\n 77\n1\n  4\n\n 78\n1\n 79\n1\n170\n1\n 48\n1.0\n171\n1\n  6\n\n172\n1\n173\n1\n174\n1\n140\n1.0\n141\n1.0\n175\n1\n  7\n\n176\n1\n177\n1\n178\n1\n143\n1.0\n179\n1\n  8\n\n270\n1\n271\n1\n272\n1\n145\n1.0\n146\n1.0\n273\n1\n  9\n\n274\n1\n275\n1\n276\n1\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 94\n63\n  0\nMLINESTYLE\n  5\n22\n102\n{ACAD_REACTORS\n330\n10\n102\n}\n330\n10\n100\nAcDbMlineStyle\n  2\nStandard\n 70\n0\n  3\n\n 62\n256\n 51\n90.0\n 52\n90.0\n 71\n2\n 49\n0.5\n 62\n256\n  6\nBYLAYER\n 49\n-0.5\n 62\n256\n  6\nBYLAYER\n  0\nMLEADERSTYLE\n  5\n2C\n102\n{ACAD_REACTORS\n330\nF\n102\n}\n330\nF\n100\nAcDbMLeaderStyle\n179\n2\n170\n2\n171\n1\n172\n0\n 90\n2\n 40\n0.0\n 41\n0.0\n173\n1\n 91\n-1056964608\n 92\n-2\n290\n1\n 42\n2.0\n291\n1\n 43\n8.0\n  3\nStandard\n 44\n4.0\n300\n\n342\n29\n174\n1\n175\n1\n176\n0\n178\n1\n 93\n-1056964608\n 45\n4.0\n292\n0\n297\n0\n 46\n4.0\n 94\n-1056964608\n 47\n1.0\n 49\n1.0\n140\n1.0\n294\n1\n141\n0.0\n177\n0\n142\n1.0\n295\n0\n296\n0\n143\n3.75\n271\n0\n272\n9\n273\n9\n  0\nDICTIONARY\n  5\n2D\n330\nA\n100\nAcDbDictionary\n280\n1\n281\n1\n  3\nCREATED_BY_EZDXF\n350\n2E\n  3\nWRITTEN_BY_EZDXF\n350\n38\n  0\nDICTIONARYVAR\n  5\n2E\n330\n2D\n100\nDictionaryVariables\n280\n0\n  1\n1.4.4 @ 2026-10-14T06:55:23.897450+00:00\n  0\nDICTIONARYVAR\n  5\n38\n330\n2D\n100\nDictionaryVariables\n280\n0\n  1\n1.4.4 @ 2026-10-14T06:55:23.898957+00:00\n  0\nENDSEC\n  0\nEOF\n";
  const DXF_MSP = "17";
  /*DXFTPL-END*/
  // ============================================================
  // Export DXF (AC1015) — plan + profil en long annotés
  //  • courbes = ARC, clothoïdes = LWPOLYLINE, profil : 1 polyligne par élément
  //  • profil déformé : vertical ×10, horizontal ×1
  //  • paramètres encadrés dans la couleur du contrôle, avec ligne de rappel
  //  • calque NON IMPRIMABLE : motif de non-conformité / valeur limite / conformité
  // ============================================================
  const VEXAG = 10;
  function dxfNum(n) { return (Math.round(n * 1000) / 1000).toFixed(3); }
  function dxfStr(t) { // caractères non ASCII -> \U+XXXX (lisibles par AutoCAD)
    return String(t).replace(/\n/g, ' ').replace(/[^\x20-\x7e]/g, ch => '\\U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
  }

  function buildDXFString(model) {
    let handle = 0x100000;
    const H = () => (handle++).toString(16).toUpperCase();
    let ents = '';
    const add = s => { ents += s; };
    const head = (type, layer, color) => `0\n${type}\n5\n${H()}\n330\n${DXF_MSP}\n100\nAcDbEntity\n8\n${layer}\n62\n${color}\n`;
    const lwpoly = (layer, color, pts, closed) =>
      head('LWPOLYLINE', layer, color) + `100\nAcDbPolyline\n90\n${pts.length}\n70\n${closed ? 1 : 0}\n` +
      pts.map(p => `10\n${dxfNum(p[0])}\n20\n${dxfNum(p[1])}\n`).join('');
    const line = (layer, color, x1, y1, x2, y2) =>
      head('LINE', layer, color) + `100\nAcDbLine\n10\n${dxfNum(x1)}\n20\n${dxfNum(y1)}\n30\n0.0\n11\n${dxfNum(x2)}\n21\n${dxfNum(y2)}\n31\n0.0\n`;
    const arc = (layer, color, cx, cy, r, a0, a1) =>
      head('ARC', layer, color) + `100\nAcDbCircle\n10\n${dxfNum(cx)}\n20\n${dxfNum(cy)}\n30\n0.0\n40\n${dxfNum(r)}\n100\nAcDbArc\n50\n${a0.toFixed(5)}\n51\n${a1.toFixed(5)}\n`;
    const text = (layer, color, x, y, h, t) =>
      head('TEXT', layer, color) + `100\nAcDbText\n10\n${dxfNum(x)}\n20\n${dxfNum(y)}\n30\n0.0\n40\n${dxfNum(h)}\n1\n${dxfStr(t)}\n11\n${dxfNum(x)}\n21\n${dxfNum(y)}\n31\n0.0\n100\nAcDbText\n`;

    // boîte de texte encadrée : retourne {w, h} ; (x,y) = coin inférieur gauche
    function box(layer, color, x, y, h, lines) {
      const maxc = Math.max.apply(null, lines.map(l => l.length));
      const w = maxc * h * 0.62 + h;
      const bh = lines.length * h * 1.5 + h * 0.5;
      add(lwpoly(layer, color, [[x, y], [x + w, y], [x + w, y + bh], [x, y + bh]], true));
      lines.forEach((l, i) => add(text(layer, color, x + h * 0.5, y + bh - h * 1.4 - i * h * 1.5, h, l)));
      return { w, h: bh };
    }

    // ----- PLAN -----
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    model.planSegments.forEach(s => s.pts.forEach(pt => {
      if (pt.E < minE) minE = pt.E; if (pt.E > maxE) maxE = pt.E;
      if (pt.N < minN) minN = pt.N; if (pt.N > maxN) maxN = pt.N;
    }));
    if (!isFinite(minE)) { minE = 0; maxE = 100; minN = 0; maxN = 100; }
    const span = Math.max(maxE - minE, maxN - minN, 50);
    const th = Math.max(span / 140, 0.5); // hauteur de texte plan
    const offs = span * 0.07;

    function annotatePlan(el, seg, color, lines, np) {
      const pts = seg.pts;
      if (!pts || pts.length < 2) return;
      const mi = Math.floor(pts.length / 2);
      const M = pts[mi], A = pts[Math.max(mi - 1, 0)], B = pts[Math.min(mi + 1, pts.length - 1)];
      let tx = B.E - A.E, ty = B.N - A.N; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const side = (el.idx % 2 === 0) ? 1 : -1;
      const d = offs * (1 + (el.idx % 3) * 0.5);
      const bx = M.E - ty * side * d, by = M.N + tx * side * d;
      const bw = Math.max.apply(null, lines.map(l => l.length)) * th * 0.62 + th;
      const bh = lines.length * th * 1.5 + th * 0.5;
      const x0 = side > 0 ? bx - bw : bx, y0 = by - bh / 2;
      add(line('AXE_SITUATION_REPERE', color, M.E, M.N, bx, by));
      const b = box('AXE_SITUATION_PARAM', color, x0, y0, th, lines);
      // calque non imprimable : motifs à droite du cadre
      const npl = np.map(s => s);
      npl.forEach((l, i) => add(text('AXE_CONTROLE_NP', color, x0 + b.w + th, y0 + b.h - th * 1.4 - i * th * 1.4, th * 0.8, l)));
    }

    const A = active(model.params);
    const planHeader = `TRACE EN PLAN - axe ${model.name} (echelle 1:1)`;
    model.horizEval.forEach((el, k) => {
      const seg = model.planSegments[k];
      const color = ACI[el.status] || 8;
      if (el.type === 'Line') {
        add(line('AXE_SITUATION', color, el.start.E, el.start.N, el.end.E, el.end.N));
      } else if (el.type === 'Curve' && el.center && el.radius) {
        const C = el.center, pts = seg.pts;
        const ang = pt => Math.atan2(pt.N - C.N, pt.E - C.E) * 180 / Math.PI;
        const a0 = ang(pts[0]), aM = ang(pts[Math.floor(pts.length / 2)]), a1 = ang(pts[pts.length - 1]);
        const mod = x => ((x % 360) + 360) % 360;
        const ccw = mod(aM - a0) < mod(a1 - a0);
        add(ccw ? arc('AXE_SITUATION', color, C.E, C.N, el.radius, mod(a0), mod(a1)) : arc('AXE_SITUATION', color, C.E, C.N, el.radius, mod(a1), mod(a0)));
      } else if (seg.pts.length > 1) {
        add(lwpoly('AXE_SITUATION', color, seg.pts.map(pt => [pt.E, pt.N]), false));
      }
      // paramètres
      const lines = [`#${el.idx} ${RoadEngine.typeLabelFR(el.type)}`, `Ch. ${el.kmStart.toFixed(1)} - ${el.kmEnd.toFixed(1)}  L=${el.length.toFixed(1)} m`];
      if (el.type === 'Curve') {
        lines.push(`R=${el.radius.toFixed(1)} m`);
        const dv = findCheck(el, 'devers'); if (dv && A.devers) lines.push(`p=${dv.value.toFixed(2)} %`);
        const dr = findCheck(el, 'derapage'); if (dr) lines.push(`fT req.=${dr.value.toFixed(3)}`);
      } else if (el.type === 'Spiral') {
        lines.push(`A=${el.A != null ? el.A.toFixed(1) : '-'} m`);
        if (el.deltaI != null && A.deltaI) lines.push(`Di=${el.deltaI.toFixed(3)} %`);
      }
      const np = [];
      (el.checks || []).forEach(c => np.push(`${c.severity === 'info' ? 'i' : (c.state === 'ok' ? 'OK' : (c.state === 'tolerance' ? 'TOL.' : 'NON CONF.'))} ${c.detail}`));
      if (!np.length) np.push('Aucun controle applicable');
      if (A.hz) annotatePlan(el, seg, color, lines, np);
    });
    add(text('AXE_SITUATION_PARAM', 7, minE, minN - span * 0.1, th * 1.6, planHeader));

    // ----- PROFIL EN LONG (X = chaînage ×1, Y = altitude ×10) -----
    const baseX = maxE + span * 0.3, baseY = minN;
    let minElev = Infinity, maxElev = -Infinity;
    model.profileSegments.forEach(s => s.pts.forEach(pt => { if (pt.elev < minElev) minElev = pt.elev; if (pt.elev > maxElev) maxElev = pt.elev; }));
    if (!isFinite(minElev)) { minElev = 0; maxElev = 0; }
    const px = sta => baseX + sta - model.staStart;
    const py = el => baseY + (el - minElev) * VEXAG;
    const profLen = Math.max((model.computedEnd || 0) - model.staStart, 100);
    const ph = Math.max(profLen / 140, 0.5);
    const topY = py(maxElev);
    model.profileSegments.forEach((seg, k) => {
      const ve = model.vertElements[k];
      const color = ACI[seg.status] || 8;
      add(lwpoly('AXE_ETENDU', color, seg.pts.map(pt => [px(pt.sta), py(pt.elev)]), false));
      const midP = seg.pts[Math.floor(seg.pts.length / 2)];
      const lvl = k % 3;
      if (!A.vz) return;
      if (ve.type === 'RayonVertical') {
        const vtx = [px(ve.staVertex), py(ve.elevAtVertex)];
        const bx = vtx[0] - ph * 8, y0 = topY + ph * 4 + lvl * ph * 22;
        const sdChk = findCheck(ve, 'SD');
        const colS = sdChk ? (ACI[sdChk.state] || 8) : color;
        add(line('AXE_ETENDU_REPERE', color, vtx[0], vtx[1], vtx[0], y0));
        const l1 = [`#${ve.idx} ${ve.shape}`];
        if (A.vert) l1.push(`Rv=${ve.radius.toFixed(0)} m`, `tv=${ve.tv.toFixed(2)} m`, `fv=${ve.fv.toFixed(3)} m`); else l1.push(`Rv=${ve.radius.toFixed(0)} m`);
        const b1 = box('AXE_ETENDU_PARAM', color, bx, y0, ph, l1);
        let yy = y0 + b1.h + ph * 0.5;
        if (A.visib) {
          const b2 = box('AXE_ETENDU_PARAM', colS, bx, yy, ph, [`Dist. d'arret Da=${ve.sA.toFixed(1)} m`]); yy += b2.h + ph * 0.5;
          const b3 = box('AXE_ETENDU_PARAM', colS, bx, yy, ph, [`Dist. de visibilite S=${ve.sD != null ? ve.sD.toFixed(1) + ' m' : 'n.c. (concave)'}` + (A.sReq ? ` (req. ${ve.sReq.toFixed(1)} m)` : '')]);
        }
        const np = (ve.checks || []).map(c => `${c.severity === 'info' ? 'i' : (c.state === 'ok' ? 'OK' : (c.state === 'tolerance' ? 'TOL.' : 'NON CONF.'))} ${c.detail}`);
        np.forEach((l, i) => add(text('AXE_CONTROLE_NP', color, bx + b1.w + ph, y0 + b1.h - ph * 1.4 - i * ph * 1.4, ph * 0.8, l)));
      } else {
        const y0 = topY + ph * 4 + lvl * ph * 22;
        add(line('AXE_ETENDU_REPERE', color, px(midP.sta), py(midP.elev), px(midP.sta), y0));
        const lt = [`#${ve.idx} Tangente`, `i=${(ve.grade * 100).toFixed(2)} %`, `L=${ve.length.toFixed(1)} m`]; if (A.visib && ve.sA != null) lt.push(`Da=${ve.sA.toFixed(1)} m`);
        const b = box('AXE_ETENDU_PARAM', color, px(midP.sta) - ph * 6, y0, ph, lt);
        const np = (ve.checks || []).map(c => `${c.severity === 'info' ? 'i' : (c.state === 'ok' ? 'OK' : (c.state === 'tolerance' ? 'TOL.' : 'NON CONF.'))} ${c.detail}`);
        np.forEach((l, i) => add(text('AXE_CONTROLE_NP', color, px(midP.sta) - ph * 6 + b.w + ph, y0 + b.h - ph * 1.4 - i * ph * 1.4, ph * 0.8, l)));
      }
    });
    add(text('AXE_ETENDU_PARAM', 7, baseX, baseY - span * 0.1, ph * 1.6, `PROFIL EN LONG - axe ${model.name} - echelle horizontale x1, verticale x${VEXAG}`));

    return DXF_PRE + ents + DXF_POST;
  }

  return {
    buildModel, natureText, natureList, active, legendItems, buildWorkbookData, buildWorkbook, buildReportHTML, buildDXFString, detailLines,
    VEHICLES, SURLARGEUR_CATEGORIES: RoadEngine.SURLARGEUR_CATEGORIES,
    STATUS_LABEL, STATUS_COLORS, CALC_LABELS,
  };
});
