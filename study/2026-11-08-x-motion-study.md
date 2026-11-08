# X motion study — how to make the headless tool better for agents
Date: 2026-11-08. Status: study only. No engine code changed. No predicate changed.

## What was studied
- 4 X posts: m4lkxx 2112550174962651338 (2026-10-20, decoded), m4lkxx 2116504147465757161 (2026-10-31), cryptowluha 2116525623505997921 (2026-10-31), hurricodes 2116072252177289220 (2026-10-30)
- 2 short links: t.co/2Rr5NUPEvr, t.co/daU959py1m
- 3 uploaded images (transcribed in full below)
- Current engine audit, 2026-11-08 (see §6)

## Verified vs not retrievable — read first
- X itself is blocked in this sandbox (`browser.open` to x.com: "Domain x.com is blocked by policy"). No post text, video, or image was retrieved directly from X. Search by status ID returned no verbatim post text for any of the four IDs.
- Verified: both t.co destinations and their contents; m4lkxx Oct 20 article title/date/excerpt via Linkdrift; cryptowluha = "House Growth Animation" in awesome-opus5-5-videos; the seek(t)/spring/beat-grid/critic-loop method via Ray Fu's guide and the Florence Motion Lab test (see §2).
- Inferred, labelled as such: m4lkxx Oct 20 status is almost certainly the post sharing that article (same day, same title). House-build staging comes from third-party reposts, not the author's post.
- Not retrievable without live X/browser access: full text/video of all four X posts; m4lkxx Oct 31 post's subject; hurricodes Oct 30 post's subject; cryptowluha's exact prompt/video; full m4lkxx article text beyond the truncated Linkdrift excerpt.
- Dates above are decoded from the X Snowflake ID, not shown on a fetched page.
- Do not assign the t.co links to a specific X post — which post carried each link was not verified.

## 1. The three uploaded images, transcribed

### Image 1 — five roles
- DIRECTOR: What must the viewer remember?
- REFERENCE: What visual language, and what may not be copied?
- TIMELINE: What changes, and on which frame?
- RENDERER: How is any single frame drawn and exported?
- CRITIC: What has failed before in the actual render, and how do we know?

### Image 2 — defect classes (every defect logged belongs to one)
- INVENTED FACTS: placeholder text, a fake logo, the wrong handle
- DEFAULTS: a generic room instead of your reference
- STAGING: the face behind the monitor, the title off the frame
- SIGNS: a screen facing the wall, sad brows that read angry
- HIDDEN HISTORY: a "seekable" frame that remembers the last one
- RENDER ARTEFACTS: invisible snow, a red streak, a ghost across the cut
- CONTACT: a mug inside the body
- COLOR: brand orange that comes out peach
- THE FILE: the MP4 is not the source
- TASTE: the first frame is black

### Image 3 — six motion principles
- 01 spacing: how far the object moves between poses
- 02 typography: scale, tracking and line breaks
- 03 motion blur: exposure during fast movement
- 04 easing: how the movement speeds up and slows down
- 05 follow-through: let the tail settle after the body stops
- 06 anticipation: a small pullback before the main move

## 2. Per-source findings

### 2.1 m4lkxx, 2026-10-20 — "Motion Design with Opus 5.5: Direct It Like a Studio, Check It Like an Engineer"
- Source: Linkdrift mirror of an X Article by @m4lkxx, 14 min read, Oct 20 2026. Only a truncated excerpt was retrievable.
- Excerpt facts: an 18-second 3D animation, nine rounds of review stills, two full versions, "every defect I can prove"; two voxel mascots climb out of their own launch posts on an X feed, fight across the cards, collide head-on, give up, and trade hearts; "Claude vs Grok. 18 seconds at 60 fps, one take, no cuts, every frame and every sound drawn by code that Claude Opus 5.5 wrote"; "The first full render looked finished. It wasn't. The post text was grey placeholder bars. The brief asked for real text."
- That last failure is an INVENTED FACTS case. Images 1 and 2 are this article's structure: the five roles, and the ten-class defect taxonomy.
- No tool/repo was verified from this post.

### 2.2 m4lkxx, 2026-10-31 — status 2116504147465757161
- Nothing retrievable. Search by ID and by handle+date returned no relevant result.
- Do not assign PromptMotion's two other @m4lkxx entries ("Twelve code-generated design assets from one-line prompts", "One character rendered in 12 distinct visual styles") to this status — nothing ties them by date or ID.

### 2.3 cryptowluha, 2026-10-31 — "House Growth Animation"
- Verified only via catalogue: awesome-opus5-5-videos (github.com/menotbobbybrown/awesome-opus5-5-videos, README fetched) lists "House Growth Animation" by @cryptowluha under "Latest prompts". Repo states 703 prompts, 418 with a live remake on Skillry; "Every video here was made by asking Claude Opus 5.5 to write the animation as code (HTML, Canvas, SVG, Three.js and friends)"; some creators shared only part of their prompt. The prompt file itself was not opened, so its wording is not verified.
- Second-hand video description only (Instagram/Facebook reposts by other accounts, not @cryptowluha): blue blueprint "Built from the blueprint up", then foundation → wood framing → sheathing/roofing → completed exterior → interiors → backyard from dirt to landscaped pool, ending "Let's build yours." Some reposts credit "Opus 5.5 + Higgsfield". Treat as a match to the title, not as this post's transcript.
- Lesson for the tool: a stage-by-stage build is a strong case for spacing, easing, follow-through, STAGING, CONTACT (parts must meet/attach correctly as the house assembles), and HIDDEN HISTORY (a frame must not "remember" a previous stage's geometry).

### 2.4 hurricodes, 2026-10-30 — status 2116072252177289220
- Nothing retrievable about this status. Searches by ID, handle+"motion", handle+"After Effects"/"PDF" found no text.
- Do not attribute: weekly.joebuildsai.com (Oct 31) says '@hurricodes claims "Anthropic literally dropped an entire Claude degree on GitHub for FREE" (7 repos, about 465K stars combined)' — timing fits, but the article does not link the claim to this status ID, the claim is about Claude-skills repos not motion, and the article itself warns attributions could not be verified. Treat as an unverified candidate.
- Do not attribute the TweetResearch briefing at tweetresearch.pm7.dev/2108899503092740561 ("You no longer need After Effects", 1080×1080 demo, PDF best-practices, steps described as "anticipation, arcs…") — different status ID, no author named. Useful context on the PDF+principles pattern only.
- If the post were the skills-repo claim, its lesson would be: vet shared skills/repos (stars ≠ working; check last commit, issues, license) before adopting them.

### 2.5 t.co/2Rr5NUPEvr → scenario.com/explorations/motion-loops/
- "Motion Loops · Seamless loops in code | Made with Scenario". 80 seamless loops for AI video; "Backgrounds and shape animations to put behind a title or into the quiet seconds between AI shots. Every loop is a few dozen lines of Canvas code: open one, copy it as a single HTML file, change the colours, render it at any size."
- Key rule (search result): "draw each frame as a function of time, every motion on a period that divides 12 seconds." A `scenario-motion-loops` skill is listed in `scenario-labs/skills`.
- Lesson: loops are a contract — last frame = first frame, cursor position and speed included. Verify loop closure numerically (first-vs-last frame diff).

### 2.6 t.co/daU959py1m → github.com/alchaincyf/huashu-art-motion
- Public repo, MIT, created 2026-10-06, 6,479 stars / 647 forks at fetch. "36 art styles · 9 explainer grammars · 8 parameterized clips", `npx skills add alchaincyf/huashu-art-motion`.
- Verified in README: `scripts/analyze/breakdown.py` (turn a reference animation into a code-able map: cuts, beat grid, motion heatmap), `qa.py` (stability, efficiency, motion, smoothness, text framing), `film_gate.py` (anti-PPT gate: flags a film with almost no in-shot fast motion; checks mid-film empty frames), `deliver.py` (gate → copy film → write delivery note, facts written by script), 53 style recipe cards, 9 grammar cards, long-scroll skeleton, `render.py --audit` / `clip_lint.py` / stress tests.
- Origin story: a code-only recreation of Tak's (@cherry_mx_reds) 15-second Art History Speedrun; first version was "transitions between stills", rejected because in the original "every element is flowing" — so they measured first, then redrew in code layer by layer.
- Already installed locally at `~/workspace/custom-skills/local-huashu-art-motion/` (v1.2.0, mastered Oct 27 2026, first Company Wars use done). Do not re-learn it from scratch; reuse its breakdown/qa/film_gate/deliver pattern.

### 2.7 Corroborating method (verified, fetched pages)
- Ray Fu, "Motion Design Studio" guide (raycfu.com/guides/motion-design-studio-opus-5-5, fetched to line 389): extract one frame every 0.5s with ffmpeg, study pacing shot by shot, write `style_guide.md` (palette hex, type family/weight/spacing, shot lengths, transition types, camera moves, texture, text enter/exit) and `shotlist.md`; "take the grammar of the reference, never its content, logos, or characters"; `lib/motion.js` closed-form damped spring `spring(t, k=170, d=26)`, `track()` stacking one spring per target change; "tiny overshoot on UI, none on type"; motion blur by rendering 4 subframes/frame and blending (`tmix`); beat grid (120 BPM, hits on the measured beat grid); banned list is "the most important part" (centered title on a gradient, everything fading in, corner labels/frame borders, glow on UI, generic particle bursts); loop rule: last frame must equal first; "The prompt is about 10% of the video. The other 90% is the system"; "Never redraw the product UI from imagination… Use real screenshots, the real logo, real colors and fonts."
- Florence's Motion Lab via The Hype test (thehype.news/opus-5-5-motion-lab-halloween-animation/): Florence @flxrnc, Sep 30 2026, 1.27M views; test: 22s Halloween short, 21 review rounds, ~2.5h, ~$34 API-equivalent. Follow-ups "point at frames, not feelings, with 1–2 fixes per round"; "'Make it pop' becomes a scale from 1.0 to 1.08 and back in 6 frames"; every event tied to a frame number; BANNED list "grows after every render"; round 3 caught a 3-frame white flash; logo caught by pixel measurement.
- AICU analysis (secondary): 128 BPM, 32 beats = exactly 15s, "MOVE on the 4th beat, explosion on the 28th."
- Min Choi system prompt (via search excerpt, secondary): frame one must work as a standalone still/hook within 1s; one anchor object must land on the exact same pixel coordinates across scene handoffs.

## 3. Lessons that transfer to the headless tool
1. Reference teardown must output a measured spec, not a vibe. Style guide + shotlist first, gated before any code. Huashu's breakdown.py (cuts, beat grid, motion heatmap) is the mechanical precedent.
2. Enforce a deterministic render contract: `seek(t)` is a pure function of time. No CSS transitions, no setTimeout/requestAnimationFrame in render mode, no carried state, seeded noise only. This is what makes frame-exact review, re-renders, and defect attribution possible — the RENDERER role.
3. Ship an easing/timing picker as numbers and a springs library, not adjectives. Spring stiffness/damping presets, a beat-grid picker, named easings with frame counts, subframe-blur as a render flag. An agent picks values, not words.
4. Make the defect taxonomy executable, with a provable check per class (see §5).
5. Keep a banned/defaults list that grows after every render. Persist it per brand/project, auto-append each confirmed defect's pattern, lint against it before rendering.
6. Separate the five roles and make the Critic independent and frame-pointing. Log each defect as (class, frame/timecode, evidence still, fix). That log is the training data for the taxonomy and the banned list.
7. Treat loops and the first frame as contracts. Verify loop closure numerically; render a first-frame still for approval before the full render.
8. Do not trust stars, views, or "one-prompt" claims; verify the harness. Record provenance for every adopted skill/repo, and store every "one-shot" claim with its real prompt count, rounds, and cost.

## 4. The three asks, mapped to design

### 4.1 Excellent reference teardown
- Input: reference video + small config (ROIs/targets).
- Output, one file an agent can render from (`reference-profile.json`): measured palette (hex + source frame + sample coords), element geometry as ratios, event list (peak frame + energy), per-target centroid trajectory per frame, derived velocity/peak/hold/cut table, fps + frame count. Plus `style_guide.md` + `shotlist.md` in the Ray Fu sense: palette, type family/weight/spacing, shot lengths, transition types, camera moves, texture, text enter/exit — and what may NOT be copied (logos, characters, content).
- Rule: teardown must run and be approved before scene code is written. Copy the grammar, never the content.
- Borrow: huashu `breakdown.py` (cuts, beat grid, motion heatmap); Ray Fu 0.5s frame extraction + shot-by-shot pacing study.

### 4.2 Easing and timing picker
- Picker inputs: intent (travel / reveal / stamp / settle / draw / count-up), duration in frames, distance in px, reference trajectory if one exists.
- Picker outputs, ranked: named curve or spring preset + custom bezier, with per-candidate descriptors — peak velocity, time-to-peak, overshoot, settle time, predicted per-frame RMS error vs the reference velocity profile.
- Primitives the engine still lacks (grep-verified, §6): anticipation (small pullback before the main move), follow-through (tail settles after the body stops), spacing (distance between poses), motion blur (subframe blending, e.g. 4 subframes/frame as `tmix`).
- Timing rules already in the engine to keep and expose in the picker: camera travel 2s, camera lands 0.2s before its event, hold 1.2s after a label, focus stagger 0.2s, ramp 6 frames. The picker should surface these as defaults with reasons, not hide them.
- Beat grid: BPM → frame grid; events land on beats; "MOVE on the 4th beat" style pinning, not vague timing.

### 4.3 Genuinely easier for an AI to make motion graphics
- Five roles as separate, checkable steps: Director (one-line memory: what must the viewer remember), Reference (style guide + no-copy list), Timeline (what changes, on which frame — a table, not prose), Renderer (seek(t) pure function, frame export), Critic (independent, frame-pointing, scored 1–10 on hook-in-2s / readability at phone size / motion / variety / brand accuracy / sound sync; fix the 3 worst, repeat until every score is 8+).
- One anchor object on the exact same pixel coordinates across scene handoffs; first frame works as a standalone still.
- Contact-sheet review: one frame per beat, read at phone size, before a full watch.
- The MP4 is not the source: always ship `seek(t)` source + render script + beat grid alongside the MP4 (THE FILE class).

## 5. Defect taxonomy — executable version
Adopt Image 2's ten classes as the tool's QA schema, each with a check, not a feeling. Add two motion classes the images imply but do not name.

| Class | Check (provable) | Likely fix |
|---|---|---|
| INVENTED FACTS | every on-screen string/handle/logo exists in the asset manifest | replace with real asset; fail if manifest lacks it |
| DEFAULTS | banned-list lint before render | replace default with measured reference value |
| STAGING | contact-sheet review, one frame per beat; subject in frame, title inside frame | reframe / re-stage |
| SIGNS | face/screen direction check at staging frames | flip or re-stage the element |
| HIDDEN HISTORY | assert frame N does not depend on frame N−1 state (seek(t) purity test) | remove carried state; re-render from seek(t) |
| RENDER ARTEFACTS | flash/flicker detection, streak/ghost scan on diff frames | re-render affected frames; check encoder |
| CONTACT | overlap/intersection check at contact frames | move/attach the element correctly |
| COLOR | measure pixels against brand hex (ΔE, CIEDE2000) | correct the palette token, not the gate |
| THE FILE | source + render script + beat grid shipped with MP4; loop closure diff | ship the source; fix the loop |
| TASTE | scored rubric (see §4.3); first-frame still approved before full render | re-cut the opening |
| TIMING (new) | event peak frame vs reference, within 1 frame; hold length vs 1.2s floor | move the event; lengthen the hold |
| EASING (new) | velocity-profile RMS error vs reference; peak-velocity ratio; time-to-peak offset | pick a different curve/spring via the picker |

- Every failure row carries {class, code, frame, value, threshold, evidence still, suggested fix}.
- Log: append-only JSONL per run (`defects.jsonl`), aggregated to `defects-summary.json` (counts by class/code, worst frames). The banned list auto-grows from confirmed defects.
- Critic independence: the checker stays blind to the scene source (current design); attribution to scene fields (node/prop/ease/frames) is a separate script that reads report + scene, so the critic never grades its own work.

## 6. Engine audit, 2026-11-08 (summary; no files modified)
- What it is: deterministic, agent-first 2D motion renderer. Scene JSON (`hme.scene/1.0`, 1920×1080, 24 fps, 240 frames / 10s), headless render to MP4 at $0 marginal cost, frame-by-frame checker against a frozen predicate `pred-v1` (tamper-protected, exit 7 on tamper).
- Strongest area: determinism and per-frame checks. `sampleScene(scene, frame)` is a pure function; `lint-determinism` bans Date/Math.random/timers/network; keyed-hash randomness; `--verify-determinism` renders twice and compares frame hashes; checker decodes all 240 frames (SSIM/PSNR/motion/shift in `frames.csv`).
- Measured performance (v1, 2026-11-07): draft 76–88s, final 140–243s per 10s clip; byte-identical determinism proven for `scene-min` final. v2 re-benchmark produced no numbers: all 9 runs failed in ~1s with exit 5 (EPERM write block, environment, not engine).
- Visual quality: the only measured reference check FAILS — Seg3 checker: mean SSIM 0.686 vs 0.95 target, PSNR 9.96 dB vs 35, LPIPS 0.656 vs 0.08, 240 HARD_FLOOR rows, 720 MOTION_ERR, 119 MOTION_JUMP. Recorded cause: code-drawn reconstruction of hand-drawn art, plus reference 23.976 fps vs scene 24 fps.
- Reference teardown: manual and segment-specific; no generic teardown tool in `src/`. Exists: `verify-seg4/measure-palette.py` (21×21 median samples), `src/scene/compact.md` measured-reference path, palette `source` field, `verify-seg4/SKILL.md` 12-element feature map, `src/checker/layout.py` (472 lines, but hardcoded Seg4 palette), `run-layout-check.py`. Gaps: `tests/segments/seg3.json` and `seg4.json` both have empty `flat_regions`/`labels`/`events`; no segment configs for segments 1–2; no chart fixture; nothing extracts motion from a reference — no track, velocity, or timing table is ever produced; teardown output is prose/JSON traces, never a scene or token file an agent can render from. Seg4 has no 00:00–00:10 reference video at all, only a title-card thumbnail; yt-dlp blocked (429/bot-check), live-browser capture is the only remaining route.
- Easing/timing: solid curve library, no picker. `src/scene/easing.mjs`: 18 named cubic-beziers + arbitrary bezier, Newton+bisection solver, tested. Defaults hardcoded per module (easeInOutCubic for map camera/routes/bar-race; easeOutCubic for kinetic text/count-ups/focus dim). Timing primitives exist (integer-frame keys, events, travel 2s, land 0.2s before event, hold 1.2s after label, stagger 0.2s, ramp 6 frames). Missing: no picker, no curve-property table, no reference-curve fitting, no velocity-profile comparison in the checker, and no anticipation / follow-through / spacing / motion-blur concept anywhere in the engine (grep-verified).
- Defect detection: strong per-run, no taxonomy, no memory, no feedback. Checker stages S0–S8, fail-fast, ~50 distinct failure codes (COLOR_FAIL, HARD_FLOOR, CAMERA_LATE, HOLD_SHORT, G8_FLOOD, FONT_SWAP_SUSPECT, MOTION_ERR, MOTION_JUMP, TEXT_SHIFT, …), every row with {value, threshold, comparator}, worst-5 diff PNGs, blind side-by-side gate needing a human-written `human-gate.json`. Missing: no defect taxonomy file, no `*defect*`/`*taxonomy*`/`*history*.json anywhere, no aggregation across runs, no mapping code → cause → scene field to change, no log a fix cycle writes to. Fix cycles are prose in run reports and a 3-cycle "stuck ladder" in `verify-seg4/SKILL.md`.
- Docs note: no root README.md and no docs/ folder; de-facto docs are `benchmark/README.md`, `src/scene/compact.md`, `prompts/01–05-*.md`, `sources/*.md`, `verify-seg4/SKILL.md`. Fonts update: `assets/fonts/` now holds verified Montserrat Bold + Anton; the benchmark README's "fonts still missing" gap is stale for fixtures.

## 7. Smallest concrete additions, in leverage order
None requires lowering `pred-v1`. New checker measurements land as info-only stages first (like S8) and are promoted only under a new predicate version.
1. Generic reference teardown — new `src/reference/teardown.py` (generalise `src/checker/layout.py: segment_frame` + `verify-seg4/measure-palette.py` + `src/checker/events.py`/`motion.py`). Output `reference-profile.json` (§4.1). Prove it: run on `refs/seg3-glue-tape-240f.webm` — reproduce known Seg3 facts (240 frames, 23.976 fps, two targets) and emit a trajectory whose peak frames match the checker's S2 event peaks within 1 frame; run on Seg4 thumbnail frames and reproduce `verify-seg4/evidence/seg4-trace.json` widths within the existing 0.02 ratio tolerance.
2. Easing/timing picker — new `src/scene/pick-ease.mjs` + CLI (`--intent travel --frames 48 --distance 600`, and `--fit <reference-profile.json> --track <id>`). Computes per-curve descriptors from `src/scene/easing.mjs` (peak velocity, time-to-peak, overshoot, settle) and ranks the 18 named curves + best-fit custom bezier; `--fit` compares a reference trajectory's normalised velocity profile against each candidate with predicted per-frame RMS error. Prove it: a synthetic reference trajectory generated with a known ease (e.g. easeOutQuint over 48 frames) must be recovered as the top-ranked curve; `tests/scene/easing.test.mjs` still passes unchanged.
3. Velocity-profile check — new info-only checker stage (S8-style, in `src/checker/stages.py`, never changing the verdict). Compare render vs reference per-target velocity profiles: peak-velocity ratio, time-to-peak frame offset, RMS velocity error. Prove it: ~0 error on identical clips with verdict still PENDING_HUMAN; nonzero velocity error on the Seg3 fixture consistent with the existing 720 MOTION_ERR rows.
4. Defect taxonomy + log — new `src/checker/defects.json` + `src/checker/defects.py`. `defects.json` maps every existing failure/flag code to {class, likely_causes[], scene_fields[], suggested_fix} using §5 (ten classes + TIMING + EASING). `defects.py` appends one JSONL row per failure to `out/<seg>/check/defects.jsonl` and writes `defects-summary.json`. Prove it: re-run the checker on the Seg3 fixture — the log must contain the 240 HARD_FLOOR + 720 MOTION_ERR rows classified, and summary counts must exactly match `report.json` failures. No predicate change.
5. Attribution bridge — new `src/checker/attribute.py` (separate script, checker stays blind). Reads `report.json` + `frames.csv` + scene JSON, maps failures to scene fields (MOTION_ERR frames → active timeline tracks/eases/nodes; COLOR_FAIL region → palette key). Output `attribution.json` with failure → {node, prop, ease, frames}. Prove it: on Seg3 every MOTION_ERR frame attributes to ≥1 active track; on a synthetic scene with a single known-bad ease, attribution names that track.
6. Fill the two missing reference configs: populate `tests/segments/seg3.json` flat_regions/labels/events from teardown output, and add a `chart-sample.json` fixture (benchmark README already flags it as blocking any chart claim). Prove it: checker S1/S2/S3 stages actually run on Seg3 instead of being skipped; benchmark gains a chart row or records "not applicable" with reason.
7. Banned/defaults list — new per-project `banned.json`, linted before render, auto-appended from confirmed defects (Florence/Ray Fu pattern). Prove it: a render that repeats a previously confirmed default fails lint before spending render time.
8. First-frame + loop contracts — render a first-frame still for approval before the full render; verify loop closure numerically (first-vs-last frame diff) for loop intents. Prove it: a loop whose last frame differs from its first fails the check with the diff value.

## 8. What not to build on
- Do not treat the m4lkxx Oct 31 post, the hurricodes post, or the cryptowluha prompt as known — they were not retrievable. Do not assign the t.co links to specific posts.
- Do not copy reference content (logos, characters, post text). Copy grammar only. The REFERENCE role must list what may not be copied.
- Do not lower `pred-v1` to make a new check pass. New measurements start info-only.
- Do not trust stars/views as proof a skill works; record provenance and test in a sandbox (huashu was verified this way on Oct 27: 2s test render, 960×540, ~13s, clean).

## 9. Open follow-ups (need live browser / Richardson)
- Open the four X posts in the live browser to capture full text/video; open the full m4lkxx article to recover the complete defect list and role definitions; open the cryptowluha prompt file in awesome-opus5-5-videos/prompts/; confirm or rule out the hurricodes "Claude degree" attribution.
- Decide: approve the 8 additions in §7 as a Handover (Stage 1 then Stage 2, no build before approval — the standing rule from the style-copy tournament side chat), or pick a subset (teardown + picker + taxonomy are the three that serve the three asks directly).
- Note: the style-copy tournament side chat (8ea9728a-ff2f-40ed-b4c0-44361907351d) is still pending; its predicate (mean SSIM ≥0.95 Seg3 / ≥0.96 Seg4, PSNR ≥35 dB, LPIPS ≤0.08, flat colour <3 ΔE, per-frame SSIM ≥0.90) and $5 cap stand and are not changed by this study.

## Sources
- m4lkxx article mirror: linkdrift.app/article/1e6c7d0e-0fd0-46e8-9f7c-f2abe5b4e3bd
- awesome-opus5-5-videos: github.com/menotbobbybrown/awesome-opus5-5-videos
- Scenario Motion Loops: scenario.com/explorations/motion-loops/
- Huashu Art Motion: github.com/alchaincyf/huashu-art-motion (local: ~/workspace/custom-skills/local-huashu-art-motion/)
- Ray Fu guide: raycfu.com/guides/motion-design-studio-opus-5-5
- Florence Motion Lab test: thehype.news/opus-5-5-motion-lab-halloween-animation/
- Engine audit inputs: ~/workspace/headless-motion-engine/src/, benchmark/README.md, benchmark/results-2026-11-07.json, src/checker/predicate.json, verify-seg4/
