# Four style Shorts with GPT 6.1 Terra

Date: 2026-11-09.
Study question: can Headless Motion, authored by GPT 6.1 Terra, make four clips that look like the real Shorts?
Local refs: `refs/shorts-2026-11-09/`. YouTube files stay local only. Never redistribute them.

## Terra role, stated plainly

Terra is a text and image in, text out reasoning model. It cannot generate video.
Its job here is to look at reference frames and write scene JSON. The engine renders the frames.
The fix loop feeds rendered frames back to Terra as images. Terra revises the scene JSON.
Terra never watches a render directly. It only sees the frames it is sent.

## Sources

| # | Short | Title | Uploader | Length | Local file |
|---|---|---|---|---|---|
| 1 | Johnny Harris map | Iran vs Iraq: The Forgotten War | Johnny Harris | 170 s | `6bAsMIvcrVw.mp4` |
| 2 | Kurzgesagt | How Radioactive Are Your Teeth? | Kurzgesagt | 134 s | `FPZuklD9eRg.mp4` |
| 3 | Vox collage | How Vox makes images look like videos | Chris Moran | 37 s | `KkckBGX6Yho.mp4` |
| 4 | Vox document | How to Edit Like Vox, Newspaper Animation | StanzMedia | 4.5 s | `_HU37rX4G1U.mp4` |

Notes on the downloads. The default yt-dlp web client hit a YouTube bot check. The android player client worked. Command: `yt-dlp --no-check-certificates --extractor-args "youtube:player_client=android"`.
Shorts 1 and 2 resolve to full length videos, not 60 second Shorts. Only the first 5 seconds were studied.
Frames were extracted at 2 fps for the first 6 seconds: `frames/<id>/f01.png` to `f12.png`. Frame f01 is 0.0 s, f03 is 1.0 s, f05 is 2.0 s, f07 is 3.0 s, f09 is 4.0 s, f11 is 5.0 s.
Frames viewed for this study: f01, f03, f05, f07, f09, f11 for shorts 1, 2, 3; f01, f03, f05, f07, f09 for short 4.

## Cross cutting findings

These apply to all four clips. They come from reading the engine source, not from guessing.

- The canvas is fixed at 1920x1080 landscape. `src/scene/scene.schema.json` sets width to the constant 1920 and height to the constant 1080. Every profile in `src/scene/profiles.json` outputs 1920x1080 except previs at 854x480. No vertical profile exists. A true 1080x1920 Short cannot render today. The options are a new vertical profile, which is schema and pipeline work, or a landscape master cropped to a 607 px wide vertical slice, which throws away the sides. This is the largest cross cutting gap.
- Image nodes exist and work. A node of type `image` takes a local `src` and a fit of cover, contain, or none. `src/renderer/compile.mjs` embeds the file as a data URI and renders an `<img>` tag. Photos, paper texture, and newspaper clippings can all ride on image nodes.
- Image nodes take no blur. The `soft` blur and `glow` filters live on shape nodes only. `src/renderer/runtime.mjs` updates the filter inside a shape SVG. An image node has no filter element. A focus pull on a photo needs two copies of the asset, one sharp and one pre blurred, crossfaded by opacity.
- There is no clip and no mask. No `clipPath` or mask appears in the schema or in `compile.mjs`. A straight split screen still works through box cropping: two boxes side by side, each with `object-fit: cover`. A curved or feathered reveal does not work.
- Text has no outline. No text stroke, text shadow, or paint order exists in the renderer or the text module. The word captions in all four refs use white text with a black outline. The workaround is a stack of offset black copies behind the white text. A first class outline is missing.
- Kinetic text is native. `src/text/text.schema.json` allows split char, word, or line, a stagger in frames, a start frame, a duration, an ease, and a from state of opacity, scale, and y. Mode `stamp` exists. Word by word captions need no new code.
- Grain lives in the map module only. `src/map/runtime.mjs` draws a seeded 256x256 noise tile and a radial vignette, dark register only, static and deterministic. The general renderer has no grain pass. The kit capability map says texture is a later track. The map clips get grain for free. The other three clips do not.
- The map module has no relief terrain. `src/map/runtime.mjs` and `src/map/tokens.json` hold flat fills, focus dim, vignette, and grain. No hillshade or shaded relief exists. The parchment relief look in short 1 is not available.
- The map module covers camera, flood, badges, labels, and routes. `src/map/map.schema.json` defines cameraMove with center, zoom, bearing, pitch, travel, ease, and followRoute; focusEvent with subject, flood, and point; badges in disc or hex mode with a label; labels in pill, curved, or leader mode; and routes with a draw value. The map flight showcase already used zoom, flood, badge, and labels.
- The path and ledger kit is proven. The kit lives at `~/workspace/handover-headless-motion-paths/kit/`. It covers points lists, `hme path` edit commands, morph with a topology guard, squash with scaleX and scaleY about an anchor plus vertex deform, `hme ledger build` and `hme ledger diff`, and `hme contour` with a nearest node report. The judge verdict for run stage2-paths-2026-11-09-01 is PASS. The blind drawer proof landed 0.04 px against a 2 px bar.
- Fonts on disk are thin. The repo holds Anton Regular, Montserrat Bold, and Liberation Sans Bold. No serif face exists for the Vox wordmark. No hand drawn face exists. Fonts must be local files. New fonts need sourcing and a license check.

## Short 1: Johnny Harris map

Source: `frames/6bAsMIvcrVw/`.

### First 5 seconds beat list

- 0.0 s, f01: wide map of the Middle East. Parchment relief terrain. Title card in a white rounded box: "IRAN VS IRAQ / THE FORGOTTEN WAR" in bold condensed black type. Iraq is flat tan. Iran is flat green. Two small round flag badges sit on the countries. Bottom caption reads "One of the most important wars of the last 50 years". Yellow blurred map bleed fills the top and bottom bars.
- 0 to 3 s, f01 to f07: one slow continuous zoom in. The camera never cuts. The flag badges grow from small circles to larger hexagonal shields with IRAQ and IRAN labels under the flags. Terrain detail grows as the zoom deepens.
- 3.0 s, f07: the caption changes to "is one that we don't hear about much when, in 1980, two of the Middle East's". Captions change word by word through the whole shot.
- 3.5 to 4.0 s, between f07 and f09: a fast punch in, or a cut, to a close view of Basra. A brown bar label reads "BASRA". Small flag markers and dots mark positions. A partial label "ES" sits cut off at the left edge.
- 4 to 5 s, f09 to f11: a slow drift holds on the Basra view. Markers stay in place.

### Style DNA

- A textured paper map with shaded relief, not a flat vector map.
- Flat country fills in muted tan and green over the relief.
- Flag badges that grow as the camera closes in.
- A bold condensed title in a white card.
- Word by word captions at the bottom, white with a black outline.
- One slow zoom, then a punch in. No fast cutting in the first 5 seconds.
- Blurred map bleed fills the vertical bars.

### Engine mapping

Can already do:

- Slow zoom and punch in: map cameraMove with center, zoom, and ease. The map flight showcase proved this.
- Country flood: map focusEvent with subject and flood. Iraq tan and Iran green are flood fills.
- Flag badges: map badges in disc or hex mode with labels. The badge scales with the zoom.
- Place label: map labels in pill mode. BASRA is a pill label.
- Position markers: small shape nodes or map badges, placed by lon and lat.
- Word captions: kinetic text with split word and a stagger.
- Vignette and grain: the map runtime adds both in the dark register.
- Title card: a text node with a rect ground behind it.

Needs the new path and ledger tools:

- Ledger: `hme ledger build` from the scene gives the badge and label centres per frame in px and ratios. It checks the zoom path lands where the reference lands. `hme ledger diff` compares against a measured ledger from the reference frames.
- Contour: `hme contour --at-s 5` names the nearest node when the Basra outline sits off the reference.

Still missing:

- Relief terrain. The map module draws flat fills only. No hillshade exists. A paper texture image node at low opacity over the map can suggest parchment, but it cannot fake true shaded relief.
- Vertical canvas. See the cross cutting findings.
- Text outline. The captions need the offset copy workaround.
- The flag art inside badges. Badges take a label, not a flag image. A flag needs a small image node or a traced shape pinned to the badge.

Verdict: possible with new tools. The motion is the engine home turf. The look is partial. Relief terrain is the named gap that stops it looking like the real thing.

## Short 2: Kurzgesagt character

Source: `frames/FPZuklD9eRg/`.

### First 5 seconds beat list

- 0.0 s, f01: tight shot on a drawn girl in a dentist chair, seen from the front. Two big dental lamps crop at the top. Flat vector style, muted browns, sage green, cream. Subtle grain over the background. Caption reads "How".
- 0 to 1 s, f01 to f03: a slow pull back. The lamps come fully into frame. Crossed arms enter at the bottom. Caption reads "radioactive".
- 2.0 s, f05: the mouth opens wide. Two big white teeth show. Caption reads "teeth?".
- 3.0 s, f07: a big open smile. The eyes change from round dots to happy arcs. Caption reads "In the 1950s,".
- 4.0 s, f09: the same pose holds. The eyes sit slightly different. Caption reads "American".
- 5.0 s, f11: the same pose holds. Caption reads "collecting".

### Style DNA

- One fully drawn vector character fills the frame. No photo, no map.
- Flat fills, thick clean outlines, muted earthy palette.
- Grain over everything, like paper.
- The face does the acting. Mouth shape and eye shape change. The head barely moves.
- The camera moves once, a slow pull back in the first second, then locks.
- Word by word captions at the bottom.

### Engine mapping

Can already do:

- Slow pull back: a scale track on the character parent, or a camera zoom.
- Word captions: kinetic text with split word and a stagger.
- Flat fills and outlines: shape nodes with fill and stroke.
- Squash and stretch: transform scaleX and scaleY about an anchor, plus deform on a named subset of points. Both are in the schema now.

Needs the new path and ledger tools:

- Points morph: the mouth and the eyes are points lists. A morph track interpolates the mouth from a closed smile to an open smile, and the eyes from round to arcs. Both keyframes must share node count and command sequence, or the topology guard fails loudly.
- `hme path` edits: when the smile sits wrong, `hme path move` shifts one named node and writes a versioned scene.
- Ledger: `hme ledger build` gives the mouth and eye centres per frame. It checks the face stays framed through the pull back.

Still missing:

- The drawn character itself. This is the hard part. Terra must author the girl as points data by writing coordinates. Nothing in the engine draws a character for it. The trace import path copies a silhouette as one opaque `d` string with no node identity, so a traced girl cannot blink or open her mouth per part. The rig module names parts and keyframes joints, but the face still needs points data.
- Grain outside the map module. The Kurzgesagt grain is part of the look. The general renderer has no grain pass.
- Soft blinks and squash on the face need careful morph topology. A mouth that opens needs the same node count in both shapes. Terra must plan that.

Verdict: possible with new tools, and the hardest of the four. The morph, squash, and caption tools are ready. The character drawing is the risk. A bad face will read as generic at once.

## Short 3: Vox collage

Source: `frames/KkckBGX6Yho/`.

### First 5 seconds beat list

- 0.0 s, f01: a still photo of a red cable car over mountains. The photo is cut into depth layers: foreground rocks, the car, background mountains, sky.
- 1.0 s, f03: a title overlay appears. "Look at this" in small serif, "Vox" in a huge serif wordmark, "Animation" in a red label, and a hand drawn curved arrow. The car has glided a little down the cable.
- 2.0 s, f05: the title is gone. Caption reads "SEE IT?" in a black pill. The car keeps gliding. The layers move at different rates.
- 3.0 s, f07: caption reads "FEELS ALMOST". The car has moved further down the cable.
- 4.0 s, f09: caption reads "LIKE A VIDEO.".
- 5.0 s, f11: a vertical split wipe appears. The left half shows the flat still photo. The right half shows the parallax version. Caption reads "THE EFFECT,".

### Style DNA

- A real photo, cut into depth layers, moved at different rates. That is the whole trick.
- Slow differential movement. Nothing moves fast. The car glides. The background drifts slower. The foreground rocks sit still.
- A big serif Vox wordmark, a red label, and a hand drawn arrow.
- Black pill captions, one phrase at a time.
- A before and after split screen to prove the effect.

### Engine mapping

Can already do:

- Photo layers: image nodes with fit cover. One node per depth layer.
- Parallax: separate transform tracks per layer, each with its own speed. The car moves fastest, the mountains slower, the rocks not at all.
- Title and red label: text nodes with a rect ground.
- Hand drawn arrow: a path shape with stroke.
- Black pill captions: text nodes with a rect ground, or kinetic text.
- Split screen: two boxes side by side with object fit cover. No mask is needed for a straight vertical edge.

Needs the new path and ledger tools:

- Ledger: `hme ledger build` gives each layer centre per frame. It checks the parallax rates stay different and steady. `hme ledger diff` compares against the measured reference.
- Path edits: the arrow shape can be tuned with `hme path move` when the curve sits wrong.

Still missing:

- The cut photo layers. Cutting a photo into foreground, car, background, and sky is authoring work outside the engine. The engine displays layers. It does not cut them. Terra can specify the cuts. A human or an image tool must make the PNGs.
- A serif font for the Vox wordmark. No serif face is on disk.
- Clean layer edges. A rough cut shows a halo at the layer edge. The engine cannot feather a cut edge on an image node. The cut must be clean at the source.

Verdict: possible with new tools. The engine motion is simple. The cutout pipeline is the work. The split screen proves the effect in one frame, which helps the showcase.

## Short 4: Vox document highlighting

Source: `frames/_HU37rX4G1U/`.

### First 5 seconds beat list

- 0.0 s, f01: two blank paper panels on a dark textured background. Top label reads "MY EDIT". Bottom label reads "ORIGINAL". Blue borders frame each panel. "STANZMEDIA" sits at the bottom. The panels hold paper texture only.
- 1.0 s, f03: headlines appear. The top panel reads "'I took a Bullet for Democracy,' Trump says at First Rally Since Sho..." with a yellow highlighter sweep across the first line. A red date tag sits above it. A cutout photo of Trump sits at the bottom right. The bottom panel reads "Elon Musk Completes $44 Billion Deal to Own T..." with its own red date tag and a Musk photo.
- 2.0 s, f05: the top panel is sharp. The highlight extends to the sub headline. The bottom panel is blurred out of focus.
- 3.0 s, f07: both panels are sharp. Full headlines and sub headlines show. Yellow highlights sit on the headline lines in both panels. Red hand drawn arrows point at the photos.
- 4.0 to 4.5 s, f09: settled. Both panels complete.

### Style DNA

- Newspaper clippings on a dark background. Paper texture is the ground.
- A yellow highlighter that sweeps left to right across the headline.
- Red hand drawn arrows as annotation.
- A focus pull: one panel blurs while the other stays sharp.
- A split screen comparison, top versus bottom, not left versus right.
- Serif headline type, small red date tags.

### Engine mapping

Can already do:

- Paper panels: image nodes for the clipping scans, or rect nodes with a paper texture image behind.
- Highlight sweep: a yellow rect with opacity near 0.55, placed over the headline, with its width keyframed from 0 to full. No mask is needed for a straight sweep.
- Headline text: text nodes in a serif face, or part of the clipping image. A text node lets the sweep sit behind the glyphs. An image keeps the real headline.
- Red arrows: path shapes with stroke.
- Split screen: two stacked boxes, one per panel.
- Focus pull: two copies of the bottom panel asset, one sharp and one pre blurred, crossfaded by opacity. The engine cannot blur an image node, so the blur must be baked into the asset.
- Labels and watermark: text nodes.

Needs the new path and ledger tools:

- Ledger: `hme ledger build` gives the highlight rect edge per frame. It checks the sweep speed matches the reference. `hme ledger diff` compares the highlight edge against the measured reference.
- Path edits: the arrows can be tuned with `hme path move`.

Still missing:

- A true draw on for the arrows. No stroke dash animation exists. A points morph from a short arrow to a full arrow, with the same topology, can fake it.
- A serif font. No serif face is on disk.
- Text outline is not needed here. The captions are plain.

Verdict: strong fit. This is the easiest of the four. Every beat has a native engine piece or a small workaround. The focus pull needs a pre blurred asset, which is cheap authoring.

## Terra access check

- Model id `openai/gpt-6.1-terra` resolves on the OpenRouter models list. Context length is 1,050,000. Pricing is $1 per 1M input tokens and $5 per 1M output tokens. Modality is text plus image plus file in, text out. The list was fetched through the stored `custom.openrouter` connector with a script at `/tmp/models_check.py`. The stock `or_api.py` truncates bodies at 2000 chars, so the full list needed a direct fetch through the same credential helper.
- `openai/gpt-6.1-terra-pro` also exists at the same $1 and $5 rates.
- Note the pricing override: prompts of 272,000 tokens or more cost $2 per 1M input and $7.50 per 1M output. Long image heavy prompts can cross that line.
- Probe: one short text prompt through `or_chat.py` with `--model openai/gpt-6.1-terra --max-tokens 30` returned "Terra probe OK". Cost was under $0.001.
- The earlier single model lookup `GET /api/v1/models/openai/gpt-6.1-terra` returned 404. The models list is the correct check. The full id with the `openai/` prefix is the id to use in chat calls.

## Cost estimate

Rates: $1 per 1M input tokens, $5 per 1M output tokens. Reasoning tokens bill as output tokens.

Per clip, per round, the working guess is:

- Input 30k to 60k tokens. The schema is about 4k tokens. The kit docs add a few thousand. Twelve reference frames at 360x640 add roughly 12k to 20k tokens. The scene JSON from the last round adds the rest.
- Output 20k to 50k tokens. A 5 second scene is roughly 8k to 20k tokens of JSON. Reasoning tokens sit on top, and they are the swing factor. A reasoning heavy model can spend several times the visible output on reasoning.
- That gives $0.15 to $0.30 per round at the low end and $0.30 to $0.60 per round at the high end.

Per clip, with one authoring round and 2 to 3 fix rounds, the range is $0.50 to $1.50.
Four clips together: $2 to $6.
This is a range, not a precise number. The first clip will calibrate it. If the first clip lands near the top of the range, the four clip total lands near $6. If Terra needs fewer fix rounds, the total lands near $2.
The 272k prompt override would double input cost on very long prompts. It should not trigger at 360p frames, but it is a real edge if full resolution frames and long histories stack up.

## Recommended build order

1. Short 4, Vox document, first. Strongest fit. Every beat maps to a native piece or a cheap workaround. It proves the Terra loop at the lowest cost and risk. A win here also proves the highlight sweep and the split screen, which recur in short 3.
2. Short 1, Johnny Harris map, second. The motion is the engine home turf. It proves the map module at Short scale and the ledger check on a real zoom. Relief terrain stays a known gap, so the goal is the closest honest version, not a perfect match.
3. Short 3, Vox collage, third. It needs the cutout pipeline first. Do it after the loop is proven, because the cost sits in the photo cutting, not in the engine.
4. Short 2, Kurzgesagt character, last. The character drawing is the hardest step. Do it after the loop, the map, and the collage are all proven. If the face fails, the other three clips still stand as the showcase.

Cross cutting work before clip 1: decide the vertical question. Either land a vertical profile or accept a landscape master with a centre crop. Every clip inherits that choice.
