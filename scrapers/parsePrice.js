/**
 * Parse a European price string into a float.
 * Handles: "€ 4,49", "€4,-", "4.49", "29,99", "€ 1.299,00", "€ 1.299.999,00"
 */
function parsePrice(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/[€$£\s]/g, "")   // remove currency symbols and spaces
    .replace(/\.(?=\d{3}(?:[,.]|$))/g, "")  // remove thousands separators ("1.299.999,00" → "1299999,00")
    .replace(",", ".")          // European decimal → JS decimal
    .replace(/-$/, "00");       // "4.-" → "4.00" (handles "€4,-" style)
  const value = parseFloat(cleaned);
  return isNaN(value) ? null : value;
}

module.exports = { parsePrice };
