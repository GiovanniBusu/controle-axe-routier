global.DOMParser = require('@xmldom/xmldom').DOMParser;
const RoadEngine = require('./engine.js');
const AppCore = require('./app-core.js');
const fs = require('fs');

const files = [
  '/mnt/user-data/uploads/axe_dir_LA_LandXML_1_2.xml',
  '/mnt/user-data/uploads/axe_geom_0003_LandXML_1_2.xml',
  '/mnt/user-data/uploads/teste_analyse_geom-horiz-verti.xml',
];

let totalErrors = 0;

for (const path of files) {
  console.log('\n=========================', path.split('/').pop(), '=========================');
  const text = fs.readFileSync(path, 'latin1');
  let result;
  try {
    result = RoadEngine.parseLandXML(text);
  } catch (e) {
    console.log('ERREUR PARSE:', e.message); totalErrors++; continue;
  }
  for (const al of result.alignments) {
    console.log(`--- Alignment "${al.name}" (${al.horiz.length} éléments horiz, ${al.vertRaw.length} pts vert) ---`);
    let model;
    try {
      model = AppCore.buildModel(al, { Vp: 80, fT: 0.12, q: 0.07, vehicleKey: 'Bus12', toleranceH: 0.05, toleranceV: 0.02, visibCase: 'D', largeurVoie: 3.25, deltaIMax: 1.5 });
    } catch (e) {
      console.log('ERREUR buildModel:', e.message, e.stack); totalErrors++; continue;
    }
    console.log('Synthèse:', JSON.stringify(model.synth));
    console.log('planSegments:', model.planSegments.length, '- pts total:', model.planSegments.reduce((s,x)=>s+x.pts.length,0));
    console.log('profileSegments:', model.profileSegments.length);
    console.log('gabaritResults:', model.gabaritResults.length);

    // Sanity: every planSegment with pts.length>0 should start near previous segment's end
    for (let i = 1; i < model.planSegments.length; i++) {
      const prev = model.planSegments[i-1], cur = model.planSegments[i];
      if (prev.pts.length && cur.pts.length) {
        const gap = RoadEngine.dist2(prev.pts[prev.pts.length-1], cur.pts[0]);
        if (gap > 0.5) { console.log(`  !! discontinuité plan entre segment ${i-1} et ${i}: ${gap.toFixed(3)} m`); totalErrors++; }
      }
    }

    // Build exports (pure data/text generation - no DOM needed)
    let wb, report, dxf;
    try { wb = AppCore.buildWorkbookData(model); const XL=require('xlsx-js-style'); const w=AppCore.buildWorkbook(XL, model); XL.writeFile(w,'/tmp/sample_'+al.name.replace(/[^a-z0-9]/gi,'_')+'.xlsx'); } catch (e) { console.log('ERREUR buildWorkbookData:', e.message); totalErrors++; }
    try { report = AppCore.buildReportHTML(model); } catch (e) { console.log('ERREUR buildReportHTML:', e.message); totalErrors++; }
    try { dxf = AppCore.buildDXFString(model); } catch (e) { console.log('ERREUR buildDXFString:', e.message); totalErrors++; }
    if (wb) console.log('Excel sheets:', wb.map(s => s.name + '(' + s.rows.length + ' lignes)').join(', '));
    if (report) console.log('Report HTML length:', report.length, 'chars');
    if (dxf) {
      console.log('DXF length:', dxf.length, 'chars, lignes ENTITIES count:', (dxf.match(/0\nARC/g)||[]).length, 'ARC,', (dxf.match(/0\nTEXT/g)||[]).length, 'TEXT');
      // write sample dxf to disk for one alignment for visual spot check
      fs.writeFileSync('/tmp/sample_' + al.name.replace(/[^a-z0-9]/gi,'_') + '.dxf', dxf);
    }
  }
}

console.log('\n\n=== TOTAL ERREURS DÉTECTÉES:', totalErrors, '===');
process.exit(totalErrors > 0 ? 1 : 0);
