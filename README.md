# Contrôle d'axe routier (LandXML)

Outil web (HTML autonome) de contrôle de conformité d'un axe routier importé depuis LandXML : VSS 40 090b / 40 100a / 40 105b / 40 110, OETV (giration), OCR. Exports Rapport (.html), Excel (.xlsx), DXF.

- Utilisation : ouvrir `index.html` (en local ou via GitHub Pages), importer un .xml LandXML.
- Sources : `engine.js` (moteur), `app-core.js` (modèle/exports). `index.html` en contient une copie intégrée.
- Tests : `npm install && node test_appcore.js` (nécessite des fichiers LandXML d'exemple, chemins à adapter dans le script).
