// Rig validator: schema walk first, then cross-reference checks.
// Mirrors src/scene/validate.mjs (same error shape, same 20-error cap,
// same early return on schema errors). Library only: `hme validate`
// reaches it through validateScene in src/scene/validate.mjs, which
// dispatches on schema "hme.rig/1.0".
//
// What is checked here, and what is not:
//   - joint.part must name a part in `parts`, else BAD_JOINT naming the joint.
//   - joint.parent must name a joint, and the parent chain must not loop,
//     else BAD_JOINT / JOINT_CYCLE naming the joint.
//   - every pose state must name a part in `parts`, else MISSING_PART
//     naming the missing part.
//   - duplicate part, joint, and pose ids are DUP_ID.
//   - a part's `node` (the shape node it maps to) is NOT checked here:
//     a rig file carries no scene, so node existence is an expansion-time
//     check (Unit C).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkSchema, pointer } from "../scene/schema-walk.mjs";

const SCHEMA_PATH = new URL("./rig.schema.json", import.meta.url);
export const rigSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
export const RIG_VERSION = rigSchema.properties.schema.const;
const MAX_ERRORS = 20;
const VALUE_FIELDS = ["x", "y", "scale", "rotation", "opacity"];

/**
 * @param {any} rig parsed JSON
 * @returns {{errors:{code:string,path:string,message:string}[], warnings:{code:string,path:string,message:string}[]}}
 */
export function validateRig(rig) {
  const errors = [];
  const warnings = [];
  const add = (code, path, message) => {
    if (errors.length < MAX_ERRORS) errors.push({ code, path: typeof path === "string" ? path : pointer(path), message });
  };

  if (rig === null || typeof rig !== "object" || rig.schema !== RIG_VERSION) {
    const got = rig && typeof rig === "object" ? rig.schema : rig;
    add("SCHEMA_VERSION", ["schema"], `expected "${RIG_VERSION}", got ${JSON.stringify(got)}`);
    return { errors, warnings };
  }
  errors.push(...checkSchema(rigSchema, rig, { limit: MAX_ERRORS }));
  if (errors.length) return { errors, warnings };

  const { parts, joints, poses } = rig;
  const partIds = new Set();
  parts.forEach((p, i) => {
    if (partIds.has(p.id)) add("DUP_ID", ["parts", i, "id"], `part id "${p.id}" already used`);
    partIds.add(p.id);
  });
  const jointById = new Map();
  joints.forEach((j, i) => {
    if (jointById.has(j.id)) add("DUP_ID", ["joints", i, "id"], `joint id "${j.id}" already used`);
    else jointById.set(j.id, { joint: j, index: i });
  });
  const poseIds = new Set();
  poses.forEach((p, i) => {
    if (poseIds.has(p.id)) add("DUP_ID", ["poses", i, "id"], `pose id "${p.id}" already used`);
    poseIds.add(p.id);
  });

  checkJoints(joints, jointById, partIds, add);
  poses.forEach((pose, i) => {
    const seen = new Set();
    pose.states.forEach((s, j) => {
      if (!partIds.has(s.part)) {
        add("MISSING_PART", ["poses", i, "states", j, "part"], `pose "${pose.id}" references part "${s.part}" which does not exist`);
      }
      if (seen.has(s.part)) add("PROP_TYPE", ["poses", i, "states", j, "part"], `pose "${pose.id}" sets part "${s.part}" twice`);
      seen.add(s.part);
      if (!VALUE_FIELDS.some((f) => s[f] !== undefined)) {
        add("PROP_TYPE", ["poses", i, "states", j], `pose "${pose.id}" state for part "${s.part}" sets no value (x, y, scale, rotation, opacity)`);
      }
    });
  });
  return { errors, warnings };
}

function checkJoints(joints, jointById, partIds, add) {
  const inReportedCycle = new Set();
  joints.forEach((j, i) => {
    if (!partIds.has(j.part)) {
      add("BAD_JOINT", ["joints", i, "part"], `joint "${j.id}" moves part "${j.part}" which does not exist`);
    }
    if (j.parent === null || j.parent === undefined) return;
    if (!jointById.has(j.parent)) {
      add("BAD_JOINT", ["joints", i, "parent"], `joint "${j.id}" parent joint "${j.parent}" does not exist`);
      return;
    }
    const chain = [];
    let cur = j.id;
    while (cur !== null && cur !== undefined && !chain.includes(cur) && jointById.has(cur)) {
      chain.push(cur);
      cur = jointById.get(cur).joint.parent;
    }
    if (cur !== null && cur !== undefined && jointById.has(cur) && chain.includes(cur) && !inReportedCycle.has(j.id)) {
      const cycle = chain.slice(chain.indexOf(cur));
      cycle.forEach((id) => inReportedCycle.add(id));
      if (cycle.includes(j.id)) {
        add("JOINT_CYCLE", ["joints", i, "parent"], `joint "${j.id}" parent chain loops: ${[...cycle, cur].join(" > ")}`);
      }
    }
  });
}

/** @param {string} file @returns {any} */
export const loadRig = (file) => JSON.parse(readFileSync(file, "utf8"));

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error("usage: node src/rig/validate.mjs <rig.json>");
    return 2;
  }
  let rig;
  try {
    rig = loadRig(file);
  } catch (err) {
    console.error(`RIG_UNREADABLE ${file} ${err.message}`);
    return 2;
  }
  const { errors, warnings } = validateRig(rig);
  for (const w of warnings) console.error(`WARN ${w.code} ${w.path} ${w.message}`);
  if (errors.length) {
    for (const e of errors) console.log(`${e.code} ${e.path || "/"} ${e.message}`);
    if (errors.length >= MAX_ERRORS) console.log(`stopped after ${MAX_ERRORS} errors`);
    return 1;
  }
  console.log(`OK ${rig.meta.id} ${rig.character.id} ${rig.parts.length} parts ${rig.joints.length} joints ${rig.poses.length} poses`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv);
