// Shared colour math: sRGB to linear, relative luminance, contrast ratio,
// HSV, Lab, CIEDE2000. One formula set, used by the map gates (03), the
// text lint (04), and the frame checker (05). Pure functions only.
export function hexToRgb(hex) {
  const h = hex.replace(/^#/, "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function rgbToHex([r, g, b]) {
  const c = (v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/** WCAG relative luminance of an sRGB colour, 0..1. */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two sRGB colours, 1..21. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbToHsv([r, g, b]) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r, g, b].map((v2) => Math.round((v2 + m) * 255));
}

/** Focus dim: saturation x 0.75, value x 0.88, per the Harris skill. */
export function dimColor(hex, sFactor = 0.75, vFactor = 0.88) {
  const hsv = rgbToHsv(hexToRgb(hex));
  return rgbToHex(hsvToRgb({ h: hsv.h, s: hsv.s * sFactor, v: hsv.v * vFactor }));
}

function pivotXyz(v) {
  return v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
}

/** sRGB hex to CIE Lab (D65). */
export function rgbToLab(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 1.0;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const fx = pivotXyz(x), fy = pivotXyz(y), fz = pivotXyz(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 Delta E (Euclidean distance in Lab). */
export function deltaE76(a, b) {
  const la = rgbToLab(a), lb = rgbToLab(b);
  return Math.hypot(la.L - lb.L, la.a - lb.a, la.b - lb.b);
}

/** CIEDE2000 Delta E. */
export function deltaE2000(a, b) {
  const la = rgbToLab(a), lb = rgbToLab(b);
  const kL = 1, kC = 1, kH = 1;
  const c1 = Math.hypot(la.a, la.b), c2 = Math.hypot(lb.a, lb.b);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(Math.pow(cBar, 7) / (Math.pow(cBar, 7) + Math.pow(25, 7))));
  const a1p = la.a * (1 + g), a2p = lb.a * (1 + g);
  const c1p = Math.hypot(a1p, la.b), c2p = Math.hypot(a2p, lb.b);
  const h1p = c1p === 0 ? 0 : (Math.atan2(la.b, a1p) * 180) / Math.PI + (Math.atan2(la.b, a1p) < 0 ? 360 : 0);
  const h2p = c2p === 0 ? 0 : (Math.atan2(lb.b, a2p) * 180) / Math.PI + (Math.atan2(lb.b, a2p) < 0 ? 360 : 0);
  const dLp = lb.L - la.L, dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * Math.PI) / 360);
  const lBarP = (la.L + lb.L) / 2, cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hBarP = (h1p + h2p + 360) / 2;
    else hBarP = (h1p + h2p - 360) / 2;
  }
  const t = 1 - 0.17 * Math.cos(((hBarP - 30) * Math.PI) / 180) + 0.24 * Math.cos((2 * hBarP * Math.PI) / 180) + 0.32 * Math.cos(((3 * hBarP + 6) * Math.PI) / 180) - 0.20 * Math.cos(((4 * hBarP - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hBarP - 275) / 25, 2));
  const rC = 2 * Math.sqrt(Math.pow(cBarP, 7) / (Math.pow(cBarP, 7) + Math.pow(25, 7)));
  const sL = 1 + (0.015 * Math.pow(lBarP - 50, 2)) / Math.sqrt(20 + Math.pow(lBarP - 50, 2));
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin((2 * dTheta * Math.PI) / 180) * rC;
  return Math.sqrt(
    Math.pow(dLp / (kL * sL), 2) + Math.pow(dCp / (kC * sC), 2) + Math.pow(dHp / (kH * sH), 2) + rT * (dCp / (kC * sC)) * (dHp / (kH * sH)),
  );
}
