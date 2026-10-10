// Copies the curated font files out of node_modules into src/fonts so they ship with the app.
// All fonts are SIL Open Font License. The "latin" subset covers English and Spanish.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'fonts');
fs.mkdirSync(out, { recursive: true });

const files = {
  '@fontsource-variable/literata': ['literata-latin-wght-normal.woff2', 'literata-latin-wght-italic.woff2'],
  '@fontsource/eb-garamond': [
    'eb-garamond-latin-400-normal.woff2', 'eb-garamond-latin-400-italic.woff2',
    'eb-garamond-latin-700-normal.woff2', 'eb-garamond-latin-700-italic.woff2',
  ],
  '@fontsource-variable/inter': ['inter-latin-wght-normal.woff2', 'inter-latin-wght-italic.woff2'],
  '@fontsource-variable/lexend': ['lexend-latin-wght-normal.woff2'],
  '@fontsource/atkinson-hyperlegible': [
    'atkinson-hyperlegible-latin-400-normal.woff2', 'atkinson-hyperlegible-latin-400-italic.woff2',
    'atkinson-hyperlegible-latin-700-normal.woff2', 'atkinson-hyperlegible-latin-700-italic.woff2',
  ],
  '@fontsource-variable/jetbrains-mono': ['jetbrains-mono-latin-wght-normal.woff2', 'jetbrains-mono-latin-wght-italic.woff2'],
};

for (const [pkg, names] of Object.entries(files)) {
  for (const name of names) {
    fs.copyFileSync(path.join(root, 'node_modules', pkg, 'files', name), path.join(out, name));
  }
  const license = path.join(root, 'node_modules', pkg, 'LICENSE');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(out, pkg.split('/')[1] + '.LICENSE.txt'));
}
console.log('fonts copied to', out);
