// Map projection and camera math. Pure functions of their arguments.
// Projection model (documented assumption, not MapLibre): equirectangular
// plate, camera centre [lng, lat], zoom z gives pxPerDeg = 7.5 * 2^z, so
// zoom 4 shows about 16 degrees across 1920 px. Bearing rotates the plate
// around the frame centre; pitch scales y by cos(pitch) (a flat tilt, not
// a 3D perspective). One projection is used for plate, routes, dots, and
// labels, so registration cannot drift between them.
// Deviation from prompt 03, stated here, not silent: MapLibre GL JS is
// NOT used. It needs WebGL, which this headless path disables, and a WebGL
// canvas breaks deterministic per-frame SHA hashing. Geometry is real
// Natural Earth GeoJSON, drawn as SVG paths through this one projection.
export const PX_PER_DEG_BASE = 7.5;

export function pxPerDeg(zoom) {
  return PX_PER_DEG_BASE * Math.pow(2, zoom);
}

/** Camera state at a frame: {center:[lng,lat], zoom, bearing, pitch}. */
export function projectPoint(lng, lat, camera, width = 1920, height = 1080) {
  const scale = pxPerDeg(camera.zoom);
  let dx = (lng - camera.center[0]) * scale;
  let dy = (camera.center[1] - lat) * scale;
  const pitchScale = Math.cos(((camera.pitch || 0) * Math.PI) / 180);
  dy *= pitchScale;
  const br = ((camera.bearing || 0) * Math.PI) / 180;
  const cos = Math.cos(br), sin = Math.sin(br);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return [width / 2 + rx, height / 2 + ry];
}

export function projectToScreen(frameState, lngLat) {
  return projectPoint(lngLat[0], lngLat[1], frameState.camera);
}

/** Affine matrix [a, b, c, d, e, f] mapping screen coords under camera
 * `from` to screen coords under camera `to`, in SVG matrix(a b c d e f)
 * order: x' = a*x + c*y + e, y' = b*x + d*y + f. Exact: projectPoint is
 * affine in lng/lat (scale, pitch y-scale, bearing rotation, translate),
 * so the map is exact up to float rounding. The layer cache uses it to
 * draw country paths once at the reference camera and transform them per
 * frame instead of re-projecting every vertex. Returns null when the map
 * is singular (e.g. pitch 90 collapses a dimension). */
export function cameraMatrix(from, to, width = 1920, height = 1080) {
  const p = (lng, lat, cam) => projectPoint(lng, lat, cam, width, height);
  const f0 = p(0, 0, from), f1 = p(1, 0, from), f2 = p(0, 1, from);
  const t0 = p(0, 0, to), t1 = p(1, 0, to), t2 = p(0, 1, to);
  const ux = f1[0] - f0[0], uy = f1[1] - f0[1];
  const vx = f2[0] - f0[0], vy = f2[1] - f0[1];
  const det = ux * vy - uy * vx;
  if (!isFinite(det) || Math.abs(det) < 1e-9) return null;
  const wx = t1[0] - t0[0], wy = t1[1] - t0[1];
  const zx = t2[0] - t0[0], zy = t2[1] - t0[1];
  const a = (wx * vy - zx * uy) / det;
  const b = (wy * vy - zy * uy) / det;
  const c = (zx * ux - wx * vx) / det;
  const d = (zy * ux - wy * vx) / det;
  const e = t0[0] - (a * f0[0] + c * f0[1]);
  const f = t0[1] - (b * f0[0] + d * f0[1]);
  const out = [a, b, c, d, e, f];
  if (!out.every(Number.isFinite)) return null;
  // The map itself must be non-singular too: a `to` camera with pitch 90
  // collapses a dimension (cos(90) is ~6e-17, not 0), so its matrix has a
  // ~0 determinant even though the `from` basis is fine.
  if (Math.abs(a * d - b * c) < 1e-9) return null;
  return out;
}

/** GeoJSON Polygon/MultiPolygon coordinates to an SVG path string. */
export function geoPath(coords, camera, width, height) {
  const ring = (r) => r.map((pt, i) => `${i === 0 ? "M" : "L"}${projectPoint(pt[0], pt[1], camera, width, height).map((v) => v.toFixed(2)).join(" ")}`).join("") + "Z";
  const poly = (p) => p.map(ring).join("");
  if (coords.length && typeof coords[0][0][0] === "number") return poly(coords);
  return coords.map(poly).join("");
}

/** Point on a route at fraction t (0..1) by polyline length. */
export function pointAlongRoute(coords, t) {
  if (coords.length === 0) return null;
  if (coords.length === 1) return coords[0];
  const segs = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    segs.push(d);
    total += d;
  }
  if (total === 0) return coords[0];
  let target = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) {
      const f = segs[i] === 0 ? 0 : target / segs[i];
      return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f];
    }
    target -= segs[i];
  }
  return coords[coords.length - 1];
}

/** Partial route coordinates up to fraction t, for the draw-on effect. */
export function routeUpTo(coords, t) {
  const head = pointAlongRoute(coords, t);
  if (!head) return [];
  const out = [coords[0]];
  let acc = 0;
  let total = 0;
  const segs = [];
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    segs.push(d);
    total += d;
  }
  for (let i = 0; i < segs.length; i++) {
    if (acc + segs[i] >= t * total) break;
    out.push(coords[i + 1]);
    acc += segs[i];
  }
  out.push(head);
  return out;
}
