# Pixel to Vector: How the Converters Work, and What They Can Fix for Us

Date: 2026-11-08. Research only. No building, no spending.
Question: how do pixel-to-vector converters work, and can their approach fix our clone problems in the Headless Motion engine?

## Short answer

A converter does three things. It splits the image into flat colour regions. It walks the edge of each region. It replaces the jagged pixel steps with smooth curves. That is the whole trick.

For our rifle icon, do not trace it. Cut it out as pixels. The rifle is a shaded object with soft edges from video compression, and tracing would invent smooth edges that were never there while throwing away the shading that makes it read as a rifle. The engine already has an image node, so the pixel route needs no new engine code.

Tracing earns its place elsewhere: flat, clean, few-colour shapes from a clean source. A simple logo or pictogram, a silhouette used as a mask, a flat infographic element. It never fixes motion, and it never beats real vector data or a real font.

## How the converters work

### Potrace (Peter Selinger, 2003)

Potrace takes a black-and-white bitmap and returns smooth outlines. It is the engine inside Inkscape's Trace Bitmap. Its paper is "Potrace: a polygon-based tracing algorithm" (2003).

Step 1, path decomposition. Potrace works on the dual grid: vertices sit at pixel corners, not pixel centres. A vertex exists where four neighbouring pixels are not all the same colour. An edge joins two vertices when it separates a black pixel from a white pixel. The first outline is therefore a stair-step path that runs exactly between pixels. Small closed paths under `turdsize` (default 2 pixels) are thrown away as dust.

Step 2, optimal polygon. This is the step that makes Potrace special. It does not just find corners and split there. It searches, with dynamic programming, for the polygon with the fewest segments that still fits the path within half a pixel, and among those it picks the one with the lowest fitting error. It precomputes running sums so the fit of any stretch can be tested fast. Then it nudges each vertex to the best spot inside a half-pixel box.

Step 3, corner detection and curve fitting. For each polygon vertex it computes an alpha value from the angle. Against `alphamax` (default 1.0) it decides: sharp corner or smooth curve. Smooth runs become Bezier curve segments. An optional fourth step joins neighbouring Bezier segments into longer ones.

Key facts. Potrace is binary only: one colour at a time. For colour work you split the image into one mask per colour, trace each mask, and stack the results. Its worst-case cost is quadratic in the number of path points, which is why it is slow on very noisy images. Licence: GPL-2.0.

### VTracer (VisionCortex, Rust)

VTracer handles colour directly and skips Potrace's expensive optimal-polygon search. It runs in linear time in the number of pixels, which is why it is fast on large images.

Step 1, colour clustering. Similar pixels are grouped into a small number of colour regions. Version 1.0 adds a watershed mode, which forms regions by flooding from low points on an edge-aware map, for sharper edges.

Step 2, contour extraction. Each region's boundary is walked to give an outline, the same idea as Potrace's step 1 but per colour region.

Step 3, curve fitting. The stair-step outline is fitted with Bezier splines (spline mode), straight polygons (polygon mode), or left as pixel steps (pixel mode). Two layout modes matter. Stacked mode layers colours from largest to smallest, so no hairline gaps appear between neighbours. Cutout mode subtracts overlaps so regions fit like puzzle pieces; version 1.0 makes this a true gapless mosaic with shared borders.

Key facts. VTracer was built for high-resolution scans of historic blueprints, up to gigapixel size. It also handles low-resolution pixel art. Licence: MIT. Version 1.0 is still alpha on PyPI (1.0.0a4); the last stable command-line release is 0.6.4.

### Autotrace (Martin Weber)

Autotrace is the oldest of the three and the only one with a true centreline mode.

Step 1, colour reduction and despeckling. The image is reduced to a set number of colours (`-color-count`), and small speckles are removed (`-despeckle-level`).

Step 2, outline or centreline. Normal mode follows the edges of colour regions. Centreline mode (`-centerline`) thins shapes to a one-pixel skeleton first, then traces the middle of the line. This is for line drawings, handwriting, and technical drawings, where the line itself is the shape.

Step 3, spline fitting. Outlines are fitted with Bezier splines by least squares (`fitted_splines`), with `error_threshold` controlling how tightly the curve must follow the pixels and `corner_threshold` deciding corners.

Step 4, output. Autotrace writes many formats: SVG, EPS, AI, DXF, PDF, and more.

Key facts. Licence: GPL v2 (input and output code also under LGPL 2.1). The project is older and less active than VTracer. Use it when you need centreline tracing; for everything else VTracer or Potrace is the better pick today.

### Adobe Image Trace (Illustrator, proprietary)

Image Trace is a closed product, not an open algorithm. Adobe publishes no paper for it. What is known from its panel and docs:

Step 1, palette selection. The image is reduced to a palette: Automatic, Limited, Full Tone, or a document colour group. This is the same colour-reduction step VTracer does, but behind presets.

Step 2, tracing. Each colour region becomes paths. Three sliders control the result: Paths (more detail, more nodes), Corners (keep sharp corners or round them), Noise (ignore small speckles). Method Abutting makes regions share edges; Overlapping lets them overlap.

Step 3, expand and simplify. The live trace becomes editable paths, and Object, Path, Simplify cuts the node count.

Key facts. It needs a paid Illustrator subscription. There is no command-line version and no scriptable use. For our headless agent workflow it is a reference point only, not a tool we can run.

## Open-source tools: install and exact commands

### VTracer (recommended first)

Licence: MIT. Install the Python package (pin the version, 1.0 is alpha):

```
pip install vtracer==1.0.0a4
```

Python use:

```python
import vtracer
vtracer.convert_image_to_svg_py("rifle.png", "rifle.svg",
    colormode="binary", mode="spline",
    filter_speckle=4, color_precision=6, layer_difference=16,
    corner_threshold=60, length_threshold=4,
    max_iterations=10, splice_threshold=45, path_precision=3)
```

Command-line use (install with `cargo install vtracer-cli`):

```
vtracer input.png output.svg
vtracer --input logo.png --output logo.svg --preset bw
```

Parameters that matter most. `colormode`: `color` for multi-colour, `binary` for one-colour silhouettes. `mode`: `stacked` (no seam gaps) or `cutout` (puzzle-fit regions). `filter_speckle`: drops small specks; raise it on noisy input. `color_precision` and `layer_difference`: how finely colours are split; lower values merge more. `corner_threshold`: below it a bend becomes a curve, above it a corner. `length_threshold`: drops paths shorter than this. `path_precision`: decimal places in the output.

Note: the 0.6.x Python call takes positional arguments in some builds; check the installed version's signature before scripting it.

### Potrace (best for one-colour shapes)

Licence: GPL-2.0. Install on Debian/Ubuntu with `apt install potrace`, on macOS with `brew install potrace`. Potrace reads PBM, PGM, PPM, or BMP only, so convert the PNG first:

```
magick input.png -colorspace Gray -threshold 50% input.pbm
potrace input.pbm -s -o output.svg --turdsize 5 --alphamax 1.0 --opttolerance 0.2
```

Or in one pipe with Netpbm:

```
pngtopnm -mix input.png | potrace --svg -o output.svg
```

Parameters that matter most. `--turdsize` (default 2): ignore specks smaller than this many pixels; raise it on scans and compressed frames. `--alphamax` (default 1.0): corner threshold; 0 means all corners (polygon output), above 4/3 means all smooth. `--opttolerance` (default 0.2): curve optimisation tolerance; lower keeps more detail and more points, higher simplifies. `-r` sets the output resolution (default 72 dpi); Potrace outputs coordinates at 10x pixel size.

For colour work, the reliable pattern is one mask per colour: build a black-and-white mask for each flat colour, trace each mask with Potrace, then combine the SVGs with the exact fills assigned afterwards. This gives cleaner edges than any colour tracer's auto-split, because you control the threshold per colour.

### Autotrace (use for centreline only)

Licence: GPL v2 (input/output code LGPL 2.1). Install on Debian/Ubuntu with `apt install autotrace`, or build from https://github.com/autotrace/autotrace.

```
autotrace -color-count 2 -background-color FFFFFF -output-format svg -output-file out.svg in.png
autotrace -centerline -output-format svg -output-file lines.svg drawing.png
```

Parameters that matter most. `-color-count` (1-256): colours to reduce to; 0 means no reduction. `-despeckle-level` and `-despeckle-tightness`: noise removal. `-centerline`: trace the middle of strokes instead of their outline. `-error-threshold` and `-corner-threshold`: fit tightness and corner detection.

### Adobe Image Trace

Not usable from a script. Illustrator only, paid subscription, no command line. Keep it as a quality reference, not a step in our pipeline.

## Recommendations for our problems

### (a) The rifle icon: cut it out as pixels, do not trace it

Measured from the real 7-second frame (`verify-seg4/evidence/work/real-7s.png`, badge box x 613-773, y 649-815):

- The rifle is 2,660 pixels inside a 149 by 111 px box, nearly the full width of the 160 by 166 px badge.
- It is not a flat shape. It holds 551 distinct colours (counted in steps of 8), from near-black [38, 2, 0] to near-white highlights [255, 236, 229]. Median colour is a dark brown-grey [117, 57, 48].
- Its edge is soft. Pixels at an in-between distance from the badge orange (the anti-aliased and compression-blurred band) number 3,176, more than the 2,660 solid rifle pixels. The boundary is a fuzzy band 3 to 4 px wide, not a line.
- The badge orange itself is flat (colour spread about 3), but the badge as a whole holds 1,005 distinct colours because of the rifle, the text, and edge gradients.

What tracing would lose. The shading first: a trace reduces 551 colours to one or two flat fills, so the rifle loses the highlights and shading that make it read as a rifle. The edge second: any tracer must pick one threshold through a 3 to 4 px fuzzy band, so the outline wobbles by about 2 px and small parts (trigger, magazine edge, barrel tip) merge or vanish. The result would be a smooth blob that looks less like the real rifle than the pixels do.

What the pixel cutout loses. Resolution independence: a cutout cannot scale up cleanly past about 1.5 to 2x without going soft. But the badge is shown at 130 to 160 px, the same size as the source, so nothing is lost at display size. The cutout keeps the compression noise baked in, but so does the trace input; the trace only hides the noise by inventing smooth edges.

Recommendation: cut out, do not trace. Method: mask pixels far in colour from the badge orange (median [204, 71, 39]), take the largest connected shape, leave out the bottom text zone where the RSF letters sit, and save it as a transparent PNG with the real rifle colours kept. Then place it with the engine's existing image node (`imageProps` with `src` and `fit`, already in the scene schema and rendered by the runtime), using the same position and scale keyframes as the badge shape node so it moves and grows with the badge. No new engine code is needed for this route.

Trace the rifle only if it is ever shown much larger than the source, for example in a close-up. Then expect to clean the trace by hand: the auto trace will need its wobbles fixed and its shading rebuilt.

### (b) The map country shapes: do not trace them

We already draw countries from Natural Earth GeoJSON, which is real vector data: exact coastlines and borders in longitude and latitude, projected by our own code. Tracing a screenshot of a map would be strictly worse. The trace would inherit compression wobble, lose small islands and thin peninsulas, and carry the screenshot's projection instead of the true one. There is no case where tracing a map frame beats the GeoJSON we already have. The only map shapes worth tracing are simple flat pictograms drawn on top of a map (a pin, a star, an arrow) when they come from a clean still.

### (c) Text labels: never trace them, set them in a real font

Traced letters are a mistake for our labels. A trace turns each letter into a wobbly outline with uneven stem weight and wrong spacing, and it cannot be hinted, so small text looks worse than the same text set in a font. The trace also freezes the letters at one size; the real labels scale with the camera zoom, and a traced outline scales badly at the small end.

The right fix is the font itself. The WhatTheFont run on the same frames (Nov 8, 2026) found the October 2025 title and the SUDAN label both closest to Denostill (SemiBold for the title, Bold for SUDAN), a commercial font that cannot just be downloaded, with Montserrat kept as the free lookalike. EL FASHER got no clear match; it is medium weight and slightly condensed, which means our current guess, Anton (very heavy), is likely wrong, and a medium condensed sans should be tested instead. That is a font-matching problem, not a tracing problem. The sister study on WhatTheFont covers how to identify fonts; tracing is not the fallback for an unknown font. The one exception: a hand-lettered wordmark or logo that exists in no font. Then a pixel cutout beats a trace for the same reasons as the rifle, because the word is shown at one size.

### (d) Where tracing beats redrawing by hand

- A flat, clean, few-colour pictogram or icon from a clean still: a channel logo, a simple symbol, a map pin. Trace the mask to SVG and use it as a shape node. VTracer in binary mode is the tool; Potrace is the fallback.
- A silhouette used as a mask or clip: a flat region traced to a path gives a usable clip shape in one step.
- A flat-colour illustration element: a simple infographic shape, a solid arrow, a badge outline, when the source still is clean and the shape is one or two flat colours.
- Rebuilding a logo from a high-resolution still, when no vector source exists.

And where it does not help: photographs, gradients, shaded objects, small text, and anything with soft edges from video compression. That is most of a video frame, which is why tracing is a targeted tool in our workflow, not a general one.

## Honest limits

- A trace is an interpretation, not a copy. It guesses where a soft edge is and invents smooth curves the original never had. On a compressed screenshot the guess is wrong by 1 to 3 px.
- Tracing fixes shape only. It says nothing about motion. The style-copy tournament already showed the limit: its winning route used VTracer traces plus flow-guided interpolation, and the full copy still failed on Seg3 (mean SSIM 0.7441 against 0.95, PSNR 14.61 against 35). A later probe found that video lagged the reference by exactly 46 frames, so the 0.7441 measures a lagged video, not the tracing method, and the judge's "damped motion" cause was wrong. Even aligned, fresh traces fall short on PSNR (24.54 against 35), so the remaining gap is trace fidelity, not motion.
- A trace is never as clean as the original vector. The original was drawn with exact geometry; a trace is fitted to noisy pixels. Expect to hand-clean any trace that ships.
- Colour tracers invent intermediate colours along anti-aliased edges. VTracer's colour mode can return 50 to 200 in-between shades along one edge. The fix is to split by colour mask first and trace each flat colour separately, or to limit the palette hard before tracing.

## What to build first

1. The rifle cutout as a transparent PNG plus an image node in the v5 scene, using the badge's keyframes. No tracer involved.
2. A small trace helper script for the flat-icon case only: input a cropped mask, output an SVG path, with VTracer binary mode as the default and Potrace as the fallback. Use it for simple pictograms, never for shaded objects or text.
3. Font matching stays separate (see the WhatTheFont study). Do not let tracing become the fallback for an unknown font.

## Sources

- Peter Selinger, "Potrace: a polygon-based tracing algorithm" (2003), paper mirror: https://ftp.yz.yamagata-u.ac.jp/pub/linux/momonga/development/source/SOURCES/potrace.pdf
- Tracing algorithm research notes (Potrace pipeline, stages 1 to 4): https://github.com/cpiprint/img2bez/blob/HEAD/context/tracing-algorithms-research.md
- VTracer on PyPI (install, Python API): https://pypi.org/project/vtracer/
- VTracer crate page, MIT/Apache licence: https://lib.rs/crates/vtracer
- How VTracer works (clustering, contour, curve fitting): https://www.convertsvg.net/blog/understanding-vtracer-engine/
- State-of-the-art vectorization report (VTracer parameters, O(n) vs Potrace O(n^2)): https://github.com/raphaelmansuy/edgesvg/blob/HEAD/research/SOTA_Vectorization_Research_Report.md
- Potrace command line and flags: https://www.imageguide.dev/guides/convert-image-to-vector/ and http://carta.tech/man/potrace/1
- Autotrace README (licence GPL, command options): https://github.com/autotrace/autotrace
- Autotrace glossary (centreline, despeckle, spline fitting): https://deepwiki.com/autotrace/autotrace/10-glossary
- Inkscape Trace Bitmap (Potrace-based, single and multiple scan): https://perfectvector.com/blog/inkscape-trace-bitmap
- Adobe Image Trace panel and presets: https://creativepro.com/image-tracing-in-illustrator/ and https://www.svgvector.com/blog/image-trace-illustrator-guide.html
- Colour-mask-first tracing pattern (one mask per colour, Potrace each): https://github.com/shaharsha/claude-skills/blob/HEAD/skills/brand-assets/reference/vectorize.md
