# Handover Stage 2 Manifest, Headless Motion Engine
Date: 2026-11-07
Version: stage2-v1
Stage 1 file: workspace/handover-headless-motion-engine/stage1-package.md
Stage 1 digest (first 16 of sha256): d4e4fed6a779fc06
Predicate version: pred-v1, from Stage 1 section 3. No change to thresholds.
Kit: Case B, kit to be generated. No proven kit. First task is the proof run.
Playbook: Handover v4, local-handover skill, plus Harris map skill for segment 4.

## Model split
- Sonnet 5.5 ONLY for interface prompts and motion design engine logic.
  Model: anthropic/claude-sonnet-5.5 via OpenRouter, Claude Code route, transient capped key, cap $15, deleted after use, report only name, cap, tokens, cost.
  Env, process only: ANTHROPIC_BASE_URL=https://openrouter.ai/api, ANTHROPIC_AUTH_TOKEN=<transient>, ANTHROPIC_MODEL=anthropic/claude-sonnet-5.5.
  Gate: test prompt "Reply with one word: ready" must return "ready", exit 0, before any real run.
- Muse Spark 1.3, Moon's default model, for all other work: research, coordination, rendering, verification, judging, reporting.
- No Opus, no Sonnet 4.5, no other model, without a new approval.

## Tools and targets allowlist, with risk
- browser.search, browser.open: low, read only, sources in Stage 1 only.
- muse.read, muse.write, muse.edit, muse.exec: medium, workspace only, paths under ~/workspace/headless-motion-engine/ and ~/workspace/handover-headless-motion-engine/.
- subagent.spawn, subagent.list, subagent.send, subagent.close: medium, depth max 2, hard spawn count 12 for this run.
- artifact tools: low, only if a report file needs a readable form, no publish.
- OpenRouter or_api.py: medium, credits check and transient key mint only, never print or persist a raw key.
- No tool outside this list. No push, deploy, post, send, pay, delete, or external contact.

## Failure threshold
- N=3: same tool fails 3 times in a row, stop retrying it, escalate to Richardson.
- Loop budget: 5 fix cycles per run, shared across units. 3 distinct approaches per failure class, then hold that unit.

## Limits and budget ledger
- Hard cap: $25 total external spend. Sonnet portion cap $15. Verification reserve $3.75, at least 15 percent.
- OpenRouter balance Nov 7, 2026: about $7.01 left. Top up is needed before Sonnet runs use the full cap. Do not mint a key or spend beyond the remaining balance without Richardson's top up approval.
- No spend beyond ordinary costs without his explicit approval, per Nov 2, 2026 model rule.

## Units and checks
- A: Sonnet prompt pack, 5 prompts. Check: each prompt names inputs, outputs, and its check, and fits the scene format.
- B: Engine core on HyperFrames. Check: renders a 10 s test at 1080p, deterministic, same input gives same output.
- C: Map module. Check: Harris G8 and G9 pass on a sample map frame.
- D: 4 test segments. Check: predicate in Stage 1 section 3, frame by frame.
- E: Verifier and judge, fresh context. Check: independent SSIM, PSNR, LPIPS, Delta E, px error, plus blind human gate.
- All units start failing. A unit passes only when its check passes. Done means every unit passes.

## What this manifest authorizes
- Read, write, render, and check locally, inside the paths above, inside the $25 cap, with the model split above.
- It does NOT authorize publish, send, pay, delete, deploy, post, or any outward action. Those need a new approval with exact action, destination, payload, limit, and condition.

## Approval
Approve or reject this whole manifest. Approval starts the build inside this envelope only.
