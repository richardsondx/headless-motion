# Handover Stage 1, Headless Motion Engine
Date: 2026-11-07
Status: Revised 2026-11-07, model split set at Richardson's ask: Sonnet 5.5 only for interface prompts and engine logic, Muse Spark 1.3 for the rest. Awaiting Stage 2 approval. No build yet.

## 1. Intent and audience
Outcome: Build a headless motion engine that lets an agent write smooth 2D animation, at the level of top YouTube animation channels.
Audience: Richardson, as builder and first user. Later use: his animated channels, including Atlas Room map work.
Use: Agent writes a scene in code, renders frames, looks at frames, revises code, renders final video. No human editor to drive.

## 2. Deliverable
- Engine repo under ~/workspace/headless-motion-engine/, with scene format, renderer, map module, chart and text module, and frame checker.
- Claude Sonnet 5.5 prompt pack that generates the engine, one prompt per module, with inputs, outputs, and checks. Sonnet 5.5 is used ONLY for interface prompts and motion design engine logic. All other work uses Moon's default model, Muse Spark 1.3, the smartest reasoning and coding model available to Moon in this workspace.
- 4 test renders, one 10 second segment per video, at 1920x1080, with frame diff reports.
- Field kit for this work, recorded in FIELD-KITS.md, proof status draft until the 4 tests pass.

Test videos, locked as sources, not as exact frames yet:
1. Kurzgesagt bananas, tRXy-b6_lBc, 00:00 to 00:10, alternate banana rain city shot if found by transcript.
2. Kurzgesagt first civilization, _y9JuojAIg0, 00:00 to 00:10, alternate Gobekli Tepe reveal if found by transcript.
3. TED-Ed glue vs tape, HHuTrcXNxOk, 03:05 to 03:15, verdict beat.
4. Search Party UAE map, fUrNOVjWUVM, 00:00 to 00:10, map frames only.

## 3. Finish predicate
Pass means all 4 segments pass the pixel and motion checks below, plus a human blind check.
- Mean SSIM at 1080p: at least 0.98 for videos 1 and 2, at least 0.95 for video 3, at least 0.96 for video 4.
- Per frame minimum SSIM: at least 0.90, no frame below 0.85.
- Mean PSNR: at least 38 dB for videos 1 and 2, at least 35 dB for videos 3 and 4.
- LPIPS: at most 0.05 for videos 1 and 2, at most 0.08 for videos 3 and 4.
- Motion: camera or object target error under 2 px at 1080p, no jump over 4 px unless the reference has it.
- Text: no label shifted over 2 px, no font swap visible at 200 percent zoom.
- Fail fast: any wrong flat colour over 3 Delta E, any missing event, or any label in the wrong place fails that segment, even if mean SSIM passes.
- Map segment also passes Harris G8 contrast (text at least 7:1, line at least 3:1) and G9 focus and camera (one focus, travel-land-hold, 1.2 s hold after labels).

Passing example: Segment 4 renders El Fasher map, SSIM 0.97, PSNR 36 dB, label within 1 px, camera error under 2 px, human cannot tell it from the reference at full speed.
Failing example: Segment 1 renders SSIM 0.99 but the title font is wrong at 200 percent zoom. That is a fail, not a pass.

Note: pixel identical against a YouTube re-encode is not bit identical to the studio master. Pass means indistinguishable after YouTube compression, by the numbers above.

## 4. Constraints and assumptions
- Do not build a new renderer first. Renderer is solved. Missing piece is taste, timing, easing, and checking.
- Base is HyperFrames (HeyGen, Apache 2.0, HTML plus GSAP, headless Chrome, FFmpeg). Remotion is the second runtime, for data heavy scenes and scale.
- Do not build on Vork for 2D. Vork is 3D and VFX only, research preview, licence unclear, no text, chart, map, or timeline system. Keep Vork for later 3D shots only.
- Do not build on Motion Canvas or Revideo as base. Upkeep has slowed, and they lack DOM, text, and map tools.
- Do not use template video APIs for the tests. They cap quality by design.
- After Effects stays the quality reference and polish step, not the agent engine.
- Use Harris map tokens from ~/workspace/borderline/research/harris-map-tutorials-study.md and the local Harris map skill for segment 4.
- Assumptions marked: fps and resolution per video are not yet verified (assume 24 fps, 1080p test, 4K only after 1080p passes). Exact frames for segments 1 and 2 are not yet seen, only inferred from opening narration. Tweet text for Ravi Parikh was not directly verified (x.com blocked for direct fetch); claims come from Voyager pages and secondary summaries.
- What must not change: no push, deploy, post, send, or pay without a separate approval. No use of copyrighted video frames beyond the test comparison in this workspace.

## 5. Authority envelope
- Autonomous scope: read sources, write code and prompts in the workspace, render locally, run frame checks, revise inside the plan.
- Methods: HyperFrames, GSAP, MapLibre, D3, GeoJSON, FFmpeg, headless Chrome, Python checks for SSIM, PSNR, LPIPS.
- Time: no fixed clock limit in Stage 1. Loop budget: up to 5 fix cycles per unit, 3 distinct approaches per failure class, then dead end report.
- Cost: see section 9. Hard cap $25 for Sonnet 5.5 prompt generation and proof, advisory until balance is topped up. OpenRouter balance checked 2026-11-07: total credits $305, usage $297.99, remaining about $7.01. That balance alone will not cover the $25 cap. Top up, or a smaller scope, is needed before Sonnet runs start.
- One way doors: none listed in Stage 1. Any publish, send, pay, delete, deploy, or post needs a new approval with exact action, destination, payload, limit, and condition.
- Prohibited: no new renderer from scratch, no Vork as 2D base, no lowering of the pixel thresholds to claim a pass, no re-scoring of held out test frames to get a better score.
- Tool allowlist: browser search and open, file read and write in ~/workspace/headless-motion-engine/ and ~/workspace/handover-headless-motion-engine/, exec for local render and checks, subagents up to depth 2, OpenRouter for Opus 5.5 only for the prompt pack.

## 6. Plan and routing
Case B: kit to be generated. No proven kit exists for this field. First real task is the proof run, the 4 segments.
Graph, not a single line:
- Node A: Sonnet 5.5 prompt pack (5 prompts: scene format, renderer adapter, map module, chart and text, frame checker). Sonnet 5.5 writes the interface prompts and the motion design engine logic only. Moon, on Muse Spark 1.3, writes the rest, coordinates, verifies, and judges.
- Node B: Engine core on HyperFrames (depends on A).
- Node C: Map module (depends on A and B, uses Harris tokens).
- Node D: 4 test segments (depends on B and C, join node).
- Node E: Verifier and judge, fresh context, checks D against section 3.
Serial in this environment. Units with no dependency run in order, not at the same time.
Effort: complex work, more than 10 subagents across the run, each with a divided job, coordinator owns plan and record.

## 7. Verification
- Generator never verifies its own work. Verifier gets spec and artifact only, no generator notes.
- Deterministic checks first: SSIM, PSNR, LPIPS, Delta E, px error, frame by frame.
- Human gate: blind side by side at full speed and at 0.25x, plus still frames at 1 s, 5 s, 9 s.
- Judge in fresh context gives verdict, records gaps as Fixed, Queued, or Accepted, with owner and next step. Done means all gaps fixed, or all remaining gaps explicitly accepted by Richardson.

## 8. Iteration and stopping
- Stuck ladder in order: retry with corrected input, switch source or evidence route, split unit smaller, replace method, hold that unit while the rest continues.
- After 3 distinct approaches for the same failure class, hold that unit and report a dead end for it.
- Loop budget 5 fix cycles per run, shared across units. Cost cap spent ends the run with a dead end report.
- Dead end report states what stopped, what was tried, what would unblock it, and options Retry unchanged, Change scope or limit, or Stop.

## 9. Operations, budget ledger
- Model split, set Nov 7, 2026: Sonnet 5.5 ONLY for interface prompts and motion design engine logic. Model: anthropic/claude-sonnet-5.5 on OpenRouter, claude-sonnet-5-5 on Anthropic. List price $2 per 1M input, $10 per 1M output, cache reads $0.10 per 1M. Context 1M tokens. This is the proven Sonnet in this workspace, Oct 27 and Nov 2, 2026, via Claude Code through OpenRouter. Sonnet 4.5 failed the local model check in that setup, so do not use it here. All other work, research, coordination, verification, judging, and reporting, uses Moon's default model, Muse Spark 1.3. No other model is used for the rest without a new approval.
- Budget: $25 hard cap for external Sonnet 5.5 prompt generation and proof, with at least 15 percent ($3.75) held back for verification and dead end report. Sonnet spend is capped at $15 for interface prompts and engine logic, the rest of the $25 is reserve and verification. Remaining OpenRouter balance about $7.01 on 2026-11-07, so top up is needed before Sonnet runs use the full cap. Moon's default model work carries no separate OpenRouter charge in this plan.
- Checkpoint: decision trail, one line per decision, and budget ledger, both in ~/workspace/handover-headless-motion-engine/.
- Resume: durable state, per unit list with passes field, starting as failing, changed to passing only when its check passes.

## 10. Approval
Approve or reject the whole package, including assumptions and limits above.
Stage 1 approval authorizes Stage 2 manifest creation and the work inside the envelope only. It does not authorize a publish, send, pay, delete, deploy, or post.
If approved, next step is Stage 2 manifest with exact tools, targets, limits, and the Sonnet prompt pack, for a second approval before the build runs.
