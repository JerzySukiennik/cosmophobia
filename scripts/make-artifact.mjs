// Post-build outputs, all from the single-file dist/index.html:
//   play/cosmophobia.html  committed copy, so the game can be downloaded and
//                          opened with a double-click (see README, Windows)
//   dist/cosmophobia.html  the page minus its document skeleton, for hosts
//                          that wrap pages in their own <html>/<body>
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');

mkdirSync('play', { recursive: true });
copyFileSync('dist/index.html', 'play/cosmophobia.html');

const stripped = html
  .replace(/<!doctype html>/i, '')
  .replace(/<html[^>]*>/i, '')
  .replace(/<\/html>/i, '')
  .replace(/<head>/i, '')
  .replace(/<\/head>/i, '')
  .replace(/<body>/i, '')
  .replace(/<\/body>/i, '')
  .trim();
writeFileSync('dist/cosmophobia.html', stripped);
console.log(`dist/index.html ${(html.length / 1e6).toFixed(2)} MB -> play/cosmophobia.html, dist/cosmophobia.html`);
