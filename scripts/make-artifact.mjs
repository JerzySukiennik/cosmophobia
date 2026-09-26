// Produces dist/cosmophobia.html: the same single-file build, minus the
// document skeleton, for hosts that wrap pages in their own <html>/<body>.
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
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
console.log(`dist/index.html ${(html.length / 1e6).toFixed(2)} MB -> dist/cosmophobia.html`);
