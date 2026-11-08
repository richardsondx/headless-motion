// Minimal JSON Schema 2020-12 walker for the keyword subset the scene schemas use.
// Errors carry a code: UNKNOWN_FIELD for additionalProperties:false, else the nearest
// "x-error-code" annotation, else PROP_TYPE.

const pointer = (path) => (path.length ? "/" + path.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/") : "");

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function typeMatches(want, v) {
  const got = typeOf(v);
  return want === got || (want === "number" && got === "integer");
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + "..." : s;
};

/**
 * @param {object} schema root schema (for $ref resolution)
 * @param {unknown} value
 * @param {{path?: (string|number)[], limit?: number}} [opts] path prefix for error pointers
 * @returns {{code:string, path:string, message:string}[]}
 */
export function checkSchema(schema, value, opts = {}) {
  const limit = opts.limit ?? 20;
  const errors = [];

  const resolve = (ref) => {
    if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
    return ref.slice(2).split("/").reduce((o, k) => o[k], schema);
  };

  /** @returns {boolean} true when valid */
  function walk(s, v, path, code, sink) {
    if (sink.length >= limit) return true;
    if (s.$ref) return walk(resolve(s.$ref), v, path, code, sink);
    const here = s["x-error-code"] || code;
    const fail = (c, message) => {
      sink.push({ code: c, path: pointer(path), message });
      return false;
    };
    let ok = true;

    if (s.type !== undefined) {
      const wants = Array.isArray(s.type) ? s.type : [s.type];
      if (!wants.some((w) => typeMatches(w, v))) {
        return fail(here, `expected ${wants.join("|")}, got ${typeOf(v)}`);
      }
    }
    if ("const" in s && v !== s.const) ok = fail(here, `expected ${short(s.const)}, got ${short(v)}`);
    if (s.enum && !s.enum.includes(v)) ok = fail(here, `expected one of ${s.enum.length} values, got ${short(v)}`);

    if (typeof v === "string") {
      if (s.minLength !== undefined && v.length < s.minLength) ok = fail(here, "string too short");
      if (s.pattern && !new RegExp(s.pattern).test(v)) ok = fail(here, `does not match ${s.pattern}, got ${short(v)}`);
    }
    if (typeof v === "number") {
      if (s.minimum !== undefined && v < s.minimum) ok = fail(here, `below minimum ${s.minimum}, got ${v}`);
      if (s.maximum !== undefined && v > s.maximum) ok = fail(here, `above maximum ${s.maximum}, got ${v}`);
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) ok = fail(here, `must exceed ${s.exclusiveMinimum}, got ${v}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) ok = fail(here, `needs at least ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) ok = fail(here, `allows at most ${s.maxItems} items`);
      v.forEach((item, i) => {
        const item_s = s.prefixItems && i < s.prefixItems.length ? s.prefixItems[i] : s.items;
        if (item_s && !walk(item_s, item, [...path, i], here, sink)) ok = false;
      });
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const key of s.required || []) {
        if (!(key in v)) ok = fail(here, `missing required field "${key}"`);
      }
      const props = s.properties || {};
      for (const key of Object.keys(v)) {
        const p = [...path, key];
        if (s.propertyNames && !new RegExp(s.propertyNames.pattern).test(key)) {
          sink.push({ code: here, path: pointer(p), message: `invalid name "${key}"` });
          ok = false;
        }
        if (key in props) {
          if (!walk(props[key], v[key], p, here, sink)) ok = false;
        } else if (s.additionalProperties === false) {
          sink.push({ code: "UNKNOWN_FIELD", path: pointer(p), message: `unknown field "${key}"` });
          ok = false;
        } else if (s.additionalProperties && typeof s.additionalProperties === "object") {
          if (!walk(s.additionalProperties, v[key], p, here, sink)) ok = false;
        }
      }
    }

    for (const sub of s.allOf || []) if (!walk(sub, v, path, here, sink)) ok = false;
    if (s.if && s.then) {
      const probe = [];
      if (walk(s.if, v, path, here, probe)) {
        if (!walk(s.then, v, path, here, sink)) ok = false;
      }
    }
    if (s.anyOf) {
      const passes = s.anyOf.some((branch) => walk(branch, v, path, here, []));
      if (!passes) ok = fail(here, `matches no allowed form, got ${short(v)}`);
    }
    return ok;
  }

  walk(schema, value, opts.path || [], "PROP_TYPE", errors);
  return errors.slice(0, limit);
}

export { pointer };
