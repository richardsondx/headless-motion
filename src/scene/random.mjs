// Keyed hash randomness. No running sequence, so frame order cannot change a value.

/**
 * 53-bit hash (cyrb53 construction) of a string.
 * @param {string} str
 * @returns {number} integer in [0, 2^53)
 */
function hash53(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * @param {number} seed meta.seed
 * @param {...(string|number)} keys for example nodeId, "particle", 17
 * @returns {number} in [0, 1)
 */
export function rand(seed, ...keys) {
  return hash53(JSON.stringify([seed, ...keys])) / 9007199254740992;
}
