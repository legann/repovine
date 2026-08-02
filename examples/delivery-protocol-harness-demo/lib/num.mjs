// Numeric env parsing that fails safe. `Number('abc')` is NaN, and
// `setTimeout(fn, NaN)` fires immediately — a non-numeric timeout env would
// abort a run at t=0 with a misleading "timed out". Coerce to a finite
// positive number or fall back.
export function finitePositive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
