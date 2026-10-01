# Timbre

Entraîneur vocal en une seule page web (`index.html`) : justesse mesurée au micro, son dense, programme de 16 semaines. Tout reste sur le téléphone.

## Tests

- `node tests/run.js` : moteur d'analyse (justesse, vibrato, diapason, cassures, bruit, densité), exercices, test d'oreille et programme sur 20 semaines, sur des voix de synthèse réalistes. Aucune dépendance, environ 5 minutes.
- `node tests/browser.js` : modèles sonores dans un vrai moteur Web Audio (hauteur, timbre, glissés, attaques, volume). Nécessite Playwright (`npm i -D playwright && npx playwright install chromium`).
