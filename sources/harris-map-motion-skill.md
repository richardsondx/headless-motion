---
name: local-harris-map-motion
description: Design and animate Johnny Harris / Vox-grade maps inside The Atlas Room's hand-inked animated treatment: palette and contrast tokens, typography system, component kit, line hierarchy, the camera law, the focus-dim system, event choreography, and QC gates G8 (contrast) and G9 (focus and camera). Use whenever rendering, restyling, storyboarding, or reviewing any map shot for Richardson's animated channels. Sources: the completed 12-video Harris/Vox map-tutorial corpus study (frame study plus two addenda; 10 of 12 with frames, 2 of them partial) and the Claude motion-design primer, both in ~/workspace/borderline/research/.
---

# Harris Map Motion Design (Atlas Room system)

## Purpose

Maps are the star of The Atlas Room. This skill is the map design system: every token below is either measured from Harris/Vox tutorial frames or computed (contrast), or it is marked as our pipeline's spec. It extends, never replaces, the MAP-QC gates G1 to G7 in `~/workspace/borderline/MAP-QC.md` (geometry truth, registration, centering, clock truth, labels, frame discipline, finish). This skill adds G8 and G9.

Primary sources: `~/workspace/borderline/research/harris-map-tutorials-study.md` (888 frames, 6 of 12 assigned tutorials frame-accessed), its addendum `~/workspace/borderline/research/harris-map-tutorials-study-addendum.md` (3 of the remaining 6: one full, two by transcript), and `~/workspace/borderline/research/harris-map-tutorials-study-addendum-2.md` (the last 3: one full, two by frames in part; the corpus is now closed, see the status note in Production notes), plus `~/workspace/borderline/research/harris-map-primer-claude.md` (Claude-written, Moon-verified; all ratios recomputed by hand after Claude's first pass invented values: never trust an unverified number from a generation pass).

## What Harris actually does (the finding that organizes everything)

His prestige maps are **one real map plus 2 to 3 oversized graphic events**, not data-viz density. His own pipeline (from his Short): archival map scan, Photoshop layer separation, Illustrator pen-traced shapes, After Effects masking/feathering/keyframes, a drone-like camera flyover, timed to voice and music in Premiere. Our translation: real data in code (NE 10m), the same event discipline, the camera as a drone over a master plate.

## Design tokens

### Contrast (the law, computed per render)
- Text against its immediate ground: **at least 7:1**. No naked text on terrain, ever: every label sits on a bar, pill, stroke, or shadow.
- Emphasis line against every land value it crosses: **at least 3:1**; when the land is mid-tone, add a 1.5px dark casing under the line.
- Known failure to design around: our signature red #E63946 on our tan land #C6AD7A measures **1.92:1**. The thesis line needs its casing (dark ink underlay) or a deeper red on tan grounds; on paper #F4F1EA it measures 3.7:1 and passes with the glow.
- Flood pairs must differ in luminance by at least 0.08 so the comparison survives colorblind viewing. Identification never rests on color alone: floods pair with labels, badges, or patterns.

### Palette discipline
- On screen at once: **base 2 values + at most 3 flat floods + 1 accent**. Anything more is noise.
- Floods are flat, hue-distinct color events, not value whispers. Candidate set (verify per render under G8): coral #E4572E, dusty blue #4E7FA6, mustard #D9A441 (deepen toward #B07C1F when it must clear 3:1 on light grounds), mauve #9B6B9E, sage #7FA05A.
- Dark-register subject treatment (Search Party evidence, addendum item 6): instead of a hue flood, the single subject may be lifted in translucent white (about half transparent) with a slightly thicker border and a soft glow confined to the subject layer. The value lift is for the subject only; comparisons between actors still use floods.
- Dark-register reference neighborhood, sampled from the Harris original ("Why the US Sells Weapons to 103 Countries") as re-encoded inside the 5LunYXCZDFM tutorial at 0:03: land about #205044, water about #1B2121. A single-frame sample from a re-encode: treat as a neighborhood (very dark, low land/water separation, the read carried by arcs, dots and the white lift), not as Harris's source hexes.
- Brand locks unchanged (BRAND.md): navy #14213D, paper #F4F1EA, signal red #E63946, brass, teal. Thumbnail-only cyan/yellow never enter in-video maps.

### Typography
- **Geography labels: Montserrat Bold** (named in the tutorial corpus; Quantico Bold corroborated). Country labels 30 to 38px caps at 1280x720, +6% letterspacing.
- **Anton is display-only**: verdict stamps, number slams, thumbnail type. Never for geography labels, never under 40px.
- Labels are **map citizens**: placed inside or curved along their polygon, projected through the camera transform with the geography. Screen-space sticker labels are banned (they are what made earlier frames feel pasted on).
- Badge micro-labels: white bold condensed text on a dark navy #14213D bar under the badge (8px vertical / 4px horizontal padding class, 6px gap), never text inside the disc competing with the number. The badge itself may be a disc or a **hexagonal clip** (Harris's current portrait-badge form, addendum 2: portrait or flag inside a thin dark outline, the name bar under it as above).

### Line hierarchy
- Base borders: 1 to 1.5px, quiet ink.
- Subject border: 4 to 5px accent with glow (and casing per the contrast law).
- Routes: 3.5px, tapered 100% to 40% along their length, with a traveling dot at the draw head.
- Label leader (Search Party component): a dashed line from the geography dot to the name pill. The dot is bound to the geography point; the pill may sit outside a territory too small to hold it. Distinct from the badge micro-label bar, which belongs to badges.
- The component kit must include: scale band, route taper + traveling dot, dot fields for quantities. Missing kit is a spec gap, not a style choice. Also in the kit: the **circular inset**, in both forms seen in the Harris piece excerpted in addendum 2: a circular inset of magnified map detail sitting on the map, and a circular video window with a thick dark ring overlapping the map's edge.

## Motion: the camera law and the focus system

### Camera law
- Every camera move is **travel, land, hold**: an eased travel, a landing on the subject, then a read-rest hold of at least **1.2s** after any label lands.
- The camera **arrives 0.2s before** the event it frames. It never arrives with or after the event.
- When a line or route draws, **the camera rides the draw head** for the draw's exact duration.
- One continuous easing curve per move (the v2.1 master-plate method: one plate, one float-box camera, no plate stitching, no integer offsets). Drift for its own sake is banned: if nothing is happening, the camera holds.

### Focus system (this is the "boring map" fix)
- When an event fires, **non-subject land desaturates 25% and drops 12% in value**. Exactly one focus at a time.
- The dark register also carries a **constant slight edge blur** (a depth-of-field vignette: Gaussian blur masked to the frame edges), always on. It is a register constant, not an event state; the event dim still applies on top of it. (Addendum item 8: present in the Harris Search Party original and prescribed independently by two tutorials.)
- Event order is fixed: **base, then flood or stroke, then badge, then label**, staggered 0.15 to 0.3s apart. The narration's current subject is the only thing at full strength.
- Grain and hillshade are part of the world, not the focus: they stay constant so the dim reads as attention, not as a filter change.

### Choreography and rest
- After a badge or label lands, hold for reading (see the 1.2s floor) before the next event; density comes from events per beat, never from stacking simultaneous motion.
- Arc endpoints (addendum item 5): in radial fans, the endpoint dot **lands slightly before the line completes**, an anticipation beat observed in the Harris Search Party original; the line arrives into the dot. The traveling draw-head dot remains the rule for a single route being drawn.
- Overshoot/settle is reserved for stamps and verdict moments, the same rule as the character work.

## QC gates added by this skill

- **G8 Contrast:** for every rendered map frame sampled, compute (a) each text element against its immediate ground (floor 7:1), (b) the emphasis line against every land value it crosses (floor 3:1, casing present when required), (c) flood-pair luminance separation (floor 0.08). Any failure: adjust the token, not the gate.
- **G9 Focus and camera:** for every map shot, verify (a) the shot's subject (from the shot list) rests inside the central focal area at the camera's rest position, (b) exactly one focus at full saturation/value at any sampled instant during an event, (c) camera moves follow travel-land-hold with the 1.2s read-rest after labels, (d) during any draw, sampled frames show the draw head inside the central focal area. Failures are reframed or re-choreographed, never shipped with a note.

## Production notes
- Montserrat must be added to the renderer's font set (Google Fonts) before the next map build; Anton stays for display.
- Camera split (addendum item 11): scale and rotation live in the plate transform; perspective tilt and pan live in the camera channel; the master renders at 2x or more so scale never costs sharpness. (The Resolve corpus build makes the same split, vector transform plus 3D camera over a 4K master.)
- Texture placement (addendum item 10): grain over the whole comp is our light-register finish. The dark register's corpus variant puts a desaturated photographic texture under the map, merged multiply at reduced opacity. Either placement stays constant during events, so texture never reads as a focus change.
- Tutorial corpus status (FINAL, Oct 23, 2026, `~/workspace/borderline/research/harris-map-tutorials-study-addendum-2.md`): all 12 assigned videos have been accessed and the corpus is closed. By tier: (a) full frames: 1sWy42yq6Jg (Harris's own Short), DQO54GJmD8M (Geolayers 3), e9Z0RpLgUVw (Boone), 64H89PpkzRs (Zhylin, no plugins), 3kR8zZq9Pdw (Motion 5), 5LunYXCZDFM (Search Party in Resolve, addendum 1), HmWEguyo93g (Motionvid, addendum 2, full video + transcript). (b) Frames in part: 8ngil69ni6k (Resolve template pack; 108 frames at 10s covering 0:00 to about 17:50 of 28:14 from the surviving video stream, the merged file being corrupt; transcript not obtained, caption routes blocked) and fQ463YbflkM (Nuclear Media, no plugins; 46 frames at 5s covering 0:00 to about 3:45 of a declared 6:35 from a partial download; transcript likewise not obtained). (c) Transcript only: VjT_JLyJywc (beginner After Effects) and zZTjO86145U (AI tools). Three of the 12 are AI-tool videos and are flagged as non-craft sources: qDn2ZzHWEZo (Mira AI), zZTjO86145U (ScalingwContent) and HmWEguyo93g (Motionvid). Nothing in the corpus remains pending; the only recoverable gap is B9's narration, whose complete audio stream survives in `video-pipeline/downloads/8ngil69ni6k/` if a speech-to-text pass is ever wanted.
- Drafting economy (Richardson's rule): AI video drafts at 480p; code renders preview light, masters at 2x supersample.

## Changelog
- 2026-10-22, addendum pass (source: `harris-map-tutorials-study-addendum.md`, delta items 5 to 11): added the dark-register subject value-lift token and sampled dark-register reference colors; added the dashed label-leader component; added the constant edge-blur to the dark register's focus system; added the arc-endpoint anticipation beat; added the camera-split rule and the texture-placement variant to production notes; replaced the "6 unaccessed videos" note with the corpus status above. Items 13 and 14 of the addendum delta (border fade vs draw-on; value system vs hue floods in our dark scenes) were left unresolved and deliberately not edited in.
- 2026-10-23, addendum 2 pass (source: `harris-map-tutorials-study-addendum-2.md`, delta items 4 and 5): added the hexagonal portrait-badge variant to the badge token and the circular inset (map-detail inset and circular video window) to the component kit; replaced the corpus status with the final state of all 12 videos (corpus closed). Observed variants recorded but not adopted: translucent flood-over-relief as a default flood execution, and a serif label matched to an archival plate (the plate question is parked as a new unresolved item in addendum 2). Items 13 and 14 of the first addendum remain unresolved and deliberately not edited in; addendum 2's evidence does not settle either.
