// Static bars: width is a pure function of value and max. No animation
// state lives here; animation comes from the scene timeline or a bar race.
export function barState(values, max = null) {
  const m = max ?? Math.max(0, ...Object.values(values));
  return Object.entries(values).map(([name, value]) => ({
    name,
    value,
    width: m === 0 ? 0 : value / m,
  }));
}
