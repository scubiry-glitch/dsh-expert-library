import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const context = vm.createContext({});
context.window = context;
for (const name of ['engine.js', 'style-impressionism.js', 'style-abstraction.js', 'copycode.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name });
}

const sourceGallery = fs.readFileSync(path.join(root, 'gallery.js'), 'utf8');
const keys = [...sourceGallery.matchAll(/STYLES\.(\w+)/g)].slice(0, 12).map((match) => match[1]);
if (keys.length !== 12 || new Set(keys).size !== 12) throw new Error('Expected 12 distinct gallery styles');
const styles = keys.map((key) => context.STYLES[key]);
if (styles.some((style) => !style)) throw new Error('A gallery style is missing');

const original = fs.readFileSync(path.join(root, 'original/index.html'), 'utf8');
const offline = original
  .replace(/  <link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\n/, '')
  .replace(/  <link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\n/, '')
  .replace('https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap', 'fonts/newsreader.css')
  .replace('https://cdn.jsdelivr.net/npm/p5@2.3.3/lib/p5.min.js', 'vendor/p5.min.js')
  .replace('https://cdn.jsdelivr.net/npm/p5.brush@2.2.2', 'vendor/p5.brush.js');
if (offline.includes('<script defer src="https://') || offline.includes('fonts.googleapis.com')) {
  throw new Error('Offline gallery still has a remote asset');
}
fs.writeFileSync(path.join(root, 'index.html'), offline);

const standaloneDir = path.join(root, 'standalone');
fs.mkdirSync(standaloneDir, { recursive: true });
for (const style of styles) {
  let html = vm.runInContext(`standaloneHTML(STYLES.${keys[styles.indexOf(style)]})`, context);
  html = html
    .replace('https://cdn.jsdelivr.net/npm/p5@2.3.3/lib/p5.min.js', '../vendor/p5.min.js')
    .replace('https://cdn.jsdelivr.net/npm/p5.brush@2.2.2', '../vendor/p5.brush.js');
  if (html.includes('https://cdn.')) throw new Error(`Remote CDN in ${style.key}`);
  fs.writeFileSync(path.join(standaloneDir, `${style.key}.html`), html);
}

const inventory = [];
function visit(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) visit(full);
    else if (item.name !== 'manifest.json') {
      const bytes = fs.readFileSync(full);
      inventory.push({ file: path.relative(root, full), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
visit(root);
inventory.sort((a, b) => a.file.localeCompare(b.file));
const manifest = {
  source: 'https://painterly.design-tools.workers.dev/',
  archivedAt: new Date().toISOString(),
  galleryStyles: styles.map(({ key, movement, label, note }) => ({ key, movement, label, note })),
  files: inventory,
};
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${styles.length} standalone effects; ${inventory.length} files inventoried.`);
