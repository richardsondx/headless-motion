// Map frame state: pure function of (props, frame, fps, tokens, geo).
// Times: camera travel and route draw/start are seconds (Math.ceil(s*fps)
// frames). Label `at` is a frame number: labels land on exact frames and
// the checker samples exact frames. Focus windows run from the event frame
// until the next event frame (or the end). Dim ramps over 6 frames.
// Camera: travel ends at eventFrame - ceil(0.2*fps) and holds after the
// last label for ceil(1.2*fps) frames. A move may set followRoute to ride
// the draw head for exactly the draw's duration.
import { ease } from "../scene/easing.mjs";
import { dimColor } from "../shared/color.mjs";
import { projectPoint, pointAlongRoute, routeUpTo } from "./project.mjs";

function mixHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

export function eventFrames(events) {
  const out = {};
  for (const e of events || []) out[e.id] = e.f;
  return out;
}

function centroidOf(feature) {
  // Area-weighted centroid is overkill here; use the bbox centre of the
  // largest ring. Labels use LABEL_X/LABEL_Y when present (Natural Earth).
  const p = feature.properties;
  if (typeof p.LABEL_X === "number" && typeof p.LABEL_Y === "number") return [p.LABEL_X, p.LABEL_Y];
  let minX = 180, maxX = -180, minY = 90, maxY = -90;
  const walk = (coords) => {
    for (const c of coords) {
      if (typeof c[0] === "number") {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      } else walk(c);
    }
  };
  walk(feature.geometry.coordinates);
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function cameraAt(props, frame, fps, evFrames, routeStates) {
  const moves = props.camera || [];
  if (moves.length === 0) return { center: [0, 0], zoom: 2, bearing: 0, pitch: 0, moving: false, moveId: null };
  const lead = Math.ceil(0.2 * fps);
  let cam = { center: moves[0].center, zoom: moves[0].zoom, bearing: moves[0].bearing || 0, pitch: moves[0].pitch || 0, moving: false, moveId: null };
  let prev = { center: moves[0].center, zoom: moves[0].zoom, bearing: moves[0].bearing || 0, pitch: moves[0].pitch || 0 };
  for (const m of moves) {
    const eventF = evFrames[m.event];
    if (eventF === undefined) continue;
    const landF = eventF - lead;
    const travelF = Math.ceil((m.travel ?? 2) * fps);
    const startF = landF - travelF;
    if (frame >= startF && frame < landF) {
      const p = ease(m.ease || "easeInOutCubic", (frame - startF) / travelF);
      const lerp = (a, b) => a + (b - a) * p;
      cam = {
        center: [lerp(prev.center[0], m.center[0]), lerp(prev.center[1], m.center[1])],
        zoom: lerp(prev.zoom, m.zoom),
        bearing: lerp(prev.bearing || 0, m.bearing || 0),
        pitch: lerp(prev.pitch || 0, m.pitch || 0),
        moving: true,
        moveId: m.event,
      };
      if (m.followRoute && routeStates[m.followRoute]) {
        cam.center = routeStates[m.followRoute].head;
      }
      return cam;
    }
    if (frame >= landF) {
      cam = { center: m.center, zoom: m.zoom, bearing: m.bearing || 0, pitch: m.pitch || 0, moving: false, moveId: m.event };
    }
    prev = { center: m.center, zoom: m.zoom, bearing: m.bearing || 0, pitch: m.pitch || 0 };
  }
  return cam;
}

export function computeMapState(props, frame, fps, tokens, geoFeatures, events) {
  const evFrames = eventFrames(events);
  const byIso = new Map(geoFeatures.map((f) => [f.properties.ISO_A3, f]));
  const routeStates = {};
  for (const r of props.routes || []) {
    const startF = Math.ceil(r.start * fps);
    const drawF = Math.max(1, Math.ceil(r.draw * fps));
    const raw = (frame - startF) / drawF;
    const p = raw <= 0 ? 0 : raw >= 1 ? 1 : ease(r.ease || "easeInOutCubic", raw);
    routeStates[r.id] = {
      id: r.id,
      lineColor: r.color || null,
      progress: p,
      active: frame >= startF && frame <= startF + drawF,
      head: pointAlongRoute(r.coords, p),
      drawn: routeUpTo(r.coords, p),
    };
  }
  const camera = cameraAt(props, frame, fps, evFrames, routeStates);
  const focusList = props.focus || [];
  let focus = null;
  for (let i = 0; i < focusList.length; i++) {
    const f = focusList[i];
    const startF = evFrames[f.event];
    if (startF === undefined || frame < startF) continue;
    const nextF = i + 1 < focusList.length ? evFrames[focusList[i + 1].event] : Infinity;
    if (frame < nextF) focus = { ...f, startF, point: f.point || null };
  }
  const ramp = tokens.focus.rampFrames ?? 6;
  const dimT = focus ? Math.min(1, Math.max(0, (frame - focus.startF) / ramp)) : 0;
  const dimEase = dimT === 0 ? 0 : dimT >= 1 ? 1 : ease("easeOutCubic", dimT);
  const register = props.register || "dark";
  const countries = (props.geometry.include || []).map((iso) => {
    const feature = byIso.get(iso);
    const base = register === "dark" ? (tokens.dark.landBase || tokens.dark.landMeasuredThumb || tokens.dark.land) : tokens.light.tanLand;
    const isSubject = focus && focus.subject === iso;
    const fill = isSubject && focus.flood ? focus.flood : base;
    const dimmed = Boolean(focus) && !isSubject;
    return {
      iso,
      name: feature ? feature.properties.NAME : iso,
      centroid: feature ? centroidOf(feature) : [0, 0],
      fill,
      dimmed,
      displayFill: dimmed
        ? mixHex(fill, dimColor(fill, 1 - tokens.focus.desaturate, 1 - tokens.focus.valueDrop), dimEase)
        : fill,
      dimFactor: dimmed ? dimEase : 0,
    };
  });
  const labels = (props.labels || []).map((l) => {
    let target = null;
    if (typeof l.target === "string") {
      const c = countries.find((c2) => c2.iso === l.target);
      target = c ? c.centroid : [0, 0];
    } else target = l.target;
    return { id: l.id, text: l.text, mode: l.mode || "pill", dy: l.dy, ground: l.ground === undefined ? "#14213D" : l.ground, visible: frame >= l.at, screen: projectPoint(target[0], target[1], camera) };
  });
  const badges = (props.badges || []).map((b) => ({
    id: b.id, label: b.label, mode: b.mode || "disc",
    visible: b.f === undefined || frame >= b.f,
    screen: projectPoint(b.at[0], b.at[1], camera),
  }));
  return { frame, fps, camera, focus, countries, routes: Object.values(routeStates), labels, badges, register, borderStroke: props.borderStroke !== false, baseFill: register === "dark" ? (tokens.dark.landBase || tokens.dark.landMeasuredThumb || tokens.dark.land) : tokens.light.tanLand };
}
