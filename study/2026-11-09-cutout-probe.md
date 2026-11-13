# Cutout probe report

Date: 2026-11-10, 00:01 EST. Question: is there a proven method to cut a photo out (person isolated, transparent background) for the Vox document clip?
Verdict: PROVEN. Both staged photos cut clean, viewed on paper and on grey.

## Method

- Tool: rembg 2.0.87 with onnxruntime 1.31.1, in a venv at ~/workspace/tmp-work/venv-cutout.
- Install: system pip is blocked by PEP 668, so a venv was used. `pip install rembg onnxruntime` worked through the proxy.
- Models: u2net (general) and u2net_human_seg (people). Cached in ~/.rembg/models/ after first use. Note: rembg downloads to ~/.rembg/models/, not ~/.u2net. A manual curl of u2net.onnx to ~/.u2net was not used by rembg.
- Recipe that works: downscale the input to max 768 px on the long side, OMP_NUM_THREADS=2, CPU provider, one photo at a time. Then grayscale the RGB channels and keep the alpha.
- Recipe that fails: full-resolution input (1200x800) OOM-killed the process (exit 137) on this 6 GB box. Downscale is required, not optional.
- The first long run (13 minutes, no output) was the model download through rembg's own downloader, which starts slow. The models are cached now, so later runs take seconds.

## Results, viewed

- Trump photo, u2net: clean. Opaque fraction 0.273, semi-transparent fraction 0.018. Edges tight around hair, fist, suit. No halo on a grey background. File: trump-gray.png (768x512 RGBA).
- Musk photo, u2net: FAILED. Opaque 0.635, semi-transparent 0.199. The dark suit against the dark background did not separate. The jacket renders as a grey wash.
- Musk photo, u2net_human_seg: clean. Opaque 0.640, semi-transparent 0.029. Suit solid dark, lapels crisp, hair edges clean. One small light smear at the bottom-left hem, invisible at the clip's display size (about 94 px wide). File: musk-hs-gray.png (622x768 RGBA).

## Rule that follows

- Use u2net for clean-background photos. Use u2net_human_seg for people, especially against dark or busy backgrounds.
- Always downscale to 768 px max before running. Always view the cutout on paper and on grey before calling it done.
- Check: semi-transparent fraction under 0.05 and a viewed edge with no wash.

## What this unblocks

- The cutout gap from the tool-gaps ladder is no longer a hard blocker at the asset level. The engine still has no mask or clipPath in the schema, but a pre-cut transparent PNG already displays in an image node, so the clip does not need engine-side masking.
- The remaining build is to turn this probe into a repeatable tool in the engine repo (a cutout command plus a matte check), so the next photo goes through the same path instead of a one-off probe. That is the first Handover run in the missing-tools program.
