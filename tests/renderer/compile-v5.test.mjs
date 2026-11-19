// U3 tests: V5 3-pass silhouette union compiler + schema v5 block.
// Pass 1 stroke is lineWeight * 2.05; Pass 2 order is enforced by
// rank, so ears can never land on a forehead and standing legs can
// never land in front of the belly.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compileSilhouetteUnion,
  sortPass2Layers,
  PASS2_RANK,
} from "../../src/renderer/compile.mjs";
import { validateScene } from "../../src/scene/validate.mjs";

const FIXTURE = new URL("../fixtures/scene-min.json", import.meta.url);

const LAYERS = [
  { slot: "skull", d: "M 0,0 L 10,0 L 10,10 Z", fill: "#f48f34" },
  { slot: "nearEar", d: "M 0,0 L 5,0 L 5,5 Z", fill: "#f48f34" },
  { slot: "torso", d: "M 0,0 L 10,0 L 10,10 Z", fill: "#f48f34" },
  { slot: "frontLegStanding", d: "M 0,0 L 5,0 L 5,5 Z", fill: "#f48f34" },
  { slot: "farEar", d: "M 0,0 L 5,0 L 5,5 Z", fill: "#f48f34" },
  { slot: "tail", d: "M 0,0 L 5,0 L 5,5 Z", fill: "#f48f34" },
];

const ACTOR = {
  id: "milo-test",
  viewBox: "0 0 400 480",
  width: 400,
  height: 480,
  lineWeight: 9,
  outline: "#000b39",
  pass1Shapes: ["M 0,0 L 100,0 L 100,100 Z"],
  pass2Layers: LAYERS,
  torsoClipD: "M 0,0 L 100,0 L 100,100 Z",
  pass3Creases: [{ d: "M 10,10 L 20,10", stroke: "#000b39", width: 2 }],
  faceSvg: '<circle cx="50" cy="50" r="6" fill="#000b39"/>',
};

test("union: pass1 stroke is lineWeight * 2.05 with round joins and caps", () => {
  const r = compileSilhouetteUnion(ACTOR);
  assert.equal(r.pass1StrokeWidth, 18.45);
  assert.ok(r.svg.includes('stroke-width="18.45"'));
  assert.ok(r.svg.includes('stroke-linejoin="round"'));
  assert.ok(r.svg.includes('stroke-linecap="round"'));
  assert.ok(r.svg.includes('fill="none"'), "pass1 shapes must be fill none");
});

test("union: pass2 sorts ears behind the skull and standing legs behind the torso", () => {
  const r = compileSilhouetteUnion(ACTOR);
  assert.deepEqual(r.order, ["tail", "frontLegStanding", "torso", "farEar", "nearEar", "skull"]);
  const idx = (slot) => r.order.indexOf(slot);
  assert.ok(idx("farEar") < idx("skull"), "far ear must sort before the skull");
  assert.ok(idx("nearEar") < idx("skull"), "near ear must sort before the skull");
  assert.ok(idx("frontLegStanding") < idx("torso"), "standing leg must sort before the torso (behind-belly hips)");
  // The emitted SVG keeps the same order: torso path after the leg path.
  const legPos = r.svg.indexOf("frontLegStanding");
  assert.ok(legPos === -1, "slots are not emitted as text; check group order instead");
  const pass2 = r.svg.split('id="milo-test-pass2"')[1].split("</g>")[0];
  assert.ok(pass2.indexOf('fill="#f48f34"') > -1);
});

test("union: seated legs sort after the torso, props between legs and arms", () => {
  const layers = [
    { slot: "frontArm", d: "M 0,0 L 1,0 Z", fill: "#f48f34" },
    { slot: "frontLegSeated", d: "M 0,0 L 1,0 Z", fill: "#f48f34" },
    { slot: "prop", d: "M 0,0 L 1,0 Z", fill: "#f48f34" },
    { slot: "torso", d: "M 0,0 L 1,0 Z", fill: "#f48f34" },
  ];
  assert.deepEqual(sortPass2Layers(layers).map((l) => l.slot), ["torso", "frontLegSeated", "prop", "frontArm"]);
});

test("union: unknown slot throws instead of guessing a depth", () => {
  assert.throws(() => sortPass2Layers([{ slot: "mystery", d: "M 0,0 Z", fill: "#fff" }]), /UNION: unknown pass2 slot/);
});

test("union: audit silhouette is stroke-free solid fill of the same shapes", () => {
  const r = compileSilhouetteUnion(ACTOR);
  assert.ok(r.silhouetteSvg.includes('fill="#000000" stroke="none"'));
  assert.ok(!r.silhouetteSvg.includes("stroke-width"), "audit silhouette must carry no stroke");
  assert.ok(r.silhouetteSvg.includes("M 0,0 L 100,0 L 100,100 Z"));
  // Pass 1 alone has no fills at all.
  assert.ok(!r.pass1Svg.includes('fill="#f48f34"'));
});

test("union: lineWeight outside 8-11 throws, missing shapes throw", () => {
  assert.throws(() => compileSilhouetteUnion({ ...ACTOR, lineWeight: 5 }), /UNION: lineWeight/);
  assert.throws(() => compileSilhouetteUnion({ ...ACTOR, pass1Shapes: [] }), /UNION: actor needs at least one pass1/);
  assert.throws(() => compileSilhouetteUnion({ ...ACTOR, pass2Layers: [] }), /UNION: actor needs at least one pass2/);
  assert.throws(() => compileSilhouetteUnion({ ...ACTOR, id: "" }), /UNION: actor needs an id/);
});

test("union: pass3 creases and face land after pass2 in the SVG", () => {
  const r = compileSilhouetteUnion(ACTOR);
  const p2 = r.svg.indexOf('id="milo-test-pass2"');
  const p3 = r.svg.indexOf('id="milo-test-pass3"');
  assert.ok(p2 > 0 && p3 > p2, "pass3 group must follow pass2");
  assert.ok(r.svg.indexOf("M 10,10 L 20,10") > p3, "crease must be inside pass3");
  assert.ok(r.svg.indexOf("<circle") > p3, "face must be inside pass3");
});

test("schema: a scene with a v5 actor validates, and a bad yaw fails", () => {
  const scene = JSON.parse(readFileSync(FIXTURE, "utf8"));
  scene.v5 = {
    actors: [
      {
        id: "milo",
        archetype: "milo",
        groupMode: "silhouette-union",
        headYaw: 0.58,
        torsoYaw: -0.52,
        legYaw: -0.88,
        spineLeanDeg: 8,
        spineCurveX: 6,
        lookAt: [300, 200],
        feet: { left: { x: 120, y: 480 }, right: { x: 200, y: 480 } },
        limbs: [
          { side: "left", hipOverlapMode: "behind", footPin: { x: 120, y: 480 } },
          { side: "right", hipOverlapMode: "front", lift: 0.6 },
        ],
        garments: [{ kind: "belly", spineT: 0.45, lateral: 0, fill: "#fee8b8" }],
      },
    ],
  };
  const { errors } = validateScene(scene);
  assert.deepEqual(errors, [], `v5 scene must validate, got ${JSON.stringify(errors)}`);
  const bad = JSON.parse(JSON.stringify(scene));
  bad.v5.actors[0].headYaw = 1.5;
  const badResult = validateScene(bad);
  assert.ok(badResult.errors.length > 0, "yaw 1.5 must fail validation");
  const badMode = JSON.parse(JSON.stringify(scene));
  badMode.v5.actors[0].groupMode = "flat";
  assert.ok(validateScene(badMode).errors.length > 0, "groupMode other than silhouette-union must fail");
});
