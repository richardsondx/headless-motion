// Count-up: value is from + (to - from) * ease(p), rounded with integer
// scaling, formatted with string code only. No Intl, no toLocaleString.
// At the last frame the value equals `to` exactly.
import { ease } from "../scene/easing.mjs";

const clampUnit = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

export function countupValue(props, frame) {
  const p = clampUnit((frame - props.start) / props.duration);
  const e = ease(props.ease || "easeOutCubic", p);
  const d = props.format?.decimals ?? 0;
  const factor = Math.pow(10, d);
  return Math.round((props.from + (props.to - props.from) * e) * factor) / factor;
}

export function formatCountup(value, format = {}) {
  const d = format.decimals ?? 0;
  const fixed = value.toFixed(d);
  const [int, frac] = fixed.split(".");
  let grouped = int;
  if (format.thousands) {
    const sign = grouped.startsWith("-") ? "-" : "";
    const digits = grouped.replace("-", "");
    grouped = sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  return (format.prefix || "") + grouped + (frac !== undefined ? "." + frac : "") + (format.suffix || "");
}

export function countupText(props, frame) {
  return formatCountup(countupValue(props, frame), props.format);
}
