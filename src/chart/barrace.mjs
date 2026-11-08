// Bar race: ranks are resolved at the keyframe rows only, tie-break by
// name A to Z. Between rows each bar slides from its old slot to its new
// slot with easeInOutCubic. Never sort per frame.
import { ease } from "../scene/easing.mjs";
import { countupValue, formatCountup } from "./countup.mjs";

function ranksAtRow(row) {
  const names = Object.keys(row.values);
  return names.sort((a, b) => {
    const d = row.values[b] - row.values[a];
    return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * @param {{rows:{f:number,values:Record<string,number>}[], slide?:number}} props
 * @returns {[{name, value, slot, label}]} slot is a float (0 is the top row)
 */
export function barraceState(props, frame) {
  const rows = props.rows;
  const slide = props.slide ?? 12;
  if (!rows || rows.length === 0) return [];
  let i = 0;
  // Stay on row i while the slide into row i+1 is still running: the
  // transition into row i+1 occupies [rows[i+1].f, rows[i+1].f + slide].
  while (i + 1 < rows.length && frame >= rows[i + 1].f + slide) i++;
  const rowA = rows[i];
  const rowB = rows[i + 1];
  const rankA = ranksAtRow(rowA);
  const slotA = new Map(rankA.map((n, s) => [n, s]));
  if (!rowB) {
    return rankA.map((name) => ({
      name,
      value: rowA.values[name],
      slot: slotA.get(name),
      label: formatCountup(rowA.values[name], props.format),
    }));
  }
  const rankB = ranksAtRow(rowB);
  const slotB = new Map(rankB.map((n, s) => [n, s]));
  const p = Math.min(1, Math.max(0, (frame - rowB.f) / slide));
  const e = ease("easeInOutCubic", p);
  const names = [...new Set([...rankA, ...rankB])];
  return names
    .map((name) => {
      const a = rowA.values[name] ?? 0;
      const b = rowB.values[name] ?? 0;
      const value = a + (b - a) * e;
      const slot = (slotA.get(name) ?? rankA.length) + ((slotB.get(name) ?? rankB.length) - (slotA.get(name) ?? rankA.length)) * e;
      return { name, value, slot, label: formatCountup(value, props.format) };
    })
    .sort((x, y) => x.slot - y.slot);
}
