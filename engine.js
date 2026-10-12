/* ============================================================
   Moteur de calcul — Contrôle Axe Routier
   Parsing LandXML, géométrie horizontale/verticale, conformité VSS/OETV/OCR
   Fonctionne en navigateur (DOMParser) et en Node (xmldom fourni par l'appelant)
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RoadEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NS = 'http://www.landxml.org/schema/LandXML-1.2';

  // ---------- Utilitaires XML ----------
  function getAttr(el, name, dflt) {
    const v = el.getAttribute(name);
    return v === null || v === undefined || v === '' ? dflt : v;
  }
  function fAttr(el, name, dflt) {
    const v = getAttr(el, name, null);
    if (v === null) return dflt;
    const n = parseFloat(v);
    return isNaN(n) ? dflt : n;
  }
  function childrenByLocalName(el, name) {
    const out = [];
    for (let i = 0; i < el.childNodes.length; i++) {
      const c = el.childNodes[i];
      if (c.nodeType === 1 && (c.localName === name || c.nodeName === name || c.nodeName.endsWith(':' + name))) {
        out.push(c);
      }
    }
    return out;
  }
  function firstByLocalName(el, name) {
    const r = childrenByLocalName(el, name);
    return r.length ? r[0] : null;
  }
  function allDescendantsByLocalName(doc, name) {
    // works with DOMParser (no namespace-aware getElementsByTagNameNS reliability issues)
    const all = doc.getElementsByTagName('*');
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (n.localName === name || n.nodeName === name || n.nodeName.endsWith(':' + name)) out.push(n);
    }
    return out;
  }
  function textOf(el) {
    return (el.textContent || '').trim();
  }
  function parsePoint(el) {
    const t = textOf(el).split(/\s+/).map(Number);
    return { N: t[0], E: t[1] }; // LandXML <Start>/<End>/... = Northing Easting
  }

  // ---------- Détection unité angulaire ----------
  function detectAngularUnit(doc) {
    const units = allDescendantsByLocalName(doc, 'Metric')[0] || allDescendantsByLocalName(doc, 'Imperial')[0];
    if (units) {
      const au = units.getAttribute('angularUnit');
      if (au) return au.indexOf('radian') >= 0 ? 'radians' : 'degrees';
    }
    return 'degrees';
  }
  function toRad(val, unit) {
    return unit === 'radians' ? val : (val * Math.PI / 180);
  }

  // ---------- Parsing d'un fichier LandXML (texte) ----------
  function parseLandXML(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length) {
      throw new Error('XML invalide : ' + perr[0].textContent.slice(0, 300));
    }
    const angUnit = detectAngularUnit(doc);
    const alignEls = allDescendantsByLocalName(doc, 'Alignment');
    if (!alignEls.length) throw new Error('Aucun élément <Alignment> trouvé dans ce fichier.');

    const alignments = alignEls.map(a => parseAlignment(a, angUnit));
    return { angularUnit: angUnit, alignments };
  }

  function parseAlignment(alignEl, angUnit) {
    const name = getAttr(alignEl, 'name', '(sans nom)');
    const staStart = fAttr(alignEl, 'staStart', 0);
    const length = fAttr(alignEl, 'length', 0);
    const coordGeom = firstByLocalName(alignEl, 'CoordGeom');
    const horiz = [];
    let cum = staStart;
    let prevDir = null; // continuité tangentielle — comble l'absence de dirStart sur certains exports (ex. clothoïdes AutoCAD)
    if (coordGeom) {
      for (let i = 0; i < coordGeom.childNodes.length; i++) {
        const el = coordGeom.childNodes[i];
        if (el.nodeType !== 1) continue;
        const tag = el.localName || el.nodeName.split(':').pop();
        if (tag !== 'Line' && tag !== 'Curve' && tag !== 'Spiral') continue;
        const len = fAttr(el, 'length', 0);
        const item = {
          type: tag,
          kmStart: cum,
          kmEnd: cum + len,
          length: len,
          rot: getAttr(el, 'rot', ''),
        };
        const startP = firstByLocalName(el, 'Start');
        const endP = firstByLocalName(el, 'End');
        if (startP) item.start = parsePoint(startP);
        if (endP) item.end = parsePoint(endP);

        if (tag === 'Line') {
          item.dir = toRad(fAttr(el, 'dir', 0), angUnit);
          item.dirStart = item.dir;
          item.dirEnd = item.dir;
          prevDir = item.dirEnd;
        } else if (tag === 'Curve') {
          item.radius = fAttr(el, 'radius', null);
          const centerP = firstByLocalName(el, 'Center');
          if (centerP) item.center = parsePoint(centerP);
          item.dirStart = el.hasAttribute('dirStart') ? toRad(fAttr(el, 'dirStart', 0), angUnit) : prevDir;
          item.dirEnd = el.hasAttribute('dirEnd') ? toRad(fAttr(el, 'dirEnd', 0), angUnit) : null;
          item.delta = toRad(fAttr(el, 'delta', 0), angUnit);
          if (item.dirEnd === null) {
            // dirEnd absent : dérivé via delta + sens de rotation
            // convention LandXML = angle trigo standard (CCW+) ; 'cw' (horaire réel) => angle décroît
            const sgn = item.rot === 'cw' ? -1 : 1;
            item.dirEnd = (item.dirStart || 0) + sgn * item.delta;
          }
          prevDir = item.dirEnd;
        } else if (tag === 'Spiral') {
          const rs = getAttr(el, 'radiusStart', 'INF');
          const re = getAttr(el, 'radiusEnd', 'INF');
          item.radiusStart = rs === 'INF' ? Infinity : parseFloat(rs);
          item.radiusEnd = re === 'INF' ? Infinity : parseFloat(re);
          item.dirStart = el.hasAttribute('dirStart') ? toRad(fAttr(el, 'dirStart', 0), angUnit) : prevDir;
          let thetaMag;
          if (el.hasAttribute('theta')) {
            thetaMag = Math.abs(toRad(fAttr(el, 'theta', 0), angUnit));
          } else {
            const k0 = isFinite(item.radiusStart) ? 1 / item.radiusStart : 0;
            const k1 = isFinite(item.radiusEnd) ? 1 / item.radiusEnd : 0;
            thetaMag = Math.abs((k0 + k1) / 2 * len);
          }
          item.dirEnd = el.hasAttribute('dirEnd')
            ? toRad(fAttr(el, 'dirEnd', 0), angUnit)
            : (item.dirStart || 0) + (item.rot === 'cw' ? -1 : 1) * thetaMag;
          prevDir = item.dirEnd;
          const constant = getAttr(el, 'constant', null);
          if (constant !== null) {
            item.A = parseFloat(constant);
          } else {
            const Rfin = isFinite(item.radiusStart) ? item.radiusStart : item.radiusEnd;
            item.A = isFinite(Rfin) ? Math.sqrt(Rfin * len) : null;
          }
        }
        if (item.dirStart == null) item.dirStart = 0; // 1er élément sans direction exploitable (cas limite)
        horiz.push(item);
        cum += len;
      }
    }

    // Profil en long
    const profileEl = firstByLocalName(alignEl, 'Profile');
    const vert = [];
    if (profileEl) {
      const profAlign = firstByLocalName(profileEl, 'ProfAlign');
      if (profAlign) {
        for (let i = 0; i < profAlign.childNodes.length; i++) {
          const el = profAlign.childNodes[i];
          if (el.nodeType !== 1) continue;
          const tag = el.localName || el.nodeName.split(':').pop();
          if (tag !== 'PVI' && tag !== 'CircCurve' && tag !== 'ParaCurve') continue;
          const t = textOf(el).split(/\s+/).map(Number);
          vert.push({
            type: tag,
            sta: t[0],
            elev: t[1],
            length: el.hasAttribute('length') ? fAttr(el, 'length', null) : null,
            radius: el.hasAttribute('radius') ? fAttr(el, 'radius', null) : null,
          });
        }
      }
    }

    return {
      name, staStart, length,
      computedEnd: cum,
      horiz,
      vertRaw: vert,
    };
  }

  // ---------- Dérivation du profil vertical (tangentes + rayons) ----------
  function buildVerticalElements(vertRaw) {
    if (!vertRaw || vertRaw.length < 2) return [];
    const out = [];
    function grade(a, b) { return (b.elev - a.elev) / (b.sta - a.sta); }
    let prevPoint = { sta: vertRaw[0].sta, elev: vertRaw[0].elev };
    for (let i = 1; i < vertRaw.length - 1; i++) {
      const item = vertRaw[i];
      const gIn = grade(vertRaw[i - 1], item);
      const gOut = grade(item, vertRaw[i + 1]);
      if (item.length != null) {
        const L = item.length, R = item.radius;
        const csSta = item.sta - L / 2, csElev = item.elev - gIn * (L / 2);
        const ceSta = item.sta + L / 2, ceElev = item.elev + gOut * (L / 2);
        out.push({ type: 'Tangente', kmStart: prevPoint.sta, kmEnd: csSta, length: csSta - prevPoint.sta, grade: gIn });
        const dg = gOut - gIn;
        const Kval = dg !== 0 ? Math.abs(L / (dg * 100)) : Infinity;
        out.push({
          type: 'RayonVertical', kmStart: csSta, kmEnd: ceSta, length: L, radius: R,
          gradeIn: gIn, gradeOut: gOut, K: Kval,
          shape: gIn > gOut ? 'convexe' : (gIn < gOut ? 'concave' : 'plat'),
          elevAtVertex: item.elev, staVertex: item.sta,
        });
        prevPoint = { sta: ceSta, elev: ceElev };
      } else {
        out.push({ type: 'Tangente', kmStart: prevPoint.sta, kmEnd: item.sta, length: item.sta - prevPoint.sta, grade: gIn });
        prevPoint = { sta: item.sta, elev: item.elev };
      }
    }
    const last = vertRaw[vertRaw.length - 1];
    const gFinal = grade(vertRaw[vertRaw.length - 2], last);
    out.push({ type: 'Tangente', kmStart: prevPoint.sta, kmEnd: last.sta, length: last.sta - prevPoint.sta, grade: gFinal });
    return out;
  }

  // ============================================================
  // CONTRÔLES DE CONFORMITÉ (VSS / OETV / OCR)
  // Référence : manuels contexte+techniques, voir reference-technique-routes-vss.md
  // ============================================================

  function Rmin(Vp, fT, q) { // R = V² / (127 (fT+q))   [V en km/h, q en fraction]
    return (Vp * Vp) / (127 * (fT + q));
  }
  function AminFromR(Vp) { return Vp / 3; } // règle d'usage simplifiée (A_min ≈ R/3 — cf. GC-calculs feuille GéomHoriz)
  // L_Gmax = 15·Vp (VSS 40 100a, Tab.1, p.2 — confirmé sur le texte normatif ET la table chiffrée officielle ;
  // la valeur précédente 20·Vp était erronée).
  function maxAlignLength(Vp) { return 15 * Vp; }

  // ---------- Interpolation linéaire générique sur une table Vp -> valeur (VSS, valeurs officielles) ----------
  function interpVpTable(table, Vp) {
    const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
    if (Vp <= keys[0]) return table[keys[0]];
    if (Vp >= keys[keys.length - 1]) return table[keys[keys.length - 1]];
    for (let i = 0; i < keys.length - 1; i++) {
      const k0 = keys[i], k1 = keys[i + 1];
      if (Vp >= k0 && Vp <= k1) {
        const t = (Vp - k0) / (k1 - k0);
        return table[k0] + t * (table[k1] - table[k0]);
      }
    }
    return table[keys[keys.length - 1]];
  }

  // VSS 40 110, Tab.1 p.5 — déclivité maximale recommandée, fonction de Vp
  const I_MAX_TABLE = { 40: 12, 60: 10, 80: 8, 100: 6, 120: 4 };
  function iMaxNorm(Vp) { return interpVpTable(I_MAX_TABLE, Vp); }
  const I_MIN_NORM = 0.5; // VSS 40 110 §11 — déclivité minimale recommandée (drainage)

  // VSS 40 110, Tab.2 p.6 — rayons de raccordement verticaux minimaux RECOMMANDÉS (visibilité d'arrêt / confort+phares)
  const RV_CONVEXE_TABLE = { 40: 1500, 50: 2100, 60: 3000, 70: 4200, 80: 6000, 90: 8500, 100: 12500, 110: 20000 };
  const RV_CONCAVE_TABLE = { 40: 800, 50: 1200, 60: 1600, 70: 2500, 80: 3500, 90: 4500, 100: 6000, 110: 8000 };
  function RvMinNorm(Vp, shape) {
    const table = shape === 'convexe' ? RV_CONVEXE_TABLE : RV_CONCAVE_TABLE;
    return interpVpTable(table, Vp);
  }

  function stoppingDistance(VkmH, tr, fL, i) {
    // d_arrêt S_A = V/3.6 * tr + V² / (254 (fL ± i))  — VSS 40 090b (t=2.0 s confirmé officiellement)
    // NB : la norme elle-même précise que seules les valeurs des abaques Fig.1/Fig.2 font foi ;
    // cette formule analytique est qualifiée de « simplifiée » par le texte normatif.
    return (VkmH / 3.6) * tr + (VkmH * VkmH) / (254 * (fL + i));
  }
  function RvMinComfort(VkmH) { // Rv-min = v[m/s]² / 0.8   (feuille DistVisibilité!F32) — critère de confort uniquement
    const v = VkmH / 3.6;
    return (v * v) / 0.8;
  }
  // S_D disponible dans un raccordement convexe, cas sans dépassement, h0=1.00m hg=0.15m (VSS 40 110, Annexe 1, p.11)
  function sightDistanceConvex(Rv) { return 2 * Math.sqrt(Math.max(0, Rv)); }

  // ---------- Coefficients de frottement — valeurs usuelles proposées (Tab. 17.7, référence TRAN) ----------
  // CFL = frottement longitudinal (distance d'arrêt) ; CFT = frottement transversal (R_min, dévers)
  const CFL_CH_RGD = { 60: 0.49, 80: 0.44, 100: 0.40, 120: 0.36 }; // routes à grand débit (CH)
  const CFL_CH_AUTRES = { 40: 0.43, 60: 0.35, 80: 0.30 }; // autres routes (CH)
  const CFL_USA = { 40: 0.38, 60: 0.33, 80: 0.30, 100: 0.29, 120: 0.28 };
  const CFT_CH = { 40: 0.21, 60: 0.17, 80: 0.14, 100: 0.12, 120: 0.10 };
  const CFT_USA = { 40: 0.17, 60: 0.15, 80: 0.14, 100: 0.12, 120: 0.09 };
  function suggestFL(Vp, regime) {
    const t = regime === 'ch_rgd' ? CFL_CH_RGD : (regime === 'usa' ? CFL_USA : CFL_CH_AUTRES);
    return interpVpTable(t, Vp);
  }
  function suggestFT(Vp, regime) {
    const t = regime === 'usa' ? CFT_USA : CFT_CH;
    return interpVpTable(t, Vp);
  }

  // ---------- Dévers en courbe — formule générale officielle p = 2 + 5·(R_min(Vp,7%)/R) [%] ----------
  // (confirmée par l'utilisateur — réf. TRAN 23.5 — bornée entre 2% (grand rayon) et 7% (R=R_min))
  const R_MIN_P7_TABLE = { 40: 45, 50: 75, 60: 120, 70: 175, 80: 240, 90: 320, 100: 420, 110: 525, 120: 650 }; // VSS 40 100a Tab.1
  function deversCalcule(Vp, R) {
    if (!(R > 0)) return null;
    const rmin7 = interpVpTable(R_MIN_P7_TABLE, Vp);
    const p = 2 + 5 * (rmin7 / R);
    return Math.max(2, Math.min(7, p));
  }

  function evaluateHorizontal(horiz, params) {
    const Vp = params.Vp || 80;
    const fTRegime = params.fTRegime || 'ch';
    const fT = params.fT != null ? params.fT : suggestFT(Vp, fTRegime);
    const qUsual = params.q != null ? params.q : 0.07; // q_design — dévers maximal de calcul (7%), utilisé pour R_min uniquement
    const rMin = Rmin(Vp, fT, qUsual);
    const lMax = maxAlignLength(Vp);

    return horiz.map((el, idx) => {
      const checks = [];
      if (el.type === 'Curve' && el.radius) {
        checks.push({
          label: `R ≥ R_min(${Vp} km/h)`,
          value: el.radius, threshold: rMin,
          ok: el.radius >= rMin,
          detail: `R = ${el.radius.toFixed(1)} m vs R_min = ${rMin.toFixed(1)} m (f_T=${fT}, q_design=${(qUsual * 100).toFixed(0)}%)`,
        });
        // Dévers calculé pour CE rayon (formule générale p=2+5·Rmin7%/R) — valeur informative, pas un contrôle pass/fail
        const pDevers = deversCalcule(Vp, el.radius);
        if (pDevers != null) {
          checks.push({
            label: `Dévers calculé p(R)`,
            value: pDevers, threshold: null,
            ok: true, severity: 'info',
            detail: `p = 2 + 5·R_min(${Vp})/R = ${pDevers.toFixed(2)} % (R=${el.radius.toFixed(1)} m)`,
          });
        }
      }
      if (el.type === 'Spiral' && el.A != null) {
        const Rfin = isFinite(el.radiusStart) ? el.radiusStart : el.radiusEnd;
        if (Rfin) {
          // VSS 40 100a §6, p.3 : domaine R/3 ≤ A ≤ R (deux conditions explicites et distinctes de la norme)
          const AminGuide = Rfin / 3;
          const AmaxGuide = Rfin;
          checks.push({
            label: 'A ≥ R/3 (perceptibilité du virage)',
            value: el.A, threshold: AminGuide,
            ok: el.A >= AminGuide,
            detail: `A = ${el.A.toFixed(1)} m vs A_min = ${AminGuide.toFixed(1)} m (R=${Rfin.toFixed(1)} m)`,
          });
          checks.push({
            label: 'A ≤ R (perceptibilité de la clothoïde)',
            value: el.A, threshold: AmaxGuide,
            ok: el.A <= AmaxGuide,
            detail: `A = ${el.A.toFixed(1)} m vs A_max = R = ${AmaxGuide.toFixed(1)} m`,
          });
        }
      }
      if (el.type === 'Line') {
        checks.push({
          label: `L ≤ L_Gmax = 15·V_p (VSS 40 100a Tab.1)`,
          value: el.length, threshold: lMax,
          ok: el.length <= lMax,
          detail: `L = ${el.length.toFixed(1)} m vs L_Gmax = ${lMax.toFixed(1)} m`,
          severity: 'info', // dépassement fréquent et pas toujours critique
        });
      }
      const blocking = checks.filter(c => c.severity !== 'info');
      const status = checks.length === 0 ? 'info' : (blocking.length === 0 ? 'info' : (blocking.every(c => c.ok) ? 'ok' : 'fail'));
      return Object.assign({}, el, { idx, checks, status });
    });
  }

  function evaluateSConsecutiveClothoids(horizEvaluated) {
    // Clothoïde en S : deux clothoïdes STRICTEMENT adjacentes (pas d'arc/alignement entre elles),
    // de sens de rotation opposé (point d'inflexion). Règle : 0.6667 <= A1/A2 <= 1.5
    const notes = [];
    for (let i = 0; i < horizEvaluated.length - 1; i++) {
      const a = horizEvaluated[i], b = horizEvaluated[i + 1];
      if (a.type === 'Spiral' && b.type === 'Spiral' && a.A && b.A && a.rot !== b.rot) {
        const ratio = a.A / b.A;
        const ok = ratio >= 0.6667 && ratio <= 1.5;
        notes.push({
          idxA: a.idx, idxB: b.idx, ratio, ok,
          detail: `A1/A2 = ${ratio.toFixed(3)} (A1=${a.A.toFixed(1)}, A2=${b.A.toFixed(1)}) — borne [0.6667 ; 1.5]`,
        });
      }
    }
    return notes;
  }

  function evaluateVertical(vertElements, params) {
    const Vp = params.Vp || 80;
    const rvMinComf = RvMinComfort(Vp);
    const iMax = iMaxNorm(Vp);
    // f_L proposé depuis la table officielle (Tab. 17.7) par défaut, substituable par l'utilisateur
    const fLRegime = params.fLRegime || 'ch_autres';
    const fL = params.fL != null ? params.fL : suggestFL(Vp, fLRegime);
    const tr = params.tr != null ? params.tr : 2.0; // VSS 40 090b — confirmé officiellement
    return vertElements.map((el, idx) => {
      const checks = [];
      if (el.type === 'RayonVertical') {
        // Retour utilisateur : les valeurs du Tab.2 VSS 40 110 sont des OPTIMUMS indicatifs, pas des valeurs
        // limites. Le contrôle pratique réel se fait via la visibilité d'arrêt (S_D vs S_A) et le confort
        // dynamique — ce sont ces deux critères qui sont bloquants ; le Tab.2 reste affiché à titre de référence.
        const rvMinNorm = RvMinNorm(Vp, el.shape);
        checks.push({
          label: `Rv ≥ Rv-min optimum ${el.shape} (${Vp} km/h, VSS 40 110 Tab.2 — valeur indicative)`,
          value: el.radius, threshold: rvMinNorm,
          ok: el.radius >= rvMinNorm,
          detail: `Rv = ${el.radius.toFixed(1)} m vs Rv-min optimum = ${rvMinNorm.toFixed(1)} m (${el.shape}) — valeur recommandée, pas une limite`,
          severity: 'info',
        });
        // Critère de confort dynamique — BLOQUANT (contrôle pratique de référence)
        checks.push({
          label: `Rv ≥ Rv-min confort(${Vp} km/h)`,
          value: el.radius, threshold: rvMinComf,
          ok: el.radius >= rvMinComf,
          detail: `Rv = ${el.radius.toFixed(1)} m vs Rv-min confort = ${rvMinComf.toFixed(1)} m`,
        });
        // S_A : visibilité disponible (raccordement convexe, cas sans dépassement) vs distance d'arrêt requise — BLOQUANT
        if (el.shape === 'convexe') {
          const sD = sightDistanceConvex(el.radius);
          const iMoy = ((el.gradeIn || 0) + (el.gradeOut || 0)) / 2;
          const sA = stoppingDistance(Vp, tr, fL, iMoy);
          checks.push({
            label: `S_D ≥ S_A (visibilité d'arrêt, VSS 40 090b/40 110)`,
            value: sD, threshold: sA,
            ok: sD >= sA,
            detail: `S_D ≈ 2√Rv = ${sD.toFixed(1)} m vs S_A ≈ ${sA.toFixed(1)} m (t=${tr}s, f_L=${fL.toFixed(2)} [${fLRegime}]) — seuls les abaques officiels VSS 40 090b font foi en cas de litige`,
          });
        }
      }
      if (el.type === 'Tangente') {
        const absI = Math.abs(el.grade) * 100;
        checks.push({
          label: `Déclivité ≤ i_max(${Vp} km/h) = ${iMax.toFixed(1)}% (VSS 40 110 Tab.1)`,
          value: absI, threshold: iMax,
          ok: absI <= iMax,
          detail: `i = ${(el.grade * 100).toFixed(2)} % vs i_max = ${iMax.toFixed(1)} %`,
        });
        checks.push({
          label: `Déclivité ≥ i_min = ${I_MIN_NORM}% (drainage, VSS 40 110 §11)`,
          value: absI, threshold: I_MIN_NORM,
          ok: absI >= I_MIN_NORM,
          detail: `i = ${(el.grade * 100).toFixed(2)} % vs i_min = ${I_MIN_NORM} % (recommandation, pas une valeur limite)`,
          severity: 'info',
        });
      }
      const blocking = checks.filter(c => c.severity !== 'info');
      const status = checks.length === 0 ? 'info' : (blocking.length === 0 ? 'info' : (blocking.every(c => c.ok) ? 'ok' : 'fail'));
      return Object.assign({}, el, { idx, checks, status });
    });
  }

  // ---------- Module gabarit / balayage (manuel "techniques") ----------
  const NORMALIZED_VEHICLES = {
    VL: { label: 'Voiture légère (VSS)', L: 1.90, E: 3.00, Pa: 0.90, voie: 1.80, longueur: 5.10, rayonBraquage: 6.50 },
    Bus12: { label: 'Bus 12 m', L: 2.50, E: 6.08, Pa: 2.30, voie: 2.00, longueur: 12.00, rayonBraquage: 9.50 },
    Bus15: { label: 'Bus 15 m', L: 2.50, E: 6.08, Pa: 2.30, voie: 2.40, longueur: 15.00, rayonBraquage: 8.40 },
    Camion1: { label: 'Camion 1', L: 2.60, E: 5.00, Pa: 1.50, voie: 2.50, longueur: 9.40, rayonBraquage: 7.50 },
    Camion2: { label: 'Camion 2', L: 2.60, E: 5.00, Pa: 1.80, voie: 2.50, longueur: 11.00, rayonBraquage: 10.00 },
  };

  function swept(R, E, L, Pa) {
    const domainOk = (R * R) > (E * E + (L * L) / 4);
    if (!domainOk) return { domainOk };
    const Ri = Math.sqrt(R * R - E * E - (L * L) / 4);
    const Re = Math.sqrt(Math.pow(R + L / 2, 2) + Math.pow(E + Pa, 2));
    return { domainOk, Ri, Re, B: Re - Ri };
  }

  function checkOETVring(Re2, Ri2) {
    // anneau: De <= 25.00, Di >= 10.60 (diamètres)
    const De = 2 * Re2, Di = 2 * Ri2;
    return { De, Di, ok: De <= 25.00 && Di >= 10.60 };
  }

  // ============================================================
  // VSS 40 105b — Surlargeur en courbe (module distinct de l'anneau OETV ci-dessus,
  // applicable à TOUTE courbe courante du tracé, pas seulement aux manœuvres à faible rayon)
  // ============================================================
  const SURLARGEUR_CATEGORIES = {
    A: { label: 'A — Semi-remorque / camion+remorque / autocar / bus articulé', D: 10.0 },
    B: { label: 'B — Camion 3-4 essieux(+remorque) / bus standard / car', D: 8.7 },
    C: { label: 'C — Camion et grand véhicule de livraison (≤ 6,5 t)', D: 6.7 },
    D: { label: 'D — Voiture particulière / petit véhicule (≤ 3,5 t)', D: 4.0 },
  };

  // e = Ra - sqrt(Ra² - D²)  — surlargeur maximale par voie (VSS 40 105b §6, p.8)
  function surlargeurMax(Ra, D) {
    if (!(Ra > D)) return null; // domaine non valide (Ra doit être > D)
    return Ra - Math.sqrt(Ra * Ra - D * D);
  }

  // Évalue la surlargeur déterminante pour une courbe du tracé en plan.
  // Ra [m] rayon extérieur de la voie élargie ; phiTotalGon [gon] angle total du virage (delta, converti) ; catKey catégorie A-D.
  function evaluateSurlargeur(Ra, phiTotalGon, catKey) {
    const cat = SURLARGEUR_CATEGORIES[catKey] || SURLARGEUR_CATEGORIES.B;
    const D = cat.D;
    if (!(Ra >= 11.25 && Ra <= 500)) {
      return { applicable: false, reason: `Hors domaine de validité de la norme (Ra doit être entre 11,25 m et 500 m ; Ra=${Ra.toFixed(1)} m)`, category: cat };
    }
    const e = surlargeurMax(Ra, D);
    if (e === null) return { applicable: false, reason: 'Ra ≤ D — géométrie incompatible avec le véhicule déterminant', category: cat };
    // Phi_Grenz = 5.5 * arcsin(D/Ra), en grades (D/Ra en radians -> *200/pi pour convertir en gon)
    const phiGrenz = 5.5 * Math.asin(Math.min(1, D / Ra)) * (200 / Math.PI);
    const needsFullWidth = phiTotalGon == null || phiTotalGon >= phiGrenz;
    // Abaque p (facteur de réduction) non digitalisé ici : on applique e intégral si phi>=phiGrenz,
    // et un indicatif "réduction possible" sinon (p<100%, valeur exacte à lire sur l'abaque officiel Fig.4).
    const eEff = needsFullWidth ? e : null;
    const dispense = e <= 0.10; // VSS 40 105b §8.5 : pas de surlargeur si e' ≤ 0,10 m/voie
    return {
      applicable: true,
      category: cat, D, Ra, e, phiGrenz, phiTotalGon,
      needsFullWidth, eEff, dispense,
      detail: dispense
        ? `e = ${e.toFixed(3)} m ≤ 0,10 m → surlargeur non requise (VSS 40 105b §8.5)`
        : (needsFullWidth
          ? `e = ${e.toFixed(3)} m (angle total ${phiTotalGon != null ? phiTotalGon.toFixed(1) : '?'} gon ≥ Φ_Grenz=${phiGrenz.toFixed(1)} gon → surlargeur intégrale)`
          : `e_max = ${e.toFixed(3)} m, mais angle total < Φ_Grenz=${phiGrenz.toFixed(1)} gon → réduction par facteur p possible (abaque Fig.4, non digitalisé ici — valeur indicative = e_max)`),
    };
  }

  // ============================================================
  // ÉCHANTILLONNAGE GÉOMÉTRIQUE (pour tracé plan SVG/DXF)
  // Convention azimut : θ mesuré depuis le Nord, sens horaire.
  // Vecteur direction en (E,N) : dE = sin(θ), dN = cos(θ)
  // ============================================================

  function dist2(a, b) {
    const dE = a.E - b.E, dN = a.N - b.N;
    return Math.sqrt(dE * dE + dN * dN);
  }

  function sampleLine(el) {
    return [el.start, el.end];
  }

  function sampleCurve(el, nSeg) {
    nSeg = nSeg || Math.max(8, Math.round((el.delta || 0.3) * 24));
    const R = el.radius, C = el.center;
    const angle0 = Math.atan2(el.start.E - C.E, el.start.N - C.N);
    const delta = Math.abs(el.delta || 0);
    const candidates = [angle0 + delta, angle0 - delta];
    let best = null, bestErr = Infinity;
    for (const angle1 of candidates) {
      const endCand = { E: C.E + R * Math.sin(angle1), N: C.N + R * Math.cos(angle1) };
      const err = dist2(endCand, el.end);
      if (err < bestErr) { bestErr = err; best = angle1; }
    }
    const pts = [];
    for (let i = 0; i <= nSeg; i++) {
      const a = angle0 + (best - angle0) * (i / nSeg);
      pts.push({ E: C.E + R * Math.sin(a), N: C.N + R * Math.cos(a) });
    }
    return pts;
  }

  function sampleSpiral(el, nSeg) {
    nSeg = nSeg || Math.max(40, Math.round(el.length));
    const L = el.length;
    const k0 = isFinite(el.radiusStart) ? 1 / el.radiusStart : 0;
    const k1 = isFinite(el.radiusEnd) ? 1 / el.radiusEnd : 0;

    function integrate(sign) {
      // Convention LandXML vérifiée empiriquement : dir = atan2(dN, dE) (E=x, N=y, math standard)
      const pts = [{ E: el.start.E, N: el.start.N }];
      let theta = el.dirStart;
      let E = el.start.E, N = el.start.N;
      const ds = L / nSeg;
      for (let i = 1; i <= nSeg; i++) {
        const s = i * ds;
        const k = k0 + (k1 - k0) * (s / L);
        theta += sign * k * ds;
        E += Math.cos(theta) * ds;
        N += Math.sin(theta) * ds;
        pts.push({ E, N });
      }
      return pts;
    }
    const candA = integrate(1), candB = integrate(-1);
    const errA = dist2(candA[candA.length - 1], el.end);
    const errB = dist2(candB[candB.length - 1], el.end);
    return errA <= errB ? candA : candB;
  }

  function sampleElement(el) {
    if (el.type === 'Line') return sampleLine(el);
    if (el.type === 'Curve') return sampleCurve(el);
    if (el.type === 'Spiral') return sampleSpiral(el);
    return [];
  }

  // ---------- Libellés français des types d'éléments (affichage uniquement — les valeurs
  // internes 'Line'/'Curve'/'Spiral'/'Tangente'/'RayonVertical' restent inchangées en interne,
  // issues du vocabulaire LandXML / utilisées pour les comparaisons de type dans le code) ----------
  const TYPE_LABELS_FR = {
    Line: 'Alignement droit',
    Curve: 'Courbe circulaire',
    Spiral: 'Clothoïde',
    Tangente: 'Tangente',
    RayonVertical: 'Raccordement vertical',
  };
  function typeLabelFR(type) { return TYPE_LABELS_FR[type] || type; }

  return {
    parseLandXML, buildVerticalElements,
    evaluateHorizontal, evaluateVertical, evaluateSConsecutiveClothoids,
    Rmin, maxAlignLength, stoppingDistance, RvMinComfort,
    iMaxNorm, I_MIN_NORM, RvMinNorm, sightDistanceConvex, interpVpTable,
    suggestFL, suggestFT, deversCalcule, R_MIN_P7_TABLE,
    CFL_CH_RGD, CFL_CH_AUTRES, CFL_USA, CFT_CH, CFT_USA,
    NORMALIZED_VEHICLES, swept, checkOETVring,
    SURLARGEUR_CATEGORIES, surlargeurMax, evaluateSurlargeur,
    sampleElement, sampleLine, sampleCurve, sampleSpiral, dist2,
    TYPE_LABELS_FR, typeLabelFR,
  };
});
