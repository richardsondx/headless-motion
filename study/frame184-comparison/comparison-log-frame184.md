# Frame 184 comparison log

Corrects the beach comparison mistake. The beach had no reference. This time
the scene IS frame 184, and frame 184 is the reference. All three models got
the same prompt, prompt v8, unchanged.

## Prompt

- File: kurzgesagt-prompt-v8-still.md
- SHA 1a9c73f1, 4,935 bytes, 43 claims (C1 to C43)
- The word "rises" appears 0 times. No em dashes.
- The note file (prompt-v8-note.md) was NOT sent to any model. It is for the
  record only.
- What v8 describes: gradient wash background with 5 measured RGB stops,
  descending figure, bare midriff, ground shadow, red crown patch, side tuft,
  face colors, stance coordinates, crop (head outside the top edge, legs cut
  at the bottom edge). No sun, no orange circle, no accent shape.

## Reference

- File: ~/workspace/handover-frame-style-prompt-fix2/reference-frame-shot3.png
- SHA f51e27e8, 1920x1080, Kurzgesagt frame 184, timestamp 3.0667 s
- Cost $0.00

## Muse Spark (Flare image model)

- Route: python3 ~/workspace/custom-connectors/custom.legacy-openai/bin/oai_images.py
- Model slug discovered at runtime with `models`: gpt-image-2.6-flare
- Generate with --size 1536x1024, prompt sent unchanged
- Output: muse-spark-frame184.png, SHA fb558849, 1536x1024 RGB, 1,301,394 bytes
- Cost about $0.034 estimated (the CLI reports no token count)
- One generation, no 429, no retry, no generation ID from the CLI

## Terra 6.1 (SVG text model)

- Route: OpenRouter chat completions, model openai/gpt-6.1-terra
- Transient $2-capped key, minted, used once, deleted, verified absent
- First attempt at max_tokens 8000 402d: "can only afford 6542"
- Retried at max_tokens 6000, succeeded
- Generation ID: gen-1794547951-jqlUJEYaFqfxqYz5QB3Z, finish_reason stop
- Usage: 1501 prompt + 2185 completion (516 reasoning) = 3686 total tokens
- Cost $0.0128005 from the usage object (the generation endpoint returned 404)
- Response: terra-6.1-frame184-response.md, SHA 71bfd3f6, 4,710 chars
  (one line of prose plus the SVG in a fence, no analysis)
- SVG: terra-6.1-frame184.svg, SHA 81a9de98, 4,652 chars, complete closing tag
- Rendered to PNG with Playwright (Chromium set_content plus screenshot,
  no system SVG renderer exists): terra-6.1-frame184.png, SHA 7367b2fa,
  1536x1024 RGB, 97,620 bytes
- One generation, plus one max_tokens retry after the 402

## Fable 5.2 (unavailable, retry after credit top-up failed on reasoning)

- Route: OpenRouter chat completions, model anthropic/claude-fable-5.2
- Transient $2-capped key, minted, used once, deleted, verified absent
- First attempt at max_tokens 8000 402d: "can only afford 817"
- Retried at max_tokens 800, 402d again: "can only afford 753"
- No generation ran, no cost incurred, no response file, no SVG
- Root cause then: OpenRouter account credits were exhausted. Credits check
  returned total_credits 335, total_usage 335.03643535. The account used
  $335.04 against $335 in credits. A full Fable SVG plus prose response
  needs about 3,800 completion tokens (last time 3,816), but the account
  can only afford about 753 tokens at Fable's price.
- Retry after Richardson added credit: credits check returned
  total_credits 345, total_usage 335.04923585, so $10 was added and the
  402 block is gone. The generation ran: gen-1794548665-oNbuxIJnNxgiUz3alAK6,
  finish_reason length, usage 2040 prompt + 8000 completion = 10040 total
  tokens, cost $0.33632. But all 8000 completion tokens were reasoning
  tokens (reasoning_tokens 8000, image_tokens 0), so the model produced
  no output text at all and the response content was null. No response
  file was written, no SVG was extracted, no image exists. The key was
  deleted and verified absent.
- Mechanism: Fable 5.2 is a reasoning model and it spent the whole
  max_tokens budget on reasoning, then hit the length limit before it
  wrote any output. The last successful Fable run used only 1807
  reasoning tokens out of 3816 completion tokens, so the reasoning
  length is highly variable. A fix would need either a larger
  max_tokens budget (so output fits after reasoning) or a cap on
  reasoning tokens, neither of which was in this task's envelope.
  The task allows one generation plus one 402 retry only, and this
  was not a 402, so no further retry was made.
- Retry at the larger budget Richardson chose (max_tokens 16000):
  credits check returned total_credits 345, total_usage
  335.38555585. The generation ran: gen-1794549316-LLYUCa5OaUCUiHnT5vJT,
  finish_reason length, usage 2040 prompt + 16000 completion = 18040
  total tokens, cost $0.65632 from the usage object (the generation
  endpoint returned 404). All 16000 completion tokens were reasoning
  tokens (reasoning_tokens 16000, image_tokens 0), so the response
  content was null again and no output text, response file, SVG, or
  image exists. The script handled the null content without crashing.
  The key was deleted and verified absent. Script:
  fable_retry_16000.py, SHA 0b79eec0.
- Finding: raising max_tokens does not fix it. Reasoning expanded to
  fill the whole budget at 8000 and again at 16000. The remaining fix
  is a cap on reasoning tokens, not a larger budget. That was not
  authorized in this task, so no further retry was made.
- Retry with reasoning capped, as Richardson said to just cap it
  (reasoning max_tokens 3000, overall max_tokens 8000): credits check
  returned total_credits 345, total_usage 336.04187585. The generation
  ran: gen-1794549855-OBZSMU7BbC5Hg8sVJ4BH, finish_reason length,
  usage 2040 prompt + 8000 completion = 10040 total tokens, cost
  $0.33632 from the usage object (the generation endpoint returned
  404). The cap did NOT take effect: all 8000 completion tokens were
  reasoning tokens (reasoning_tokens 8000, image_tokens 0), so the
  response content was null again and no output text, response file,
  SVG, or image exists. The script handled the null content without
  crashing. The key was deleted and verified absent. Script:
  fable_retry_capped.py, SHA 1c7c4029. The reasoning cap parameter was sent as
  `reasoning: {"max_tokens": 3000}` in the request body, but the model
  still reasoned for the full 8000-token completion budget, so the cap
  was either not passed through by OpenRouter for this model or not
  honored by the model. No further retry was made, per the task.
- Grid panel stays labeled unavailable, with the reason on the panel
- Retry with reasoning effort low, as Richardson said to give it room with
  a max budget of $3 (reasoning {"effort": "low"}, overall max_tokens
  16000): this run DID produce output, unlike the three earlier retries.
  The response file fable-5.2-frame184-response.md (SHA aec286a9, 4,871
  bytes) and the SVG fable-5.2-frame184.svg (SHA c086a15f, 3,649 bytes,
  complete closing tag, 5 gradient stops) exist on disk, written Nov 13
  06:10 UTC (01:10 EST). The response opens "I can't render a raster
  image, so I've built this as an SVG (square frame assumed)". The cost
  is about $0.21268, derived from the OpenRouter credits counter (usage
  rose from 336.37819585 after the capped retry to 336.59087585 before
  the Sonnet call), not from the generation endpoint. Richardson said
  "ok stop it" at 01:09:37 EST, so that run was stopped, but the SVG
  was already written. The SVG was later rendered to PNG with Playwright
  (render_fable.py, same letterboxed 1536x1024 route as Terra):
  fable-5.2-frame184.png, SHA 9a84bcdb, 1536x1024 RGB, 97,302 bytes.
  The grid was rebuilt with the Fable panel filled in (see Grid below).
  Script: fable_retry_effort_low.py. The effort-low
  parameter is the one that worked: it is the same parameter the
  original successful fable_call.py used.

## Sonnet 5.5 (no image, produced prose instead of SVG)

- Route: OpenRouter chat completions, model anthropic/claude-sonnet-5.5
  (the latest Sonnet on OpenRouter at runtime, 439 models listed)
- Transient $2-capped key, minted, used once, deleted, verified absent
- Reasoning: {"effort": "low"}, the same parameter that worked once for
  Fable. Max tokens 8000.
- Generation ID: gen-1794550396-llzDcXNJCjc1PRyRw3ND, finish_reason stop
- Usage: 2040 prompt + 1477 completion = 3517 total tokens. Cost
  $0.01885 from the usage object (prompt $0.00408, completion $0.01477).
  The generation endpoint returned 404, so cost comes from usage.
  Completion split: reasoning_tokens 0, image_tokens 0. Sonnet did no
  reasoning at all, which is the difference from Fable.
- Response: sonnet-frame184-response.md, SHA 1160d0af, 3,639 bytes.
  It contains NO SVG. Sonnet treated the prompt as a spec to review:
  it listed 6 conflicts in the spec (palette vs other colors, head
  position vs crop, figure width vs arm extent, midriff span, shorts
  vs left hand, brightness) and wrote a condensed "build-ready prompt"
  restating the brief. It ended by offering to write SVG code if asked.
  The prompt never explicitly asks for SVG code, so Sonnet answered
  the text task instead of producing the image. No SVG file, no PNG.
  Script: sonnet_frame184.py.
- Cost $0.01885, well under the $2 cap. One generation only, per the
  task, so no further retry was made. The panel stays unavailable.
- Grid unchanged, no rebuild (no image to fill the panel with).

## Total new spend

- Muse Spark about $0.034 + Terra $0.0128 + Fable $0.33632 (failed
  8000-token retry, reasoning ate the whole budget, no image) + Fable
  $0.65632 (failed 16000-token retry, reasoning ate the whole budget
  again, no image) + Fable $0.33632 (failed capped retry, reasoning cap
  of 3000 did not take effect, reasoning ate all 8000 tokens, no
  image) + Fable about $0.21268 (effort-low retry, produced an SVG,
  cost derived from the credits counter) + Sonnet $0.01885 (produced
  prose, no SVG) = about $1.61
- Expected total was about $0.20. The three failed Fable retries cost
  $1.32928 and produced no image. The effort-low Fable retry cost
  about $0.21268 and did produce an SVG, which was rendered to PNG and
  put in the grid. No new model call was made for the render; no new
  cost was incurred.

## Grid

- File: comparison-4grid-frame184.png, SHA 104c900d,
  1608x1320 RGB, 564,684 bytes
- Layout: top-left Reference, top-right GPT Image 2.6 Flare, bottom-left Terra 6.1,
  bottom-right Fable 5.2 (rendered from the effort-low SVG, cost $0.21)
- Title "Frame 184. Same prompt. Four models." Dark #1B073B background.
  Each panel has a high-contrast label bar with the model name and cost.
  Panels fit into 768x512 cells, letterboxed, nothing cropped.
- Verified by reading the grid back. All four panels are filled; no
  panel is marked unavailable.

## Honest read of each panel

### Reference

The real Kurzgesagt frame 184. Smooth gradient wash from teal at the top
to violet purple at the bottom. Crown cropped at the top edge, legs cropped
at the bottom edge. Bare midriff with a navel and a pink waistband. Ground
shadow at the lower right. Red crown patch and side tuft. No sun, no orange
circle, no added shape.

### Muse Spark

Closest to the reference of the two models that rendered. Gradient present
and smooth. Face colors right: pinkish-red eyebrows, pink mouth, blush,
dark round eyes. Bare midriff with navel and pink waistband. Ground shadow
present at the lower right. Red crown patch and side tuft present. No sun
and no added shape. Misses: the crown is NOT cropped. The full head is in
frame with space above it, so the framing is wrong in the same way as the
v6 still. The top has short sleeves where the reference is sleeveless.
The extended hand has distinct fingers where the prompt asked for a rounded
blob with fingers barely separated. The figure is slightly narrower than
0.60 of frame width.

### Terra 6.1

Gradient present with the exact 5 RGB stops from the prompt. Crown IS
cropped at the top edge: the hair starts at y 0 and the red crown patch is
a band across the top edge. Face colors right. Bare midriff with navel and
waistband. Ground shadow present at the lower right. No sun and no added
shape. Misses: the figure is too narrow and tall, reading about 0.22 of
panel width instead of 0.60. The head is small with tiny eyes. The stance
is wrong: the arms hang down at the sides instead of one hand on the hip
and one arm extended out to x 0.81. The shorts curve down in a deep V at
the center front where the reference shorts run straight across. The red
crown patch reads as a headband because it is a wide flat band. The
SVG-primitive stiffness is visible: the figure reads as assembled shapes,
not a flowing pose.

### Fable 5.2

Gradient present with the exact 5 RGB stops from the prompt, smooth teal
to violet wash. No sun and no added shape. Face colors right: pinkish-red
eyebrows and mouth, blush, dark round eyes. Bare midriff with navel and a
red-orange waistband. Ground shadow present at the lower right, right
color and position. Red crown patch present as a band across the top of
the hair. The hair and red patch reach the top edge with no background
above them at the center, so the crown is technically cut, but the head
is small and the whole face shows, so it reads as a complete small head
with a red band, not the reference close-up crop. Legs are cut at the
bottom edge. Misses: the figure spans 0.39 of frame width, measured by
pixel count, instead of 0.60. The head is small with tiny dot eyes and a
long thin neck. The stance is wrong: the arms hang down at the sides
instead of one hand on the hip and one arm extended out to x 0.81. The
top has short sleeves where the reference is sleeveless. The shorts curve
down in a deep V at the center front where the reference shorts run
straight across, because the midriff shape dips down between the legs.
The red crown patch reads as a headband. The figure reads as assembled
shapes, not a flowing pose, the same stiffness as Terra. Of the two text
models, Fable is the fuller figure: its arms reach further out, its
midriff is wider, and its shadow is larger and more visible than Terra,
but both miss the stance and the proportions by the same kind of margin.

### Sonnet 5.5

No image. Panel stays unavailable. Sonnet stopped cleanly (finish_reason
stop, 0 reasoning tokens, cost $0.01885) but produced prose, not an SVG.
It treated prompt v8 as a spec to review, listed 6 conflicts in the spec,
and rewrote the brief as a condensed build-ready prompt. It never wrote
SVG code because the prompt never explicitly asks for SVG code. The
difference from Fable is sharp: Fable reasoned without bound and wrote
nothing, Sonnet did no reasoning and wrote an analysis instead of the
image. A follow-up that explicitly asks for SVG code is the obvious next
step, but it was not in this task, so no retry was made.

## Verdict

All four panels are now filled. Three of the four models rendered, and
all three got the gradient right and added no sun, which is the
correction v8 was built for. Muse Spark is closest overall but repeats
the v6 crown-crop miss: it drew the full head. Terra gets the crop right
but the proportions and the stance are wrong. Fable also gets the crop
technically right (hair and red patch reach the top edge) but the figure
is too narrow at 0.39 of frame width, the head is small, and the stance
is wrong in the same way as Terra: arms hang at the sides instead of one
hand on the hip and one arm extended. The two text models read as
assembled shapes, not flowing poses, while the image model draws pixels
so the pose flows but ignores the crop. Fable took four tries to produce
an image at all: credits exhausted, then reasoning consumed the whole
8000 token budget, then the whole 16000 token budget, then the 3000
token reasoning cap did not take effect and reasoning consumed all 8000
tokens again. The three failed retries cost $1.32928 and produced no
image. The fourth retry with reasoning effort low produced an SVG for
about $0.21, and that SVG was rendered to PNG and put in the grid, so
the Fable panel is now filled. Sonnet 5.5 was tried instead, at
Richardson's direction. It stopped cleanly with 0 reasoning tokens and
cost $0.01885, but it produced prose (a spec review and a condensed
brief) instead of an SVG, because prompt v8 never explicitly asks for
SVG code. No further retry is planned in this task.

## Sunburst attempt (Nov 13, 2026, 01:22 EST)

GPT Image 2.6 comes only as two variants, Flare and Sunburst, with no plain
gpt-image-2.6 slug. Richardson tapped to try Sunburst. One generation of
gpt-image-2.6-sunburst from prompt v8 unchanged at 1536x1024, cost $0.034,
no 429. Output: gpt-image-2.6-sunburst-frame184.png, SHA cd3d0617,
1,378,475 bytes, 1536x1024 RGB.

### Sunburst vs Flare, honest read

Both got the gradient right (smooth teal to violet wash, max per-row change
3.00 for both, prompt cap 4, reference 3.74) and added no sun (0 orange
pixels in the upper left for both). Both got the face colors right
(pinkish-red eyebrows and mouth, blush, dark round eyes), the bare midriff
with navel and red-orange waistband, the ground shadow lower right, the dark
navy shorts running straight across, the red crown patch, and the side tuft.
Both have one hand on the hip and one arm extended. Both miss the crown crop
the same way: the full head is in frame, not cut the way frame 184 cuts it.

Sunburst is slightly better than Flare overall. The difference is the top.
Sunburst drew a white tank top with thin straps, which is close to the
reference sleeveless top. Flare drew short sleeves, which is a clear miss
against the sleeveless reference. Sunburst also drew a more prominent red
crown patch across the top of the hair, matching the prompt claim C24, and
its extended hand is more blob-like, matching claim C31, while Flare gave
the extended hand distinct fingers. Flare is slightly wider: max figure
width 0.548 for Flare vs 0.533 for Sunburst, target 0.60, so Flare is closer
by 0.015. That width gap is small next to the top difference, which is
visible at a glance. Both are under the 0.60 target.

3-panel comparison (Reference, GPT Image 2.6 Flare, GPT Image 2.6 Sunburst):
comparison-flare-vs-sunburst-frame184.png, SHA 1a21868f, 2400x688 RGB,
788,937 bytes, verified by reading it back. The 2x2 grid was not rebuilt;
it is already complete with all four panels filled. Total new spend for the
frame-184 comparison is now about $1.64 (prior $1.61 plus Sunburst $0.034).
