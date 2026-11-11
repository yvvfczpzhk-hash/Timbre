# Timbre

Entraîneur vocal en une seule page web (`index.html`) : justesse mesurée au micro, son dense, programme de 16 semaines. Tout reste sur le téléphone.

`sw.js` rend la page disponible hors ligne (le réseau reste prioritaire : la dernière version publiée est servie dès qu'il y en a).

## Tests

- `node tests/run.js` : moteur d'analyse (justesse, vibrato, diapason, cassures, bruit, densité), exercices, test d'oreille, étalonnage des exercices, zones de hauteur et plafond d'aigu, ordre et durée des séances, journal (pauses, archivage, mise à jour) et programme sur 20 semaines, sur des voix de synthèse réalistes. Aucune dépendance, environ 10 minutes (`ONLY=<motif>` pour n'en lancer qu'une partie).
- `node tests/browser.js` : modèles sonores dans un vrai moteur Web Audio (hauteur, timbre, glissés, attaques, volume). Nécessite Playwright (`npm i -D playwright && npx playwright install chromium`).
