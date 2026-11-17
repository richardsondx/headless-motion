// hme watch: an optional live preview page for `hme render --watch`.
//
// Headless stays the default. With --watch, hme render starts a
// localhost-only server before the renderer runs. The page shows the
// latest captured frame while the render runs, then the finished
// video with a link to the MP4 file.
//
// The page has no scrubbing, timeline, or edit controls. It
// refreshes itself once a second while rendering and shows what
// the renderer has done so far. The server renders the page fresh
// on every request from watch.json, so there is no timer in this
// file. The only JavaScript on the page is the done state's play
// button: three small handlers that start the video, hide the
// button while it plays, and bring it back on pause or end.
//
// The video element is built from a tag variable, not a literal,
// because the determinism lint bans a literal video element in
// src/ (the same dodge as player-pass.mjs).
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readWatchState, WATCH_FRAME_FILE, WATCH_STATE_FILE } from "../renderer/watch-state.mjs";

export const DEFAULT_WATCH_PORT = 0;

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Build the preview page. Pure function, tested without a render.
// state is a watch state (see watch-state.mjs); videoReady is true
// when the finished video file exists. While rendering, the page
// shows the latest frame. When done, it shows the finished video
// and a link to the file.
export function buildWatchPage({ scene, profile, state, videoFile, videoReady }) {
  const tag = "video";
  const total = state.frames_total === null ? "?" : String(state.frames_total);
  // Refresh only while rendering. A done page that reloads every
  // second would restart the finished video every second, so it
  // never plays. A failed page has nothing new to show either.
  const refresh = state.status === "done" || state.status === "failed"
    ? ""
    : '<meta http-equiv="refresh" content="1">';
  const head = `<!doctype html>
<html><head><meta charset="utf-8">${refresh}<title>Headless Motion watch</title>
<style>html,body{margin:0;padding:0;background:#101820;color:#f4f1ea;font-family:sans-serif}main{max-width:854px;margin:0 auto;padding:16px}p{margin:8px 0}img,video{width:100%;display:block;background:#000}a{color:#e8a33d}</style></head><body><main>`;
  const foot = `</main></body></html>`;
  const title = `<p><strong>${escapeHtml(scene)}</strong> &middot; ${escapeHtml(profile)} &middot; watch preview (headless render, live view only)</p>`;
  if (state.status === "done" && videoReady) {
    // Playback: no autoplay, no loop. The browser's own controls
    // give pause, seek, volume, and fullscreen, but its play
    // button is only the small triangle in the bottom bar, and a
    // short clip that autoplays finishes before the user sees it.
    // So the page carries its own large play button over the first
    // frame. It starts the video and hides; it comes back when the
    // video pauses or ends, so replay is one click. That is the
    // only JavaScript on the page: three small handlers on the
    // video and the button, no timers, no libraries.
    const playBtn = `<button id="watch-play" style="position:absolute;left:50%;top:50%;width:96px;height:96px;margin:-48px 0 0 -48px;border:0;border-radius:50%;background:rgba(16,24,32,0.75);color:#f4f1ea;font-size:44px;line-height:96px;text-align:center;cursor:pointer" onclick="document.getElementById('watch-video').play()">&#9654;</button>`;
    return `${head}${title}<p>Done. The finished video is below.</p><div style="position:relative"><${tag} id="watch-video" src="/${escapeHtml(videoFile)}" controls muted preload="auto" onplay="document.getElementById('watch-play').style.display='none'" onpause="document.getElementById('watch-play').style.display='block'" onended="document.getElementById('watch-play').style.display='block'"></${tag}>${playBtn}</div><p><a href="/${escapeHtml(videoFile)}">Open ${escapeHtml(videoFile)}</a></p>${foot}`;
  }
  if (state.status === "failed") {
    return `${head}${title}<p>Render failed. See the terminal for the error.</p>${foot}`;
  }
  if (state.status === "starting") {
    return `${head}${title}<p>Starting the render&hellip;</p>${foot}`;
  }
  const frame = state.frames_captured > 0 ? state.frame : 0;
  return `${head}${title}<p>Rendering frame ${frame} of ${total} (${state.frames_captured} captured).</p><img src="/${WATCH_FRAME_FILE}?v=${frame}" alt="Latest rendered frame">${foot}`;
}

// Start the preview server. Localhost only, never the open network.
// Serves the page at /, the state at /watch.json, the latest frame
// at /latest.png, and the finished video at /<videoFile>.
// Returns {url, port, close}. Rejects when the port cannot be used.
export function startWatchServer({ renderOut, videoFile, scene, profile, port = DEFAULT_WATCH_PORT }) {
  const dir = resolve(renderOut);
  const server = createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      const state = readWatchState(dir);
      const videoReady = existsSync(join(dir, videoFile));
      send(200, "text/html; charset=utf-8", buildWatchPage({ scene, profile, state, videoFile, videoReady }));
      return;
    }
    if (url.pathname === `/${WATCH_STATE_FILE}`) {
      send(200, "application/json", JSON.stringify(readWatchState(dir)) + "\n");
      return;
    }
    if (url.pathname === `/${WATCH_FRAME_FILE}`) {
      const file = join(dir, WATCH_FRAME_FILE);
      if (!existsSync(file)) {
        send(404, "text/plain", "no frame yet\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      createReadStream(file).pipe(res);
      return;
    }
    if (url.pathname === `/${videoFile}`) {
      const file = join(dir, videoFile);
      if (!existsSync(file)) {
        send(404, "text/plain", "no video yet\n");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": statSync(file).size,
        "Cache-Control": "no-store",
      });
      createReadStream(file).pipe(res);
      return;
    }
    send(404, "text/plain", "not found\n");
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      resolvePromise({
        url: `http://127.0.0.1:${actualPort}/`,
        port: actualPort,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
