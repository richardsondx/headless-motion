/* Probe: where does the rifle-rsf image node actually render?
 * Loads the compiled previs page, seeks to frame 168 (7s), and reports the
 * rifle div's geometry, computed style, and img state, plus a full-res
 * screenshot. Diagnostic only; not part of the engine.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { findChrome } from "/home/hatch/workspace/headless-motion-engine/src/renderer/render.mjs";

const CHROME_ARGS = ["--disable-gpu", "--font-render-hinting=none", "--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars", "--no-sandbox", "--force-device-scale-factor=1"];
const ROOT = "/home/hatch/workspace/headless-motion-engine";

const html = readFileSync(`${ROOT}/out/seg4-rifle-smoke/page.html`, "utf8");
const browser = await chromium.launch({ executablePath: findChrome(), args: CHROME_ARGS });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => window.__hme.ready);
await page.evaluate(() => window.__hme.seek(168));
const info = await page.evaluate(() => {
  const el = document.querySelector('[data-node="rifle-rsf"]');
  const img = el && el.querySelector("img");
  const cs = el && getComputedStyle(el);
  const r = el && el.getBoundingClientRect();
  const ir = img && img.getBoundingClientRect();
  const badge = document.querySelector('[data-node="badge-rsf"]');
  const br = badge && badge.getBoundingClientRect();
  return {
    div: el ? { left: r.left, top: r.top, width: r.width, height: r.height,
      position: cs.position, display: cs.display, zIndex: cs.zIndex,
      styleLeft: el.style.left, styleTop: el.style.top } : null,
    img: img ? { complete: img.complete, naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight, rect: { left: ir.left, top: ir.top, width: ir.width, height: ir.height },
      srcLen: (img.getAttribute("src") || "").length } : null,
    badgeRect: br ? { left: br.left, top: br.top, width: br.width, height: br.height } : null,
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: `${ROOT}/verify-seg4/evidence/work/rifle-probe-168.png` });
await browser.close();
console.log("screenshot saved");
