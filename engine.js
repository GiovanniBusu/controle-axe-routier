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
  // (confirmée par l'utilisateur — réf. TRAN 23.5 — bornée entre 3% (minimum retenu, grands rayons) et 7% (R=R_min))
  const R_MIN_P7_TABLE = { 40: 45, 50: 75, 60: 120, 70: 175, 80: 240, 90: 320, 100: 420, 110: 525, 120: 650 }; // VSS 40 100a Tab.1
  function deversCalcule(Vp, R) {
    if (!(R > 0)) return null;
    const rmin7 = interpVpTable(R_MIN_P7_TABLE, Vp);
    const p = 2 + 5 * (rmin7 / R);
    return Math.max(3, Math.min(7, p)); // retour utilisateur : dévers minimum = 3 %
  }

  // ---------- Tables VSS 40 100a Tab.1 (valeurs indicatives, non bloquantes) ----------
  const L_GMIN_TABLE = { 40: 30, 50: 40, 60: 50, 70: 65, 80: 90, 90: 115, 100: 150, 110: 190, 120: 250 };
  const L_ARC_MIN_TABLE = { 40: 25, 50: 35, 60: 55, 70: 70, 80: 90, 90: 115, 100: 150, 110: 180, 120: 230 };

  // ---------- Fabrique de contrôle avec gestion de la tolérance ----------
  // kind 'min' : value >= limit ; kind 'max' : value <= limit.
  // state : 'ok' | 'tolerance' (hors limite mais dans la tolérance %, orange) | 'fail'.
  function mkCheck(o, tol) {
    const strict = o.kind === 'min' ? o.value >= o.limit : o.value <= o.limit;
    let state = strict ? 'ok' : 'fail';
    if (!strict && tol > 0) {
      const within = o.kind === 'min' ? o.value >= o.limit * (1 - tol) : o.value <= o.limit * (1 + tol);
      if (within) state = 'tolerance';
    }
    let detail = o.detail;
    if (state === 'tolerance') detail += ` — hors limite, dans la tolérance de ${(tol * 100).toFixed(1).replace(/\.0$/, '')} %`;
    return { label: o.label, key: o.key, value: o.value, threshold: o.limit, kind: o.kind, unit: o.unit || '',
      ok: strict, state, detail, severity: o.severity };
  }
  function aggStatus(checks) {
    const blocking = checks.filter(c => c.severity !== 'info');
    if (!blocking.length) return 'info';
    if (blocking.some(c => c.state === 'fail')) return 'fail';
    if (blocking.some(c => c.state === 'tolerance')) return 'tolerance';
    return 'ok';
  }
  const CALC_DEFAULT = { horiz: true, devers: true, derapage: true, deltaI: true, vert: true, visib: true, giro: true, surl: true };

  function evaluateHorizontal(horiz, params) {
    const Vp = params.Vp || 80;
    const fTRegime = params.fTRegime || 'ch';
    const fT = params.fT != null ? params.fT : suggestFT(Vp, fTRegime);
    const qUsual = params.q != null ? params.q : 0.07; // q_design — dévers maximal de calcul (7%), utilisé pour R_min uniquement
    const tol = params.tolerance > 0 ? params.tolerance : 0; // fraction (0 = aucune tolérance)
    const calc = Object.assign({}, CALC_DEFAULT, params.calc || {});
    const rMin = Rmin(Vp, fT, qUsual);
    const lMax = maxAlignLength(Vp);
    const lGmin = interpVpTable(L_GMIN_TABLE, Vp);
    const lArcMin = interpVpTable(L_ARC_MIN_TABLE, Vp);

    const out = horiz.map((el, idx) => {
      const checks = [];
      if (calc.horiz) {
        if (el.type === 'Curve' && el.radius) {
          checks.push(mkCheck({
            key: 'Rmin', label: `R ≥ R_min(${Vp} km/h)`, kind: 'min', value: el.radius, limit: rMin, unit: 'm',
            detail: `R = ${el.radius.toFixed(1)} m ≥ R_min = ${rMin.toFixed(1)} m (f_T=${fT}, q_design=${(qUsual * 100).toFixed(0)}%)`,
          }, tol));
          checks.push(mkCheck({
            key: 'Larc', label: `L ≥ L_min arc (indicatif, VSS 40 100a Tab.1)`, kind: 'min', value: el.length, limit: lArcMin, unit: 'm', severity: 'info',
            detail: `L = ${el.length.toFixed(1)} m ≥ L_min = ${lArcMin.toFixed(1)} m (valeur indicative)`,
          }, tol));
        }
        if (el.type === 'Spiral' && el.A != null) {
          const Rfin = isFinite(el.radiusStart) ? el.radiusStart : el.radiusEnd;
          if (Rfin) {
            // VSS 40 100a §6, p.3 : domaine R/3 ≤ A ≤ R (deux conditions explicites et distinctes de la norme)
            checks.push(mkCheck({
              key: 'Amin', label: 'A ≥ R/3 (perceptibilité du virage)', kind: 'min', value: el.A, limit: Rfin / 3, unit: 'm',
              detail: `A = ${el.A.toFixed(1)} m ≥ A_min = R/3 = ${(Rfin / 3).toFixed(1)} m (R=${Rfin.toFixed(1)} m)`,
            }, tol));
            checks.push(mkCheck({
              key: 'Amax', label: 'A ≤ R (perceptibilité de la clothoïde)', kind: 'max', value: el.A, limit: Rfin, unit: 'm',
              detail: `A = ${el.A.toFixed(1)} m ≤ A_max = R = ${Rfin.toFixed(1)} m`,
            }, tol));
          }
        }
        if (el.type === 'Line') {
          checks.push(mkCheck({
            key: 'Lmax', label: `L ≤ L_Gmax = 15·V_p (VSS 40 100a Tab.1)`, kind: 'max', value: el.length, limit: lMax, unit: 'm', severity: 'info', // dépassement fréquent, pas toujours critique
            detail: `L = ${el.length.toFixed(1)} m ≤ L_Gmax = ${lMax.toFixed(1)} m`,
          }, tol));
          checks.push(mkCheck({
            key: 'Lmin', label: `L ≥ L_Gmin (indicatif, VSS 40 100a Tab.1)`, kind: 'min', value: el.length, limit: lGmin, unit: 'm', severity: 'info',
            detail: `L = ${el.length.toFixed(1)} m ≥ L_Gmin = ${lGmin.toFixed(1)} m (valeur indicative)`,
          }, tol));
        }
      }
      if (calc.derapage && el.type === 'Curve' && el.radius) {
        // Dérapage (TRAN 17.6.3, formule 17.31 : R_min = V²/(g·(CFT+p))) ⇔ f_T requis = V²/(127·R) − p/100 ≤ f_T admissible
        const pD = deversCalcule(Vp, el.radius);
        const fTreq = (Vp * Vp) / (127 * el.radius) - pD / 100;
        checks.push(mkCheck({
          key: 'derapage', label: 'Dérapage : f_T requis ≤ f_T admissible', kind: 'max', value: fTreq, limit: fT, unit: '',
          detail: `f_T requis = V²/(127·R) − p/100 = ${fTreq.toFixed(3)} ≤ f_T = ${fT} (p = ${pD.toFixed(2)} %, R = ${el.radius.toFixed(1)} m)`,
        }, tol));
      }
      if (calc.devers && el.type === 'Curve' && el.radius) {
        // Dévers calculé pour CE rayon (p = 2 + 5·R_min(Vp)/R, minimum 3 %) — valeur informative, pas un contrôle pass/fail
        const pDevers = deversCalcule(Vp, el.radius);
        if (pDevers != null) {
          checks.push({
            label: 'Dévers calculé p(R)', key: 'devers', value: pDevers, threshold: null, unit: '%',
            ok: true, state: 'ok', severity: 'info',
            detail: `p = 2 + 5·R_min(${Vp})/R = ${pDevers.toFixed(2)} % (R=${el.radius.toFixed(1)} m ; minimum 3 %, maximum 7 %)`,
          });
        }
      }
      return Object.assign({}, el, { idx, checks });
    });

    // Clothoïdes en S — contrôle INTÉGRÉ à la géométrie horizontale : deux clothoïdes strictement adjacentes,
    // de sens de rotation opposé (point d'inflexion). Règle VSS 40 100a : 2/3 ≤ A1/A2 ≤ 3/2.
    if (calc.horiz) {
      for (let i = 0; i < out.length - 1; i++) {
        const a = out[i], b = out[i + 1];
        if (a.type === 'Spiral' && b.type === 'Spiral' && a.A && b.A && a.rot !== b.rot) {
          const ratio = a.A / b.A;
          const okLo = ratio >= 2 / 3, okHi = ratio <= 1.5;
          const within = (v, lim, kind) => kind === 'min' ? v >= lim * (1 - tol) : v <= lim * (1 + tol);
          let state = (okLo && okHi) ? 'ok' : ((tol > 0 && within(ratio, 2 / 3, 'min') && within(ratio, 1.5, 'max')) ? 'tolerance' : 'fail');
          const detail = `Clothoïdes en S #${a.idx}/#${b.idx} : A1/A2 = ${ratio.toFixed(3)} (A1=${a.A.toFixed(1)}, A2=${b.A.toFixed(1)}) ∈ [0.667 ; 1.5]` + (state === 'tolerance' ? ' — hors limite, dans la tolérance' : '');
          [a, b].forEach(x => x.checks.push({
            label: 'Clothoïde en S : 2/3 ≤ A1/A2 ≤ 3/2', key: 'S', value: ratio, threshold: null, unit: '',
            ok: okLo && okHi, state, detail,
          }));
        }
      }
    }
    // Δi — rampe de dévers (TRAN Formule 23.4 : Δi = (p2·a2 ± p1·a1)/L ; Δi_min = 0,1·a, Formule 23.5)
    // Hypothèse : axe de rotation = axe de chaussée, a = largeur de voie (m) ; dévers de l'alignement droit = toit (−toit % côté extérieur).
    // Clothoïde simple : L = longueur de la clothoïde. Clothoïdes en S : changement réparti de part et d'autre du point de bascule,
    // L = L1 + L2 (les deux clothoïdes), même Δi porté par les deux.
    if (calc.deltaI) {
      const a = params.largeurVoie > 0 ? params.largeurVoie : 3.0;
      const toit = params.toit != null ? params.toit : 2.5;
      const dMax = params.deltaIMax != null ? params.deltaIMax : 1.5;
      const minMode = params.deltaIMinMode || 'formule';
      const dMin = minMode === 'none' ? null : 0.1 * a;
      const pOf = e => (e && e.type === 'Curve' && e.radius) ? deversCalcule(Vp, e.radius) : null;
      const done = new Set();
      for (let i = 0; i < out.length; i++) {
        const s = out[i];
        if (s.type !== 'Spiral' || done.has(i)) continue;
        const prev = out[i - 1], next = out[i + 1];
        let dI = null, L = s.length, desc = '', members = [i];
        if (next && next.type === 'Spiral' && next.rot !== s.rot && out[i - 1] && out[i + 2]) {
          const p1 = pOf(out[i - 1]), p2 = pOf(out[i + 2]);
          if (p1 != null && p2 != null) { L = s.length + next.length; dI = (p1 + p2) * a / L; members = [i, i + 1]; desc = `S : (p1 + p2)·a/(L1+L2) = (${p1.toFixed(2)} + ${p2.toFixed(2)})·${a}/${L.toFixed(1)}`; }
        } else if (prev && next) {
          const pp = pOf(prev), pn = pOf(next);
          if (pp == null && pn != null && prev.type === 'Line') { dI = (pn + toit) * a / L; desc = `(p + toit)·a/L = (${pn.toFixed(2)} + ${toit})·${a}/${L.toFixed(1)}`; }
          else if (pn == null && pp != null && next.type === 'Line') { dI = (pp + toit) * a / L; desc = `(p + toit)·a/L = (${pp.toFixed(2)} + ${toit})·${a}/${L.toFixed(1)}`; }
          else if (pp != null && pn != null) { dI = Math.abs(pn - pp) * a / L; desc = `|p2 − p1|·a/L = |${pn.toFixed(2)} − ${pp.toFixed(2)}|·${a}/${L.toFixed(1)}`; }
        }
        if (dI == null || !isFinite(dI) || dI < 0.001) continue; // pas de variation de dévers (p1 = p2) : rampe sans objet
        members.forEach(m => {
          done.add(m);
          const e = out[m];
          e.deltaI = dI; e.deltaIMax = dMax; e.deltaIMin = dMin;
          e.checks.push(mkCheck({ key: 'dImax', label: 'Δi ≤ Δi_max (rampe de dévers, Formule 23.4)', kind: 'max', value: dI, limit: dMax, unit: '%',
            detail: `Δi = ${dI.toFixed(3)} % ≤ Δi_max = ${dMax} % — ${desc}` }, tol));
          if (dMin != null) e.checks.push(mkCheck({ key: 'dImin', label: 'Δi ≥ Δi_min = 0,1·a (Formule 23.5)', kind: 'min', value: dI, limit: dMin, unit: '%',
            detail: `Δi = ${dI.toFixed(3)} % ≥ Δi_min = 0,1·a = ${dMin.toFixed(2)} %` }, tol));
        });
      }
    }
    return out.map(el => Object.assign(el, { status: aggStatus(el.checks) }));
  }

  // Conservée pour compatibilité (le contrôle est désormais intégré à evaluateHorizontal)
  function evaluateSConsecutiveClothoids(horizEvaluated) {
    const notes = [];
    horizEvaluated.forEach(el => (el.checks || []).filter(c => c.key === 'S').forEach(c => notes.push({ idxA: el.idx, ok: c.ok, ratio: c.value, detail: c.detail })));
    return notes;
  }

  function evaluateVertical(vertElements, params) {
    const Vp = params.Vp || 80;
    const tol = params.tolerance > 0 ? params.tolerance : 0;
    const calc = Object.assign({}, CALC_DEFAULT, params.calc || {});
    const rvMinComf = RvMinComfort(Vp);
    const iMax = iMaxNorm(Vp);
    // f_L proposé depuis la table officielle (Tab. 17.7) par défaut, substituable par l'utilisateur
    const fLRegime = params.fLRegime || 'ch_autres';
    const fL = params.fL != null ? params.fL : suggestFL(Vp, fLRegime);
    const tr = params.tr != null ? params.tr : 2.0; // VSS 40 090b — confirmé officiellement
    return vertElements.map((el, idx) => {
      const checks = [];
      const extra = {};
      if (el.type === 'RayonVertical') {
        // Géométrie du raccordement (VSS 40 110 Annexe 1) : T_V = R·Δi/2, f = T_V²/(2R)
        const dg = Math.abs((el.gradeOut || 0) - (el.gradeIn || 0));
        extra.tv = el.radius * dg / 2;
        extra.fv = extra.tv * extra.tv / (2 * el.radius);
        const iMoy = ((el.gradeIn || 0) + (el.gradeOut || 0)) / 2;
        extra.sA = stoppingDistance(Vp, tr, fL, iMoy); // distance d'arrêt requise
        extra.sD = el.shape === 'convexe' ? sightDistanceConvex(el.radius) : null; // distance de visibilité disponible
        if (calc.vert) {
          // Retour utilisateur : les valeurs du Tab.2 VSS 40 110 sont des OPTIMUMS indicatifs, pas des limites.
          // Contrôles bloquants : confort dynamique et visibilité d'arrêt (S_D ≥ S_A).
          const rvMinNorm = RvMinNorm(Vp, el.shape);
          checks.push(mkCheck({
            key: 'RvOpt', label: `Rv ≥ Rv-min optimum ${el.shape} (VSS 40 110 Tab.2 — indicatif)`, kind: 'min', value: el.radius, limit: rvMinNorm, unit: 'm', severity: 'info',
            detail: `Rv = ${el.radius.toFixed(1)} m ≥ Rv-min optimum = ${rvMinNorm.toFixed(1)} m (${el.shape}) — valeur recommandée, pas une limite`,
          }, tol));
          checks.push(mkCheck({
            key: 'RvConf', label: `Rv ≥ Rv-min confort(${Vp} km/h)`, kind: 'min', value: el.radius, limit: rvMinComf, unit: 'm',
            detail: `Rv = ${el.radius.toFixed(1)} m ≥ Rv-min confort = ${rvMinComf.toFixed(1)} m`,
          }, tol));
        }
        if (calc.visib && extra.sD != null) {
          checks.push(mkCheck({
            key: 'SD', label: `S_D ≥ S_A (visibilité d'arrêt, VSS 40 090b/40 110)`, kind: 'min', value: extra.sD, limit: extra.sA, unit: 'm',
            detail: `S_D = 2√Rv = ${extra.sD.toFixed(1)} m ≥ S_A = ${extra.sA.toFixed(1)} m (t=${tr} s, f_L=${fL.toFixed(2)} [${fLRegime}])`,
          }, tol));
        }
      }
      if (el.type === 'Tangente' && calc.vert) {
        const absI = Math.abs(el.grade) * 100;
        checks.push(mkCheck({
          key: 'imax', label: `Déclivité ≤ i_max(${Vp} km/h) (VSS 40 110 Tab.1)`, kind: 'max', value: absI, limit: iMax, unit: '%',
          detail: `|i| = ${absI.toFixed(2)} % ≤ i_max = ${iMax.toFixed(1)} %`,
        }, tol));
        checks.push(mkCheck({
          key: 'imin', label: `Déclivité ≥ i_min = ${I_MIN_NORM}% (drainage, VSS 40 110 §11)`, kind: 'min', value: absI, limit: I_MIN_NORM, unit: '%', severity: 'info',
          detail: `|i| = ${absI.toFixed(2)} % ≥ i_min = ${I_MIN_NORM} % (recommandation, pas une valeur limite)`,
        }, tol));
      }
      return Object.assign({}, el, extra, { idx, checks, status: aggStatus(checks) });
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
    TYPE_LABELS_FR, typeLabelFR, mkCheck, aggStatus, CALC_DEFAULT, L_GMIN_TABLE, L_ARC_MIN_TABLE,
  };
});
