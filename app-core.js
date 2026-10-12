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

    const horizEval = RoadEngine.evaluateHorizontal(alignment.horiz, { Vp, fT, fTRegime, q });
    const sConsecutive = RoadEngine.evaluateSConsecutiveClothoids(horizEval);

    // échantillonnage pour tracé plan + attache du statut à chaque segment
    const planSegments = horizEval.map(el => {
      let pts = [];
      try { pts = RoadEngine.sampleElement(el); } catch (e) { pts = []; }
      return { type: el.type, status: el.status, checks: el.checks, pts, idx: el.idx, kmStart: el.kmStart, kmEnd: el.kmEnd };
    });

    // gabarit / giration : pour chaque Curve, calcul du balayage véhicule.
    // L'anneau OETV (De<=25.00m, Di>=10.60m — art.40 OETV) ne s'applique qu'aux
    // manoeuvres de girations à faible rayon (carrefours, raquettes, débouchés),
    // PAS aux courbes courantes d'un tracé d'axe (R=80..600m) : on ne l'applique
    // donc que sous un seuil de rayon paramétrable (giroRadiusThreshold, def. 30m).
    // Au-delà, seul le calcul de surlargeur de balayage B est fourni, à titre
    // informatif (la largeur de chaussée réelle n'est pas dans le LandXML).
    const giroThreshold = params.giroRadiusThreshold != null ? params.giroRadiusThreshold : 30;
    const gabaritResults = [];
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
          domainOk: sw.domainOk, Ri: sw.Ri, Re: sw.Re, B: sw.B,
          oetv, status,
        });
      }
    }

    let vertElements = [];
    let profileSegments = [];
    if (alignment.vertRaw && alignment.vertRaw.length >= 2) {
      vertElements = RoadEngine.evaluateVertical(RoadEngine.buildVerticalElements(alignment.vertRaw), { Vp, fL, fLRegime, tr });
      profileSegments = buildProfileSegments(alignment.vertRaw, vertElements);
    }

    // ---------- Surlargeur en courbe (VSS 40 105b) — distinct de l'anneau OETV ci-dessus ----------
    // NB : Ra (rayon extérieur de la voie élargie) est approximé par le rayon de l'axe, faute de largeur
    // de chaussée réelle dans le LandXML — à affiner si cette donnée devient disponible. Phi (angle total
    // du virage, y c. clothoïdes) est approximé par |delta| de l'arc circulaire seul (clothoïdes amont/aval
    // non cumulées ici), ce qui est prudent (sous-estime légèrement Phi, donc jamais côté non-sécuritaire
    // pour la dispense de surlargeur — seulement pour le facteur de réduction p indicatif).
    const surlargeurCatKey = params.surlargeurCatKey || 'B';
    const surlargeurResults = [];
    for (const el of horizEval) {
      if (el.type === 'Curve' && el.radius) {
        const phiTotalGon = el.delta != null ? Math.abs(el.delta) * (200 / Math.PI) : null;
        const res = RoadEngine.evaluateSurlargeur(el.radius, phiTotalGon, surlargeurCatKey);
        // Statut informatif : ce module donne une largeur à CONSTRUIRE, ce n'est pas un contrôle de conformité
        // du tracé (une courbe serrée n'est pas "non conforme" — elle requiert une surlargeur). 'ok' = aucune
        // surlargeur nécessaire (dispense), 'info' = surlargeur requise (valeur donnée) ou hors domaine.
        surlargeurResults.push(Object.assign({ idx: el.idx, kmStart: el.kmStart, kmEnd: el.kmEnd, radius: el.radius }, res,
          { status: !res.applicable ? 'info' : (res.dispense ? 'ok' : 'info') }));
      }
    }

    // synthèse
    function countStatus(list) {
      const c = { ok: 0, fail: 0, info: 0 };
      list.forEach(x => { c[x.status] = (c[x.status] || 0) + 1; });
      return c;
    }
    const synth = {
      horiz: countStatus(horizEval),
      vert: countStatus(vertElements),
      gabarit: countStatus(gabaritResults),
      surlargeur: countStatus(surlargeurResults),
      sConsecutiveNC: sConsecutive.filter(s => !s.ok).length,
    };

    return {
      name: alignment.name, staStart: alignment.staStart, length: alignment.length,
      computedEnd: alignment.computedEnd,
      params: { Vp, fT, fTRegime, fL, fLRegime, q, tr, vehicleKey, vehicleLabel: vehicle.label, surlargeurCatKey,
        surlargeurCatLabel: (RoadEngine.SURLARGEUR_CATEGORIES[surlargeurCatKey] || RoadEngine.SURLARGEUR_CATEGORIES.B).label },
      horizEval, sConsecutive, planSegments,
      gabaritResults, vertElements, profileSegments,
      surlargeurResults,
      synth,
    };
  }

  // ---------- Export Excel (données pures — sheet name + rows) ----------
  function buildWorkbookData(model) {
    const sheets = [];

    const synthRows = [
      ['Axe', model.name],
      ['Vitesse projet Vp (km/h)', model.params.Vp],
      ['f_T — frottement transversal (R_min)', model.params.fT, 'référentiel: ' + model.params.fTRegime],
      ['f_L — frottement longitudinal (S_A)', model.params.fL, 'référentiel: ' + model.params.fLRegime],
      ['q_design (dévers max de calcul)', (model.params.q * 100).toFixed(0) + ' %'],
      ['t (temps de réaction, VSS 40 090b)', model.params.tr + ' s'],
      ['Véhicule normalisé (gabarit)', model.params.vehicleLabel],
      [],
      ['Contrôle', 'Conforme', 'Non conforme', 'Info'],
      ['Géométrie horizontale', model.synth.horiz.ok || 0, model.synth.horiz.fail || 0, model.synth.horiz.info || 0],
      ['Géométrie verticale', model.synth.vert.ok || 0, model.synth.vert.fail || 0, model.synth.vert.info || 0],
      ['Gabarit / giration', model.synth.gabarit.ok || 0, model.synth.gabarit.fail || 0, model.synth.gabarit.info || 0],
      ['Surlargeur en courbe (VSS 40 105b) — dispensées', model.synth.surlargeur ? (model.synth.surlargeur.ok || 0) : 0, '', model.synth.surlargeur ? (model.synth.surlargeur.info || 0) : 0],
      ['Clothoïdes en S non conformes', model.synth.sConsecutiveNC, '', ''],
    ];
    sheets.push({ name: 'Synthèse', rows: synthRows });

    function findCheck(el, labelSubstr) { return (el.checks || []).find(c => c.label && c.label.indexOf(labelSubstr) >= 0); }

    const hRows = [['#', 'Type', 'Chaînage début', 'Chaînage fin', 'Longueur (m)', 'Rayon / A (m)', 'Seuil (m)', 'Dévers calculé (%)', 'Statut', 'Détail']];
    model.horizEval.forEach(el => {
      const chk = el.checks && el.checks[0];
      const devers = findCheck(el, 'Dévers calculé');
      hRows.push([
        el.idx, RoadEngine.typeLabelFR(el.type), +el.kmStart.toFixed(2), +el.kmEnd.toFixed(2), +el.length.toFixed(2),
        el.radius != null ? +el.radius.toFixed(2) : (el.A != null ? +el.A.toFixed(2) : ''),
        chk ? +Number(chk.threshold).toFixed(2) : '',
        devers ? +Number(devers.value).toFixed(2) : '',
        el.status === 'ok' ? 'Conforme' : (el.status === 'fail' ? 'NON CONFORME' : 'Info'),
        chk ? chk.detail : '',
      ]);
    });
    sheets.push({ name: 'Horizontal', rows: hRows });

    if (model.vertElements.length) {
      const vRows = [['#', 'Type', 'Chaînage début', 'Chaînage fin', 'Longueur (m)', 'Rv (m) / i (%)', 'Seuil', 'Statut', 'Détail']];
      model.vertElements.forEach(el => {
        const chk = el.checks && el.checks[0];
        vRows.push([
          el.idx, RoadEngine.typeLabelFR(el.type), +el.kmStart.toFixed(2), +el.kmEnd.toFixed(2), +el.length.toFixed(2),
          el.radius != null ? +el.radius.toFixed(1) : (el.grade != null ? +(el.grade * 100).toFixed(2) : ''),
          chk ? +Number(chk.threshold).toFixed(2) : '',
          el.status === 'ok' ? 'Conforme' : (el.status === 'fail' ? 'NON CONFORME' : 'Info'),
          chk ? chk.detail : '',
        ]);
      });
      sheets.push({ name: 'Vertical', rows: vRows });
    }

    const gRows = [['#', 'Chaînage', 'Rayon (m)', 'Giration (R≤seuil) ?', 'Véhicule', 'Ri (m)', 'Re (m)', 'Largeur balayée B (m)', 'De anneau (m)', 'Di anneau (m)', 'Statut']];
    model.gabaritResults.forEach(g => {
      gRows.push([
        g.idx, +g.kmStart.toFixed(2), +g.radius.toFixed(2), g.isGiration ? 'Oui' : 'Non (courant)', g.vehicleLabel,
        g.Ri != null ? +g.Ri.toFixed(2) : 'hors domaine',
        g.Re != null ? +g.Re.toFixed(2) : 'hors domaine',
        g.B != null ? +g.B.toFixed(2) : '',
        g.oetv ? +g.oetv.De.toFixed(2) : '',
        g.oetv ? +g.oetv.Di.toFixed(2) : '',
        g.status === 'ok' ? 'Conforme' : (g.status === 'fail' ? 'NON CONFORME' : (g.isGiration ? 'Info' : 'Info (surlargeur indicative)')),
      ]);
    });
    sheets.push({ name: 'Gabarit', rows: gRows });

    const sRows = [['Spiral #A', 'Spiral #B', 'A1/A2', 'Statut', 'Détail']];
    model.sConsecutive.forEach(s => {
      sRows.push([s.idxA, s.idxB, +s.ratio.toFixed(3), s.ok ? 'Conforme' : 'NON CONFORME', s.detail]);
    });
    if (model.sConsecutive.length) sheets.push({ name: 'Clothoïdes-S', rows: sRows });

    if (model.surlargeurResults && model.surlargeurResults.length) {
      const slRows = [['#', 'Chaînage', 'Rayon Ra≈axe (m)', 'Catégorie', 'D (m)', 'e max (m)', 'Φ_Grenz (gon)', 'Dispensée ?', 'Détail']];
      model.surlargeurResults.forEach(s => {
        slRows.push([
          s.idx, +s.kmStart.toFixed(2), +s.radius.toFixed(2),
          s.category ? s.category.label : '', s.D != null ? s.D : '',
          s.e != null ? +s.e.toFixed(3) : '', s.phiGrenz != null ? +s.phiGrenz.toFixed(1) : '',
          s.applicable ? (s.dispense ? 'Oui' : 'Non') : 'Hors domaine',
          s.applicable ? s.detail : s.reason,
        ]);
      });
      sheets.push({ name: 'Surlargeur', rows: slRows });
    }

    return sheets;
  }

  // ---------- Export Rapport (HTML autonome) ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function statusBadge(status) {
    const map = { ok: ['Conforme', '#1a7f37', '#e6f4ea'], fail: ['NON CONFORME', '#b42318', '#fde8e8'], info: ['Info', '#555', '#eee'] };
    const [label, fg, bg] = map[status] || map.info;
    return `<span style="color:${fg};background:${bg};padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;">${label}</span>`;
  }

  function buildReportHTML(model) {
    const now = new Date().toISOString().slice(0, 10);
    function tableRows(rows) { return rows.map(r => `<tr>${r.map(c => `<td style="padding:4px 8px;border-bottom:1px solid #e5e5e5;">${c}</td>`).join('')}</tr>`).join(''); }

    function findCheckR(el, labelSubstr) { return (el.checks || []).find(c => c.label && c.label.indexOf(labelSubstr) >= 0); }
    const hRows = model.horizEval.map(el => {
      const chk = el.checks && el.checks[0];
      const devers = findCheckR(el, 'Dévers calculé');
      return [el.idx, RoadEngine.typeLabelFR(el.type), el.kmStart.toFixed(2), el.kmEnd.toFixed(2),
        el.radius != null ? el.radius.toFixed(1) : (el.A != null ? 'A=' + el.A.toFixed(1) : '—'),
        devers ? Number(devers.value).toFixed(2) + ' %' : '—',
        statusBadge(el.status), esc(chk ? chk.detail : '')];
    });
    const vRows = model.vertElements.map(el => {
      const chk = el.checks && el.checks[0];
      return [el.idx, RoadEngine.typeLabelFR(el.type), el.kmStart.toFixed(2), el.kmEnd.toFixed(2),
        el.radius != null ? el.radius.toFixed(0) : (el.grade != null ? (el.grade * 100).toFixed(2) + '%' : '—'),
        statusBadge(el.status), esc(chk ? chk.detail : '')];
    });
    const gRows = model.gabaritResults.map(g => [
      g.idx, g.kmStart.toFixed(2), g.radius.toFixed(1), g.isGiration ? 'Oui' : 'Non', esc(g.vehicleLabel),
      g.B != null ? g.B.toFixed(2) : '—', statusBadge(g.status),
    ]);
    const slRows = (model.surlargeurResults || []).map(s => [
      s.idx, s.kmStart.toFixed(2), s.radius.toFixed(1),
      s.applicable ? (s.e != null ? s.e.toFixed(3) + ' m' : '—') : '—',
      statusBadge(s.status), esc(s.applicable ? s.detail : s.reason),
    ]);

    return `<!doctype html><html><head><meta charset="utf-8"><title>Rapport — Axe ${esc(model.name)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#222;max-width:900px;margin:30px auto;padding:0 20px;}
h1{font-size:22px;border-bottom:3px solid #1a3c6e;padding-bottom:8px;}
h2{font-size:17px;color:#1a3c6e;margin-top:28px;}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;}
th{background:#1a3c6e;color:#fff;text-align:left;padding:6px 8px;}
.meta{color:#555;font-size:13px;}
.summary{display:flex;gap:16px;margin:12px 0;flex-wrap:wrap;}
.card{border:1px solid #ddd;border-radius:8px;padding:10px 14px;min-width:160px;}
.card b{font-size:20px;display:block;}
footer{margin-top:40px;font-size:11px;color:#888;border-top:1px solid #eee;padding-top:8px;}
</style></head><body>
<h1>Rapport de contrôle géométrique — Axe « ${esc(model.name)} »</h1>
<p class="meta">Généré le ${now} · Vp = ${model.params.Vp} km/h · f_T = ${model.params.fT} (réf. ${esc(model.params.fTRegime)}) · f_L = ${model.params.fL} (réf. ${esc(model.params.fLRegime)}) · q_design = ${(model.params.q*100).toFixed(0)}% · t = ${model.params.tr} s · Véhicule gabarit : ${esc(model.params.vehicleLabel)} · Catégorie surlargeur : ${esc(model.params.surlargeurCatLabel || '')}<br>
Référentiel : normes suisses VSS (40 090b, 40 100a, 40 105b, 40 110), OETV (art. 40 — anneau de giration), OCR (art. 64–66 — dimensions véhicules).</p>

<h2>Synthèse</h2>
<div class="summary">
 <div class="card">Horizontal<br><b>${model.synth.horiz.ok||0} / ${(model.synth.horiz.ok||0)+(model.synth.horiz.fail||0)}</b>conformes</div>
 <div class="card">Vertical<br><b>${model.synth.vert.ok||0} / ${(model.synth.vert.ok||0)+(model.synth.vert.fail||0)}</b>conformes</div>
 <div class="card">Gabarit / giration<br><b>${model.synth.gabarit.ok||0} / ${(model.synth.gabarit.ok||0)+(model.synth.gabarit.fail||0)}</b>conformes</div>
 <div class="card">Surlargeur dispensées<br><b>${(model.synth.surlargeur&&model.synth.surlargeur.ok)||0} / ${model.surlargeurResults ? model.surlargeurResults.length : 0}</b>courbes</div>
 <div class="card">Clothoïdes en S non conformes<br><b>${model.synth.sConsecutiveNC}</b></div>
</div>

<h2>Géométrie horizontale (tracé en plan)</h2>
<table><tr><th>#</th><th>Type</th><th>Chaînage début</th><th>Chaînage fin</th><th>Rayon / A (m)</th><th>Dévers calculé</th><th>Statut</th><th>Détail</th></tr>
${tableRows(hRows)}</table>

${model.vertElements.length ? `<h2>Géométrie verticale (profil en long)</h2>
<table><tr><th>#</th><th>Type</th><th>Chaînage début</th><th>Chaînage fin</th><th>Rv (m) / i (%)</th><th>Statut</th><th>Détail</th></tr>
${tableRows(vRows)}</table>` : ''}

<h2>Gabarit véhicule / giration (OETV)</h2>
<p class="meta">L'anneau de giration OETV (art. 40 : De ≤ 25.00 m, Di ≥ 10.60 m) n'est évalué comme critère conforme/non-conforme que pour les rayons ≤ ${model.params.giroRadiusThreshold != null ? model.params.giroRadiusThreshold : 30} m (manoeuvres de giration : carrefours, raquettes). Pour les courbes courantes du tracé, seule la surlargeur de balayage B est donnée à titre indicatif (la largeur de chaussée réelle n'est pas contenue dans le LandXML).</p>
<table><tr><th>#</th><th>Chaînage</th><th>Rayon axe (m)</th><th>Giration ?</th><th>Véhicule</th><th>Largeur balayée B (m)</th><th>Statut</th></tr>
${tableRows(gRows)}</table>

${slRows.length ? `<h2>Surlargeur en courbe (VSS 40 105b)</h2>
<p class="meta">Catégorie de véhicule déterminante : ${esc(model.params.surlargeurCatLabel || '')}. Ra (rayon extérieur de la voie élargie) est approximé par le rayon de l'axe, faute de largeur de chaussée réelle dans le LandXML — à affiner si cette donnée est disponible. Φ (angle total du virage) est approximé par l'angle de l'arc circulaire seul.</p>
<table><tr><th>#</th><th>Chaînage</th><th>Rayon (m)</th><th>e max (m)</th><th>Statut</th><th>Détail</th></tr>
${tableRows(slRows)}</table>` : ''}

<footer>Document généré automatiquement par l'outil de contrôle d'axe routier (moteur interne, référentiel VSS/OETV/OCR). À valider par un ingénieur qualifié avant usage contractuel.</footer>
</body></html>`;
  }

  // ---------- Export DXF (texte, R12 minimal) ----------
  function dxfNum(n) { return (Math.round(n * 1000) / 1000).toFixed(3); }
  function dxfLine(layer, color, x1, y1, x2, y2) {
    return `0\nLINE\n8\n${layer}\n62\n${color}\n10\n${dxfNum(x1)}\n20\n${dxfNum(y1)}\n30\n0.0\n11\n${dxfNum(x2)}\n21\n${dxfNum(y2)}\n31\n0.0\n`;
  }
  function dxfText(layer, color, x, y, h, txt) {
    return `0\nTEXT\n8\n${layer}\n62\n${color}\n10\n${dxfNum(x)}\n20\n${dxfNum(y)}\n30\n0.0\n40\n${dxfNum(h)}\n1\n${String(txt).replace(/\n/g, ' ')}\n`;
  }
  function colorFor(status) { return status === 'ok' ? 3 : (status === 'fail' ? 1 : 8); } // 3=vert,1=rouge,8=gris

  function buildDXFString(model) {
    let ents = '';
    // --- SITUATION (plan, E=X, N=Y, coordonnées réelles) ---
    for (const seg of model.planSegments) {
      const c = colorFor(seg.status);
      for (let i = 0; i < seg.pts.length - 1; i++) {
        ents += dxfLine('AXE_SITUATION', c, seg.pts[i].E, seg.pts[i].N, seg.pts[i + 1].E, seg.pts[i + 1].N);
      }
      if (seg.pts.length) {
        ents += dxfText('AXE_SITUATION_TXT', c, seg.pts[0].E, seg.pts[0].N, 2, `${seg.type} #${seg.idx}`);
      }
    }
    // bbox plan pour positionner le profil à côté
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    model.planSegments.forEach(s => s.pts.forEach(p => {
      if (p.E < minE) minE = p.E; if (p.E > maxE) maxE = p.E;
      if (p.N < minN) minN = p.N; if (p.N > maxN) maxN = p.N;
    }));
    if (!isFinite(minE)) { minE = 0; maxE = 100; minN = 0; maxN = 100; }
    const offsetX = (isFinite(maxE) ? maxE - minE : 100) + 50;
    const baseX = minE + offsetX, baseY = minN;

    // --- ÉTENDU (profil en long, X=chaînage, Y=altitude exagérée x5, décalé à côté du plan) ---
    const VEXAG = 5;
    let minElev = Infinity, maxElev = -Infinity;
    model.profileSegments.forEach(s => s.pts.forEach(p => { if (p.elev < minElev) minElev = p.elev; if (p.elev > maxElev) maxElev = p.elev; }));
    if (!isFinite(minElev)) minElev = 0;
    for (const seg of model.profileSegments) {
      const c = colorFor(seg.status);
      for (let i = 0; i < seg.pts.length - 1; i++) {
        const x1 = baseX + seg.pts[i].sta - model.staStart;
        const y1 = baseY + (seg.pts[i].elev - minElev) * VEXAG;
        const x2 = baseX + seg.pts[i + 1].sta - model.staStart;
        const y2 = baseY + (seg.pts[i + 1].elev - minElev) * VEXAG;
        ents += dxfLine('AXE_ETENDU', c, x1, y1, x2, y2);
      }
      if (seg.pts.length) {
        const p0 = seg.pts[0];
        ents += dxfText('AXE_ETENDU_TXT', c, baseX + p0.sta - model.staStart, baseY + (p0.elev - minElev) * VEXAG, 2, `${seg.type}`);
      }
    }
    ents += dxfText('AXE_ETENDU_TXT', 7, baseX, baseY - 10, 3, `PROFIL EN LONG — échelle verticale x${VEXAG} — axe ${model.name}`);
    ents += dxfText('AXE_SITUATION_TXT', 7, minE, minN - 10, 3, `TRACÉ EN PLAN (SITUATION) — axe ${model.name}`);

    const header = `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC\n`;
    const tables = `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n5\n` +
      ['AXE_SITUATION', 'AXE_SITUATION_TXT', 'AXE_ETENDU', 'AXE_ETENDU_TXT'].map(l => `0\nLAYER\n2\n${l}\n70\n0\n62\n7\n6\nCONTINUOUS\n`).join('') +
      `0\nENDTAB\n0\nENDSEC\n`;
    const entities = `0\nSECTION\n2\nENTITIES\n${ents}0\nENDSEC\n`;
    const eof = `0\nEOF\n`;
    return header + tables + entities + eof;
  }

  return { buildModel, buildWorkbookData, buildReportHTML, buildDXFString, VEHICLES, SURLARGEUR_CATEGORIES: RoadEngine.SURLARGEUR_CATEGORIES };
});
