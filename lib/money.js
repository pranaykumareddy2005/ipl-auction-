'use strict';
// All money is stored internally in LAKHS (L). 100 L = 1 Crore.

/** Format lakhs as a human string, e.g. 150 -> "₹1.50 Cr", 30 -> "₹30 L". */
function fmtL(L) {
  L = Number(L) || 0;
  if (L >= 100) {
    const c = L / 100;
    return '₹' + (c % 1 === 0 ? c : c.toFixed(2)) + ' Cr';
  }
  return '₹' + L + ' L';
}

/** Standard IPL bid increment (in lakhs) given the current price in lakhs. */
function stepFor(L) {
  L = Number(L) || 0;
  if (L < 100) return 10;   // below ₹1 Cr  -> +10 L
  if (L < 200) return 20;   // ₹1–2 Cr      -> +20 L
  if (L < 500) return 25;   // ₹2–5 Cr      -> +25 L
  return 50;                // above ₹5 Cr  -> +50 L
}

/** Parse a free-text amount like "6.25 crore", "30 lakh", "INR 10.75 crore" into lakhs. */
function parseAmountToL(text) {
  if (text == null) return null;
  const s = String(text).toLowerCase().replace(/inr|rs\.?|₹|,/g, ' ').trim();
  const m = s.match(/([\d]+(?:\.\d+)?)\s*(cr|crore|crores|l|lac|lakh|lakhs|lah)?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = (m[2] || '').replace(/s$/, '');
  if (unit === 'cr' || unit === 'crore') return Math.round(n * 100);
  // "lah" is a common typo for lakh; default bare numbers to lakh
  return Math.round(n);
}

module.exports = { fmtL, stepFor, parseAmountToL };
