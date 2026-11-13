# Cutout tool

Cut a photo out to a transparent PNG, in one command.
Proven by the probe in `study/2026-11-09-cutout-probe.md`.

## Command

```sh
tools/cutout INPUT OUTPUT [--person] [--grayscale] [--model MODEL]
```

No manual venv step. The wrapper runs `tools/cutout.py` in the
cutout venv at `~/workspace/tmp-work/venv-cutout`.

## Model choice

- Default is `u2net`. Use it for clean-background photos.
- `--person` or `--model u2net_human_seg` picks the human-seg model.
  Use it for people, above all against dark or busy backgrounds.
- The probe proved the rule. Musk with `u2net` failed, with a
  semi-transparent fraction of 0.199 and the suit as a grey wash.
  Musk with `u2net_human_seg` was clean, at 0.029.
- The tool never downloads a model. It checks the cached file first
  and refuses to run when the file is missing.
- Cached files: `~/.u2net/u2net.onnx` and
  `~/.rembg/models/u2net_human_seg/u2net_human_seg.onnx`.
- Never use the `bria-rmbg` model that also sits in the cache.

## Downscale rule

- The tool downscales the input to 768 px max on the long side
  before inference. This step is required, not optional.
- Full-resolution input killed the probe with out-of-memory, exit 137.
- The tool also checks free memory first and refuses to run below
  1200 MB free. Pass `--min-free-mb N` to change that bar.

## Grayscale option

- `--grayscale` writes grey RGB channels and keeps the alpha band.
- The channel spread is 0, measured, not claimed.
- The engine has no grayscale filter on image nodes, so grey is
  baked into the asset by this flag.

## Matte check

- The command prints a JSON report with the opaque fraction, the
  semi-transparent fraction, and the clear fraction of the alpha band.
- Opaque means alpha 250 or higher. Semi-transparent means alpha
  1 to 249. Clear means alpha 0.
- A clean cut has a semi-transparent fraction under 0.05.
- Always view the cutout on paper and on grey before calling it done.
  A number alone does not prove a clean edge.

## Examples

Trump, clean background, grey:

```sh
tools/cutout photo-trump.jpg photo-trump-gray-cut.png --grayscale
```

Musk, person against a dark background, grey:

```sh
tools/cutout photo-musk.jpg photo-musk-gray-cut.png --person --grayscale
```

## Output

- One RGBA PNG at the downscaled size, 768 px max on the long side.
- The JSON report names the model file used and the output sha256.
