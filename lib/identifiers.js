const UTID = /^(?:ut)?[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}$/i;
const KIT = /^(?:kit)?[a-z0-9]{11,13}$/i;
const SERIAL = /^[a-z0-9]{12,19}$/i;

export function isValidIdentifier(value) {
  return UTID.test(value) || KIT.test(value) || SERIAL.test(value);
}

export function identifierKind(value) {
  if (UTID.test(value)) return "Terminal ID";
  if (/^kit/i.test(value) || (KIT.test(value) && /[a-z]/i.test(value))) return "Kit ID";
  if (/^\d{12,19}$/.test(value)) return "IMEI";
  if (KIT.test(value) || SERIAL.test(value)) return "Identifier";
  return "Unknown";
}

export function parseIdentifiers(text) {
  const tokens = [];

  for (const line of String(text ?? "").split(/\r?\n/)) {
    for (const chunk of line.split(/[,;]+/)) {
      const trimmed = chunk.trim().replace(/^['"]+|['"]+$/g, "");
      if (!trimmed) continue;

      const digits = trimmed.replace(/[^\d]/g, "");
      if (/^[\d\s-]+$/.test(trimmed) && digits.length >= 12 && digits.length <= 19) {
        tokens.push(digits);
        continue;
      }

      for (const bit of trimmed.split(/\s+/)) {
        const cleaned = bit.trim().replace(/^['"]+|['"]+$/g, "");
        if (cleaned) tokens.push(cleaned);
      }
    }
  }

  const seen = new Set();
  const identifiers = [];
  let duplicates = 0;

  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    identifiers.push(token);
  }

  return { identifiers, duplicates };
}
