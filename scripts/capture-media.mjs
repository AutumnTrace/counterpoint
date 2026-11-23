// Records the README media from the built playground:
//   docs/media/partition-heal.gif   cut Ada off, type on both sides, heal, converge
//   docs/media/comparison.png       the interleaving scenario, Fugue vs the baseline
//
//   npm run build && node scripts/capture-media.mjs
//
// Uses the locally installed Chrome through Playwright and encodes the GIF
// with gifenc. Frames only store the pixels that changed since the previous
// one (everything else is transparent), which keeps the file small.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { preview } from 'vite';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repo, 'docs', 'media');
mkdirSync(outDir, { recursive: true });

const appRoot = join(repo, 'apps', 'playground');
const server = await preview({
  root: appRoot,
  configFile: join(appRoot, 'vite.config.ts'),
  preview: { port: 4321, strictPort: true },
  logLevel: 'warn',
});
const url = 'http://localhost:4321/counterpoint/';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
const sleep = (ms) => page.waitForTimeout(ms);

async function slider(testId, value) {
  await page.getByTestId(testId).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function agree() {
  await page.getByTestId('sync-state').getByText('replicas agree').waitFor({ timeout: 20_000 });
}

// ------------------------------------------------------------------ GIF

await page.goto(url);
await agree();
await slider('latency', 650);

const clip = await page.evaluate(() => {
  const a = document.querySelector('.panel--net').getBoundingClientRect();
  const b = document.querySelector('.peers').getBoundingClientRect();
  const x = Math.min(a.left, b.left) - 10;
  const y = Math.min(a.top, b.top) - 10;
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.ceil(Math.max(a.right, b.right) - x + 10),
    height: Math.ceil(Math.max(a.bottom, b.bottom) - y + 10),
  };
});

const frames = [];
let recording = true;
const recorder = (async () => {
  while (recording) frames.push({ png: await page.screenshot({ clip }), t: Date.now() });
})();

async function typeAtEnd(key, text) {
  const editor = page.getByTestId(`editor-${key}`);
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text, { delay: 55 });
}

await sleep(1200);
await page.getByTestId('link-ada-ben').click();
await sleep(350);
await page.getByTestId('link-ada-cy').click();
await sleep(700);
const ada = ['Ada: offline, ', 'still typing\n'];
const ben = ['Ben: online ', 'with Cy\n'];
for (let i = 0; i < 2; i++) {
  await typeAtEnd('ada', ada[i]);
  await typeAtEnd('ben', ben[i]);
}
await sleep(1400);
await page.getByTestId('link-ada-ben').click();
await sleep(300);
await page.getByTestId('link-ada-cy').click();
await page.mouse.move(5, 5); // no hover highlight in the last frames
await agree();
await sleep(2200);
recording = false;
await recorder;

// About 16 frames per second is plenty, and browsers stretch GIF delays
// under 20 ms to 100 ms, so drop the frames that come too close together.
const spaced = [];
for (const f of frames) if (spaced.length === 0 || f.t - spaced[spaced.length - 1].t >= 60) spaced.push(f);
if (process.env.DUMP_FRAMES) {
  mkdirSync(join(repo, '.media-frames'), { recursive: true });
  for (const p of [0.1, 0.3, 0.5, 0.65, 0.8, 1]) {
    const i = Math.round(p * (spaced.length - 1));
    writeFileSync(join(repo, '.media-frames', `frame-${String(i).padStart(3, '0')}.png`), spaced[i].png);
  }
}
const decoded = spaced.map((f) => {
  const png = PNG.sync.read(f.png);
  return { rgba: new Uint8Array(png.data), width: png.width, height: png.height, t: f.t };
});
const { width, height } = decoded[0];

// One palette for the whole animation, from a few frames spread across it.
const sample = new Uint8Array(decoded[0].rgba.length * 4);
[0, 0.35, 0.7, 1].forEach((p, i) => sample.set(decoded[Math.round(p * (decoded.length - 1))].rgba, i * decoded[0].rgba.length));
const palette = quantize(sample, 255);
const TRANSPARENT = palette.length;
palette.push([255, 0, 255]);

const gif = GIFEncoder();
let prev = null;
let pending = null; // { index, delay }
const flush = () => {
  if (!pending) return;
  gif.writeFrame(pending.index, width, height, {
    palette: pending.first ? palette : undefined,
    delay: pending.delay,
    transparent: !pending.first,
    transparentIndex: TRANSPARENT,
    dispose: 1,
  });
};
decoded.forEach((f, i) => {
  const delay = i + 1 < decoded.length ? decoded[i + 1].t - f.t : 2500;
  const index = applyPalette(f.rgba, palette.slice(0, TRANSPARENT));
  let changed = prev === null;
  if (prev !== null) {
    for (let p = 0, q = 0; p < index.length; p++, q += 4) {
      if (f.rgba[q] === prev[q] && f.rgba[q + 1] === prev[q + 1] && f.rgba[q + 2] === prev[q + 2]) index[p] = TRANSPARENT;
      else changed = true;
    }
  }
  if (!changed) {
    pending.delay += delay; // identical frame: just hold the previous one longer
    return;
  }
  flush();
  pending = { index, delay, first: prev === null };
  prev = f.rgba;
});
flush();
gif.finish();
const gifBytes = gif.bytes();
writeFileSync(join(outDir, 'partition-heal.gif'), gifBytes);
console.log(`partition-heal.gif: ${width}x${height}, ${decoded.length} frames (of ${frames.length} captured), ${(gifBytes.length / 1024 / 1024).toFixed(2)} MB`);

// ------------------------------------------------------- comparison still

const sharp = await browser.newPage({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 2 });
await sharp.goto(url);
await agree();
await sharp.getByTestId('latency').evaluate((el) => {
  el.value = '200';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sharp.getByTestId('run-scenario').click();
await sharp.getByTestId('result-naive').waitFor({ timeout: 30_000 });
await sharp.getByTestId('sync-state').getByText('replicas agree').waitFor({ timeout: 20_000 });
await sharp.waitForTimeout(300);
const panel = sharp.locator('.panel--scenario');
const still = await panel.screenshot({ scale: 'device' });
writeFileSync(join(outDir, 'comparison.png'), still);
console.log(`comparison.png: ${(still.length / 1024).toFixed(0)} kB`);

await browser.close();
await new Promise((r) => server.httpServer.close(r));
