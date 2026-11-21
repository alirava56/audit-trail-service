import { ApiError } from './domain.js';

/** Exact decimal value fingerprint without converting to IEEE-754. */
function decimalFingerprint(token) {
  const parts = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!parts) return null;
  const [, minus, integer, fraction = '', exponent = '0'] = parts;
  let digits = (integer + fraction).replace(/^0+/, '');
  if (digits === '') return '0';
  const before = digits.length;
  digits = digits.replace(/0+$/, '');
  const power = BigInt(exponent) - BigInt(fraction.length) + BigInt(before - digits.length);
  return `${minus}${digits}e${power}`;
}

/**
 * Reject ambiguous JSON object members before native JSON.parse can overwrite
 * an earlier value. Keys are compared after JSON escape decoding, at every
 * nesting level. The native parser remains the authoritative syntax parser.
 */
export function parseUnambiguousJson(text) {
  if (typeof text !== 'string') throw new TypeError('JSON input must be text');
  let index = 0;
  const fail = () => { throw new ApiError(400, 'Bad Request', 'Malformed or ambiguous JSON request body', 'validation_error'); };
  const whitespace = () => {
    while (index < text.length && (text[index] === ' ' || text[index] === '\n' ||
      text[index] === '\r' || text[index] === '\t')) index += 1;
  };
  function scanString() {
    if (text[index++] !== '"') fail();
    const start = index - 1;
    let escaped = false;
    for (; index < text.length; index++) {
      const char = text[index];
      if (!escaped && char === '"') {
        index += 1;
        try { return JSON.parse(text.slice(start, index)); }
        catch { fail(); }
      }
      if (!escaped && char === '\\') { escaped = true; continue; }
      escaped = false;
      if (char.charCodeAt(0) < 0x20) fail();
    }
    fail();
  }
  function scanValue(depth) {
    if (depth > 64) fail();
    whitespace();
    const char = text[index];
    if (char === '"') { scanString(); return; }
    if (char === '{') {
      index++;
      whitespace();
      const keys = new Set();
      if (text[index] === '}') { index++; return; }
      while (index < text.length) {
        whitespace();
        if (text[index] !== '"') fail();
        const key = scanString();
        if (keys.has(key)) {
          throw new ApiError(400, 'Bad Request', 'Duplicate JSON object member is not allowed', 'duplicate_json_key');
        }
        keys.add(key);
        whitespace();
        if (text[index++] !== ':') fail();
        scanValue(depth + 1);
        whitespace();
        if (text[index] === '}') { index++; return; }
        if (text[index++] !== ',') fail();
      }
      fail();
    }
    if (char === '[') {
      index++;
      whitespace();
      if (text[index] === ']') { index++; return; }
      while (index < text.length) {
        scanValue(depth + 1);
        whitespace();
        if (text[index] === ']') { index++; return; }
        if (text[index++] !== ',') fail();
      }
      fail();
    }
    // Consume primitive tokens; JSON.parse validates numbers, booleans, null.
    if (char === undefined || char === ',' || char === ']' || char === '}') fail();
    const start = index;
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index++;
    if (start === index) fail();
    let parsed;
    try { parsed = JSON.parse(text.slice(start, index)); }
    catch { fail(); }
    if (parsed !== null && typeof parsed !== 'number' && typeof parsed !== 'boolean') fail();
    if (typeof parsed === 'number') {
      // A JSON numeric token must survive a Number round trip with the same
      // mathematical decimal value, not just with a valid IEEE-754 encoding.
      // This catches large integer IDs and subtle fractional rounding such as
      // 1.0000000000000001 -> 1 before the hash is calculated.
      const token = text.slice(start, index);
      if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER ||
          Object.is(parsed, -0) ||
          decimalFingerprint(token) !== decimalFingerprint(JSON.stringify(parsed))) {
        throw new ApiError(400, 'Bad Request',
          'Unsafe JSON number; represent exact large identifiers and decimal amounts as strings',
          'unsafe_json_number');
      }
    }
  }
  scanValue(0);
  whitespace();
  if (index !== text.length) fail();
  try { return JSON.parse(text); }
  catch { fail(); }
}
