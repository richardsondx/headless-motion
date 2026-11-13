# Look test

One 10 second shot that proves the rig and the look before a full
video is built. One plate, one rigged character, text entered on
the board, a tag, a character who talks and points. Nothing else.

## Run it

```sh
node tools/look-test/build-look-test.mjs --render
python3 tools/look-test/check-look-test.py
```

The build writes to `out/look-test/`: the IK rig, the keyframes,
the expanded scene, the render and `look-test-report.json`. The
fixtures in `tests/fixtures/look-test-scene.json` and
`tests/fixtures/look-test-rig.json` are never edited in place.

## What the shot holds

- Plate: a flat room, wall, floor at y=860, a white board.
- Host: head, eyes, mouth, body, one single-node left arm, one
  two-node right arm (upper arm + forearm, so the IK elbow bend
  has somewhere to go). Feet sit on the floor line.
- Text: the board title enters char by char from f12. A second
  line fades in at f36. The tag pops in at f48.
- Talk: f72 to f168, the face bobs as one piece and the mouth
  opens and closes every 6 frames.
- Point: the right arm points at f120, using the named `point`
  pose from `src/rig/arm-poses.mjs`, solved by
  `src/rig/ik.mjs`. Blend down to point is 12 frames (0.5 s).

## Bars

Build report (`look-test-report.json`):

- IK reached, forearm rotation at f120 equals shoulder + elbow.
- Expanded scene passes `hme validate`.
- Text never overlaps the face: 0 px overlap for the title, the
  second line and the tag label against the head box.
- Feet on the floor: body bottom y = 860.
- Tag on screen, inside 1920x1080.
- Something new at least every 48 frames (2 s) from the events.

Pixel check (`check-look-test.py`):

- 240 frames, 24 fps, 10.0 s, 16:9 at previs size (854x480) or
  better. Regions are scaled from 1920x1080 scene px.
- No black plate edges: corner patches over 5 luma at 0, 2, 4, 6, 8 s.
- Host skin and shirt present at 5 s, board text present at 5 s,
  tag present at 5 s.

## Human gate

The numbers do not replace watching. Watch the render at full
speed and at 0.25x. If the point reads as a wave, the talk reads
as chewing, or the face bob reads as a shake, the look test fails
even when every number passes. Record the verdict in the report
file's `human_gate` field; do not edit the report to claim it.

## Known limits of this test

- The left arm is one node, so it cannot bend at the elbow. Only
  the right arm proves two-bone IK.
- The face bobs as one piece because the nodes have no shared
  parent. A head rotation alone would leave the eyes behind; that
  is a real rig gap, not a look-test bug. A parented head group
  would fix it.
- No voice, no music, no sound events. The look test is silent.
  Voice and sound checks are a separate build.
- At rest the right forearm peeks as a small skin tab at the
  body's right edge (f1s still, Nov 10, 2026). The arm hangs
  inside the body box at rest, so only its end shows. It reads
  as a stray mark at small size. Fix when arms get a proper
  side profile: hang the arms outside the body box at rest.
