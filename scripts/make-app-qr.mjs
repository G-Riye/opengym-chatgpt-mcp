// Build a QR code for the tokenized public openGym URL, so the iPhone can just scan it.
//   node scripts/make-app-qr.mjs            -> store/app-qr.png
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatgptDir = path.resolve(__dirname, '..');
const root = path.resolve(chatgptDir, '..');
const store = path.join(chatgptDir, 'store');
const out = process.argv[3] || path.join(store, 'app-qr.png');

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '';
  }
};

const base = readText(path.join(store, 'app-url.txt'));
const token = readText(path.join(chatgptDir, 'secrets', 'app-token'));
if (!base) {
  console.error('store/app-url.txt is empty - run Tunnel-Tailscale.cmd first.');
  process.exit(1);
}
if (!token) {
  console.error('secrets/app-token is empty - start the app proxy first (Start.cmd).');
  process.exit(1);
}

const url = `${base}/?t=${token}`;
const qrEntry = pathToFileURL(path.join(root, 'frontend', 'node_modules', 'lean-qr', 'index.mjs')).href;
const qrPngEntry = pathToFileURL(path.join(root, 'frontend', 'node_modules', 'lean-qr', 'extras', 'node_export.mjs')).href;
const { generate } = await import(qrEntry);
const { toPngBuffer } = await import(qrPngEntry);

mkdirSync(path.dirname(out), { recursive: true });
if (existsSync(out)) writeFileSync(out, '');
writeFileSync(out, toPngBuffer(generate(url), { scale: 9, pad: 4, off: [255, 255, 255] }));
console.log('QR  :', out);
console.log('URL :', url);
