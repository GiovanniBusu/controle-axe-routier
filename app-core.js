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
    const tolerance = params.tolerance > 0 ? params.tolerance : 0; // fraction
    const largeurVoie = params.largeurVoie > 0 ? params.largeurVoie : 3.0;
    const deltaIMax = params.deltaIMax != null ? params.deltaIMax : 1.5;
    const deltaIMinMode = params.deltaIMinMode || 'formule';
    const calc = Object.assign({}, RoadEngine.CALC_DEFAULT, params.calc || {});

    const horizEval = RoadEngine.evaluateHorizontal(alignment.horiz, {
      Vp, fT, fTRegime, q, tolerance, calc, largeurVoie, deltaIMax, deltaIMinMode,
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
      vertElements = RoadEngine.evaluateVertical(RoadEngine.buildVerticalElements(alignment.vertRaw), { Vp, fL, fLRegime, tr, tolerance, calc });
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
        tolerance, largeurVoie, deltaIMax, deltaIMinMode, calc, giroRadiusThreshold: giroThreshold },
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

  function fmt(x, d) { return x == null || !isFinite(x) ? '' : +Number(x).toFixed(d); }
  function paramsRows(model) {
    const p = model.params;
    const on = k => p.calc[k] ? 'oui' : 'non';
    return [
      ['Axe', model.name, 'Vitesse projet Vp', p.Vp + ' km/h', 'Largeur de voie', p.largeurVoie + ' m'],
      ['f_T (R_min)', p.fT + ' (' + p.fTRegime + ')', 'f_L (S_A)', p.fL + ' (' + p.fLRegime + ')', 'q_design', (p.q * 100).toFixed(0) + ' %'],
      ['Temps de réaction t', p.tr + ' s', 'Tolérance', (p.tolerance * 100).toFixed(1).replace(/\.0$/, '') + ' %', 'Véhicule gabarit', p.vehicleLabel],
      ['Δi max', p.deltaIMax + ' %', 'Δi min', p.deltaIMinMode === 'none' ? 'non contrôlé' : '0,1·a = ' + (0.1 * p.largeurVoie).toFixed(2) + ' %', 'Catégorie surlargeur', p.surlargeurCatLabel],
    ];
  }

  // ---------- Export Excel : données (valeurs, formules, styles) ----------
  // Cellule = primitive | { v, f, status, bold, wrap, z, head }
  function buildWorkbookData(model) {
    const sheets = [];
    const p = model.params;
    const nH = model.horizEval.length, nV = model.vertElements.length;

    // ----- Horizontal (construit d'abord pour connaître les références) -----
    const hHead = ['#', 'Type', 'Chaînage début (m)', 'Chaînage fin (m)', 'Longueur (m)', 'Rayon R / paramètre A (m)',
      'Angle au centre (gon)', 'Dévers p (%)', 'f_T requis', 'Δi (%)', 'Δi min (%)', 'Δi max (%)', 'Statut', 'Détail des contrôles'].map(h => ({ v: h, head: true }));
    const hRows = [hHead];
    model.horizEval.forEach((el, k) => {
      const r = k + 2; // ligne Excel
      const dv = findCheck(el, 'devers'), dr = findCheck(el, 'derapage');
      hRows.push([
        el.idx, RoadEngine.typeLabelFR(el.type), fmt(el.kmStart, 2), fmt(el.kmEnd, 2),
        { v: fmt(el.kmEnd - el.kmStart, 2), f: `D${r}-C${r}` },
        el.radius != null ? fmt(el.radius, 2) : (el.A != null ? fmt(el.A, 2) : ''),
        el.type === 'Curve' && el.delta != null ? fmt(Math.abs(el.delta) * 200 / Math.PI, 4) : '',
        dv ? fmt(dv.value, 2) : '', dr ? fmt(dr.value, 3) : '',
        el.deltaI != null ? fmt(el.deltaI, 3) : '', el.deltaIMin != null ? fmt(el.deltaIMin, 3) : '', el.deltaIMax != null ? fmt(el.deltaIMax, 3) : '',
        { v: STATUS_LABEL[el.status], status: el.status },
        { v: detailPlain(el), wrap: true },
      ]);
    });
    const hLast = nH + 1;
    // ----- Vertical -----
    const vHead = ['#', 'Type', 'Chaînage début (m)', 'Chaînage fin (m)', 'Longueur (m)', 'Rv (m)', 'Déclivité entrée (%)', 'Déclivité sortie (%)',
      'Tangente tv (m)', 'Flèche fv (m)', "Distance d'arrêt S_A (m)", 'Distance de visibilité S_D (m)', 'Statut', 'Détail des contrôles'].map(h => ({ v: h, head: true }));
    const vRows = [vHead];
    model.vertElements.forEach((el, k) => {
      const r = k + 2;
      if (el.type === 'RayonVertical') {
        vRows.push([
          el.idx, RoadEngine.typeLabelFR(el.type), fmt(el.kmStart, 2), fmt(el.kmEnd, 2), { v: fmt(el.kmEnd - el.kmStart, 2), f: `D${r}-C${r}` },
          fmt(el.radius, 1), fmt(el.gradeIn * 100, 3), fmt(el.gradeOut * 100, 3),
          { v: fmt(el.tv, 2), f: `F${r}*ABS(H${r}-G${r})/100/2` },
          { v: fmt(el.fv, 3), f: `I${r}^2/(2*F${r})` },
          fmt(el.sA, 1), el.sD != null ? { v: fmt(el.sD, 1), f: `2*SQRT(F${r})` } : '',
          { v: STATUS_LABEL[el.status], status: el.status }, { v: detailPlain(el), wrap: true },
        ]);
      } else {
        vRows.push([
          el.idx, RoadEngine.typeLabelFR(el.type), fmt(el.kmStart, 2), fmt(el.kmEnd, 2), { v: fmt(el.kmEnd - el.kmStart, 2), f: `D${r}-C${r}` },
          '', fmt(el.grade * 100, 3), fmt(el.grade * 100, 3), '', '', '', '',
          { v: STATUS_LABEL[el.status], status: el.status }, { v: detailPlain(el), wrap: true },
        ]);
      }
    });
    const vLast = nV + 1;

    // ----- Synthèse (formules COUNTIF / MIN / MOYENNE / MAX) -----
    const rng = (sh, col, last) => `${sh}!$${col}$2:$${col}$${Math.max(last, 2)}`;
    const cnt = (sh, last, lab) => ({ f: `COUNTIF(${rng(sh, sh === 'Horizontal' ? 'M' : 'M', last)},"${lab}")` });
    const counts = (sh, last, o) => ['Conforme', 'Tolérance', 'NON CONFORME', 'Info'].map((lab, i) => {
      const key = ['ok', 'tolerance', 'fail', 'info'][i];
      return { v: o[key] || 0, f: `COUNTIF(${rng(sh, 'M', last)},"${lab}")` };
    });
    const synthRows = [[{ v: 'Paramètres de contrôle', head: true }, { v: '', head: true }, { v: '', head: true }, { v: '', head: true }, { v: '', head: true }, { v: '', head: true }]];
    paramsRows(model).forEach(r => synthRows.push(r.map((c, i) => (i % 2 === 0 ? { v: c, bold: true } : c))));
    synthRows.push([]);
    synthRows.push([{ v: 'Valeurs calculées', head: true }, { v: 'Oui/Non', head: true }]);
    Object.keys(CALC_LABELS).forEach(k => synthRows.push([CALC_LABELS[k], p.calc[k] ? 'oui' : 'non']));
    synthRows.push([]);
    synthRows.push([{ v: 'Contrôle', head: true }, { v: 'Conforme', head: true }, { v: 'Tolérance', head: true }, { v: 'Non conforme', head: true }, { v: 'Info', head: true }]);
    synthRows.push(['Géométrie horizontale'].concat(counts('Horizontal', hLast, model.synth.horiz)));
    if (nV) synthRows.push(['Géométrie verticale'].concat(counts('Vertical', vLast, model.synth.vert)));
    if (model.gabaritResults.length) synthRows.push(['Gabarit / giration', model.synth.gabarit.ok || 0, '', model.synth.gabarit.fail || 0, model.synth.gabarit.info || 0]);
    if (model.surlargeurResults.length) synthRows.push(['Surlargeur en courbe (dispensées / info)', model.synth.surlargeur.ok || 0, '', '', model.synth.surlargeur.info || 0]);
    synthRows.push([]);
    synthRows.push([{ v: 'Statistiques', head: true }, { v: 'Minimum', head: true }, { v: 'Moyen', head: true }, { v: 'Maximum', head: true }]);
    const sd = model.synth.devers, si = model.synth.deltaI;
    synthRows.push(['Dévers p (%)',
      sd ? { v: fmt(sd.min, 2), f: `MIN(${rng('Horizontal', 'H', hLast)})` } : '', sd ? { v: fmt(sd.moy, 2), f: `AVERAGE(${rng('Horizontal', 'H', hLast)})` } : '', sd ? { v: fmt(sd.max, 2), f: `MAX(${rng('Horizontal', 'H', hLast)})` } : '']);
    synthRows.push(['Δi (%)',
      si ? { v: fmt(si.min, 3), f: `MIN(${rng('Horizontal', 'J', hLast)})` } : '', si ? { v: fmt(si.moy, 3), f: `AVERAGE(${rng('Horizontal', 'J', hLast)})` } : '', si ? { v: fmt(si.max, 3), f: `MAX(${rng('Horizontal', 'J', hLast)})` } : '']);
    sheets.push({ name: 'Synthèse', rows: synthRows, cols: [30, 22, 26, 22, 24, 30] });

    sheets.push({ name: 'Horizontal', rows: hRows, cols: [5, 20, 14, 14, 12, 16, 14, 11, 11, 10, 10, 10, 15, 80], freeze: true });
    if (nV) sheets.push({ name: 'Vertical', rows: vRows, cols: [5, 22, 14, 14, 12, 11, 13, 13, 12, 11, 15, 17, 15, 80], freeze: true });

    if (model.gabaritResults.length) {
      const gRows = [['#', 'Chaînage', 'Rayon (m)', 'Giration (R≤seuil) ?', 'Véhicule', 'Ri (m)', 'Re (m)', 'Largeur balayée B (m)', 'De anneau (m)', 'Di anneau (m)', 'Statut'].map(h => ({ v: h, head: true }))];
      model.gabaritResults.forEach((g, k) => {
        const r = k + 2;
        gRows.push([
          g.idx, fmt(g.kmStart, 2), fmt(g.radius, 2), g.isGiration ? 'Oui' : 'Non (courant)', g.vehicleLabel,
          g.Ri != null ? fmt(g.Ri, 2) : 'hors domaine', g.Re != null ? fmt(g.Re, 2) : 'hors domaine',
          g.B != null ? { v: fmt(g.B, 2), f: `G${r}-F${r}` } : '',
          g.oetv ? { v: fmt(g.oetv.De, 2), f: `2*G${r}` } : '', g.oetv ? { v: fmt(g.oetv.Di, 2), f: `2*F${r}` } : '',
          { v: g.status === 'ok' ? 'Conforme' : (g.status === 'fail' ? 'NON CONFORME' : 'Info'), status: g.status },
        ]);
      });
      sheets.push({ name: 'Gabarit', rows: gRows, cols: [5, 11, 11, 18, 22, 10, 10, 18, 14, 14, 15], freeze: true });
    }

    if (model.surlargeurResults.length) {
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

  function buildReportHTML(model) {
    const now = new Date().toISOString().slice(0, 10);
    const p = model.params;
    function tableRows(rows) { return rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join(''); }
    const n = (x, d) => x == null || !isFinite(x) ? '—' : Number(x).toFixed(d);

    const hRows = model.horizEval.map(el => {
      const dv = findCheck(el, 'devers'), dr = findCheck(el, 'derapage');
      return [el.idx, RoadEngine.typeLabelFR(el.type), n(el.kmStart, 2), n(el.kmEnd, 2), n(el.length, 2),
        el.radius != null ? 'R = ' + n(el.radius, 1) : (el.A != null ? 'A = ' + n(el.A, 1) : '—'),
        dv ? n(dv.value, 2) + ' %' : '—', dr ? n(dr.value, 3) : '—',
        el.deltaI != null ? n(el.deltaI, 3) + ' %' : '—',
        statusBadge(el.status), detailHTML(el)];
    });
    const vRows = model.vertElements.map(el => [
      el.idx, RoadEngine.typeLabelFR(el.type), n(el.kmStart, 2), n(el.kmEnd, 2), n(el.length, 2),
      el.radius != null ? 'Rv = ' + n(el.radius, 0) : 'i = ' + n(el.grade * 100, 2) + ' %',
      el.tv != null ? n(el.tv, 2) : '—', el.fv != null ? n(el.fv, 3) : '—',
      el.type === 'RayonVertical' ? n(el.sA, 1) : '—', el.sD != null ? n(el.sD, 1) : '—',
      statusBadge(el.status), detailHTML(el)]);
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
    const cardH = model.synth.horiz, cardV = model.synth.vert;
    const card = (lab, c) => {
      const tot = (c.ok || 0) + (c.tolerance || 0) + (c.fail || 0);
      return `<div class="card">${lab}<br><b>${c.ok || 0} / ${tot}</b>conformes${c.tolerance ? ` · <span style="color:#9a4b00;font-weight:600">${c.tolerance} en tolérance</span>` : ''}${c.fail ? ` · <span style="color:#b42318;font-weight:600">${c.fail} non conf.</span>` : ''}</div>`;
    };

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
<p class="note">Valeurs contrôlées : ${esc(calcOn || 'aucune')}<br>
Référentiel : normes suisses VSS (40 090b, 40 100a, 40 105b, 40 110), OETV (art. 40 — anneau de giration), OCR (art. 64–66), cours TRAN (formules 17.31, 23.4, 23.5).
Légende : ✔ conforme · ⚠ hors limite mais dans la tolérance · ✖ non conforme · ℹ indicatif (sans effet sur le statut).</p>

<h2>Synthèse</h2>
<div class="summary">
 ${card('Géométrie horizontale', cardH)}
 ${nVertCard()}
 ${model.gabaritResults.length ? card('Gabarit / giration', model.synth.gabarit) : ''}
 ${model.surlargeurResults.length ? `<div class="card">Surlargeur dispensées<br><b>${model.synth.surlargeur.ok || 0} / ${model.surlargeurResults.length}</b>courbes</div>` : ''}
</div>
<table class="meta" style="width:60%"><tr><th></th><th>Minimum</th><th>Moyen</th><th>Maximum</th></tr>
${statRow('Dévers p', sd, 2, '%')}${statRow('Δi (rampe de dévers)', si, 3, '%')}</table>

<h2>Géométrie horizontale (tracé en plan)</h2>
<table><tr><th>#</th><th>Type</th><th>Chaînage début</th><th>Chaînage fin</th><th>Longueur (m)</th><th>R / A (m)</th><th>Dévers p</th><th>f_T requis</th><th>Δi</th><th>Statut</th><th>Détail des contrôles</th></tr>
${tableRows(hRows)}</table>

${model.vertElements.length ? `<h2>Géométrie verticale (profil en long)</h2>
<table><tr><th>#</th><th>Type</th><th>Chaînage début</th><th>Chaînage fin</th><th>Longueur (m)</th><th>Rv (m) / i</th><th>tv (m)</th><th>fv (m)</th><th>Distance d'arrêt S_A (m)</th><th>Distance de visibilité S_D (m)</th><th>Statut</th><th>Détail des contrôles</th></tr>
${tableRows(vRows)}</table>` : ''}

${gRows.length ? `<h2>Gabarit véhicule / giration (OETV)</h2>
<p class="note">L'anneau de giration OETV (art. 40 : De ≤ 25.00 m, Di ≥ 10.60 m) n'est évalué comme critère conforme/non conforme que pour les rayons ≤ ${p.giroRadiusThreshold} m (carrefours, raquettes). Pour les courbes courantes, seule la largeur balayée B est donnée à titre indicatif.</p>
<table><tr><th>#</th><th>Chaînage</th><th>Rayon axe (m)</th><th>Giration ?</th><th>Véhicule</th><th>Largeur balayée B (m)</th><th>Statut</th></tr>
${tableRows(gRows)}</table>` : ''}

${slRows.length ? `<h2>Surlargeur en courbe (VSS 40 105b)</h2>
<p class="note">Catégorie : ${esc(p.surlargeurCatLabel)}. Ra = R_axe + largeur de voie (${p.largeurVoie} m). Φ = angle de l'arc circulaire seul.</p>
<table><tr><th>#</th><th>Chaînage</th><th>Rayon (m)</th><th>e max (m)</th><th>Statut</th><th>Détail</th></tr>
${tableRows(slRows)}</table>` : ''}

<footer>Document généré automatiquement par l'outil de contrôle d'axe routier (référentiel VSS/OETV/OCR). À valider par un ingénieur qualifié avant usage contractuel.</footer>
</body></html>`;

    function nVertCard() { return model.vertElements.length ? card('Géométrie verticale', cardV) : ''; }
  }

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
    let handle = 0x100;
    const H = () => (handle++).toString(16).toUpperCase();
    let ents = '';
    const add = s => { ents += s; };
    const lwpoly = (layer, color, pts, closed) =>
      `0\nLWPOLYLINE\n5\n${H()}\n8\n${layer}\n62\n${color}\n100\nAcDbEntity\n100\nAcDbPolyline\n90\n${pts.length}\n70\n${closed ? 1 : 0}\n` +
      pts.map(p => `10\n${dxfNum(p[0])}\n20\n${dxfNum(p[1])}\n`).join('');
    const line = (layer, color, x1, y1, x2, y2) =>
      `0\nLINE\n5\n${H()}\n8\n${layer}\n62\n${color}\n100\nAcDbEntity\n100\nAcDbLine\n10\n${dxfNum(x1)}\n20\n${dxfNum(y1)}\n30\n0.0\n11\n${dxfNum(x2)}\n21\n${dxfNum(y2)}\n31\n0.0\n`;
    const arc = (layer, color, cx, cy, r, a0, a1) =>
      `0\nARC\n5\n${H()}\n8\n${layer}\n62\n${color}\n100\nAcDbEntity\n100\nAcDbCircle\n10\n${dxfNum(cx)}\n20\n${dxfNum(cy)}\n30\n0.0\n40\n${dxfNum(r)}\n100\nAcDbArc\n50\n${a0.toFixed(5)}\n51\n${a1.toFixed(5)}\n`;
    const text = (layer, color, x, y, h, t) =>
      `0\nTEXT\n5\n${H()}\n8\n${layer}\n62\n${color}\n100\nAcDbEntity\n100\nAcDbText\n10\n${dxfNum(x)}\n20\n${dxfNum(y)}\n30\n0.0\n40\n${dxfNum(h)}\n1\n${dxfStr(t)}\n100\nAcDbText\n`;

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
        const dv = findCheck(el, 'devers'); if (dv) lines.push(`p=${dv.value.toFixed(2)} %`);
        const dr = findCheck(el, 'derapage'); if (dr) lines.push(`fT req.=${dr.value.toFixed(3)}`);
      } else if (el.type === 'Spiral') {
        lines.push(`A=${el.A != null ? el.A.toFixed(1) : '-'} m`);
        if (el.deltaI != null) lines.push(`Di=${el.deltaI.toFixed(3)} %`);
      }
      const np = [];
      (el.checks || []).forEach(c => np.push(`${c.severity === 'info' ? 'i' : (c.state === 'ok' ? 'OK' : (c.state === 'tolerance' ? 'TOL.' : 'NON CONF.'))} ${c.detail}`));
      if (!np.length) np.push('Aucun controle applicable');
      annotatePlan(el, seg, color, lines, np);
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
      if (ve.type === 'RayonVertical') {
        const vtx = [px(ve.staVertex), py(ve.elevAtVertex)];
        const bx = vtx[0] - ph * 8, y0 = topY + ph * 4 + lvl * ph * 22;
        const sdChk = findCheck(ve, 'SD');
        const colS = sdChk ? (ACI[sdChk.state] || 8) : color;
        add(line('AXE_ETENDU_REPERE', color, vtx[0], vtx[1], vtx[0], y0));
        const b1 = box('AXE_ETENDU_PARAM', color, bx, y0, ph, [`#${ve.idx} ${ve.shape}`, `Rv=${ve.radius.toFixed(0)} m`, `tv=${ve.tv.toFixed(2)} m`, `fv=${ve.fv.toFixed(3)} m`]);
        const b2 = box('AXE_ETENDU_PARAM', colS, bx, y0 + b1.h + ph * 0.5, ph, [`Dist. d'arret SA=${ve.sA.toFixed(1)} m`]);
        box('AXE_ETENDU_PARAM', colS, bx, y0 + b1.h + b2.h + ph, ph, [`Dist. de visibilite SD=${ve.sD != null ? ve.sD.toFixed(1) + ' m' : 'n.c. (concave)'}`]);
        const np = (ve.checks || []).map(c => `${c.severity === 'info' ? 'i' : (c.state === 'ok' ? 'OK' : (c.state === 'tolerance' ? 'TOL.' : 'NON CONF.'))} ${c.detail}`);
        np.forEach((l, i) => add(text('AXE_CONTROLE_NP', color, bx + b1.w + ph, y0 + b1.h - ph * 1.4 - i * ph * 1.4, ph * 0.8, l)));
      } else {
        const y0 = topY + ph * 4 + lvl * ph * 22;
        add(line('AXE_ETENDU_REPERE', color, px(midP.sta), py(midP.elev), px(midP.sta), y0));
        const b = box('AXE_ETENDU_PARAM', color, px(midP.sta) - ph * 6, y0, ph, [`#${ve.idx} Tangente`, `i=${(ve.grade * 100).toFixed(2)} %`, `L=${ve.length.toFixed(1)} m`]);
        const np = (ve.checks || []).map(c => `${c.severity === 'info' ? 'i' : (c.state === 'ok' ? 'OK' : (c.state === 'tolerance' ? 'TOL.' : 'NON CONF.'))} ${c.detail}`);
        np.forEach((l, i) => add(text('AXE_CONTROLE_NP', color, px(midP.sta) - ph * 6 + b.w + ph, y0 + b.h - ph * 1.4 - i * ph * 1.4, ph * 0.8, l)));
      }
    });
    add(text('AXE_ETENDU_PARAM', 7, baseX, baseY - span * 0.1, ph * 1.6, `PROFIL EN LONG - axe ${model.name} - echelle horizontale x1, verticale x${VEXAG}`));

    const layers = [
      ['AXE_SITUATION', 7, 1], ['AXE_SITUATION_PARAM', 7, 1], ['AXE_SITUATION_REPERE', 8, 1],
      ['AXE_ETENDU', 7, 1], ['AXE_ETENDU_PARAM', 7, 1], ['AXE_ETENDU_REPERE', 8, 1],
      ['AXE_CONTROLE_NP', 5, 0], // 0 = non imprimable
    ];
    const header = `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$DWGCODEPAGE\n3\nANSI_1252\n9\n$HANDSEED\n5\nFFFFF\n0\nENDSEC\n`;
    const tables = `0\nSECTION\n2\nTABLES\n` +
      `0\nTABLE\n2\nLTYPE\n5\n5\n100\nAcDbSymbolTable\n70\n1\n0\nLTYPE\n5\n14\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n0\nENDTAB\n` +
      `0\nTABLE\n2\nLAYER\n5\n2\n100\nAcDbSymbolTable\n70\n${layers.length}\n` +
      layers.map(l => `0\nLAYER\n5\n${H()}\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n2\n${l[0]}\n70\n0\n62\n${l[1]}\n6\nCONTINUOUS\n290\n${l[2]}\n`).join('') +
      `0\nENDTAB\n` +
      `0\nTABLE\n2\nSTYLE\n5\n3\n100\nAcDbSymbolTable\n70\n1\n0\nSTYLE\n5\n11\n100\nAcDbSymbolTableRecord\n100\nAcDbTextStyleTableRecord\n2\nSTANDARD\n70\n0\n40\n0.0\n41\n1.0\n50\n0.0\n71\n0\n42\n2.5\n3\ntxt\n4\n\n0\nENDTAB\n` +
      `0\nENDSEC\n`;
    const entities = `0\nSECTION\n2\nENTITIES\n${ents}0\nENDSEC\n`;
    return header + tables + entities + `0\nEOF\n`;
  }

  return {
    buildModel, buildWorkbookData, buildWorkbook, buildReportHTML, buildDXFString, detailLines,
    VEHICLES, SURLARGEUR_CATEGORIES: RoadEngine.SURLARGEUR_CATEGORIES,
    STATUS_LABEL, STATUS_COLORS, CALC_LABELS,
  };
});
