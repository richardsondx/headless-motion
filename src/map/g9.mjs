// G9 focus and camera gate. Pure: takes every frame state (all frames,
// not just sampled ones) plus props, fps, and events, returns
// { pass, failures: [{ code, frame, detail }] }.
import { projectPoint } from "./project.mjs";

const FOCAL = { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }; // 0.6 x 0.6, centred

function inFocal([x, y], width = 1920, height = 1080) {
  return x >= FOCAL.x0 * width && x <= FOCAL.x1 * width && y >= FOCAL.y0 * height && y <= FOCAL.y1 * height;
}

export function checkG9(allStates, props, fps, events) {
  const failures = [];
  const evFrames = {};
  for (const e of events || []) evFrames[e.id] = e.f;
  const lead = Math.ceil(0.2 * fps);
  const hold = Math.ceil(1.2 * fps);
  const byFrame = new Map(allStates.map((s) => [s.frame, s]));

  // (c) camera lands before each event, holds after the last label, and
  // never moves outside a travel window.
  for (const m of props.camera || []) {
    const eventF = evFrames[m.event];
    if (eventF === undefined) continue;
    const landF = eventF - lead;
    const travelF = Math.ceil((m.travel ?? 2) * fps);
    const startF = landF - travelF;
    const landState = byFrame.get(landF);
    if (landState) {
      const dc = Math.hypot(landState.camera.center[0] - m.center[0], landState.camera.center[1] - m.center[1]);
      if (dc > 1e-6 || Math.abs(landState.camera.zoom - m.zoom) > 1e-6) {
        failures.push({ code: "CAMERA_LATE", frame: landF, detail: `camera for ${m.event} not at target at landing frame ${landF}` });
      }
    }
    if (landF - startF < 1) failures.push({ code: "CAMERA_NO_ROOM", frame: landF, detail: `no room for travel before ${m.event}` });
    void startF;
  }
  // Hold rule, from the skill: after any pill or leader label lands, the
  // camera holds still for at least 1.2 s. Bare labels are pinned to
  // geography and track the camera each frame, so they do not need the hold.
  for (const label of props.labels || []) {
    if (label.mode === "bare") continue;
    for (let f = label.at; f <= Math.min(label.at + hold, allStates.length - 1); f++) {
      const s = byFrame.get(f);
      if (s && s.camera.moving) {
        failures.push({ code: "HOLD_SHORT", frame: f, detail: `camera moving ${f - label.at} frames after label ${label.id} landed` });
        break;
      }
    }
  }
  // Camera drift: centre must not change outside travel windows.
  let prevCam = null;
  let prevMoving = false;
  let prevFrame = -1;
  for (const s of allStates) {
    if (prevCam && s.frame === prevFrame + 1 && !s.camera.moving && !prevMoving) {
      if (Math.abs(s.camera.center[0] - prevCam.center[0]) > 1e-9 || Math.abs(s.camera.center[1] - prevCam.center[1]) > 1e-9 || Math.abs(s.camera.zoom - prevCam.zoom) > 1e-9) {
        failures.push({ code: "CAMERA_DRIFT", frame: s.frame, detail: "camera moved outside a travel window" });
        break;
      }
    }
    prevCam = s.camera;
    prevMoving = s.camera.moving;
    prevFrame = s.frame;
  }
  // (a) subject centroid inside the focal area during every hold; (b) one
  // focus at a time; (d) draw head inside the focal area during draws.
  for (const s of allStates) {
    if (s.focus && !s.camera.moving) {
      const subject = s.countries.find((c) => c.iso === s.focus.subject);
      const point = s.focus.point || (subject ? subject.centroid : null);
      if (point) {
        const screen = projectPoint(point[0], point[1], s.camera);
        if (!inFocal(screen)) failures.push({ code: "G9_HEAD_OUT", frame: s.frame, detail: `subject ${s.focus.subject} point outside focal area at ${screen.map((v) => v.toFixed(0)).join(",")}` });
      }
      const undimmed = s.countries.filter((c) => !c.dimmed).length;
      if (undimmed !== 1 && s.countries.length > 1) {
        // During the dim ramp more than one country is still bright; only
        // flag once the ramp is done (dimFactor 1 on a non-subject).
        const settled = s.countries.some((c) => c.dimmed && c.dimFactor >= 1);
        if (settled) failures.push({ code: "FOCUS_OVERLAP", frame: s.frame, detail: `${undimmed} countries undimmed during focus on ${s.focus.subject}` });
      }
    }
    for (const r of s.routes) {
      if (!r.active) continue;
      const headScreen = projectPoint(r.head[0], r.head[1], s.camera);
      if (!inFocal(headScreen)) {
        failures.push({ code: "G9_HEAD_OUT", frame: s.frame, detail: `route ${r.id} draw head outside focal area at ${headScreen.map((v) => v.toFixed(0)).join(",")}` });
        break;
      }
    }
  }
  // Deduplicate identical failures, keep the first frame of each kind.
  const seen = new Set();
  const deduped = failures.filter((f) => {
    const k = `${f.code}:${f.detail.slice(0, 40)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { pass: deduped.length === 0, failures: deduped };
}
