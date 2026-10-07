import assert from "node:assert/strict";
import test from "node:test";
import { identifierKind, isValidIdentifier, parseIdentifiers } from "../lib/identifiers.js";
import { interpretLookup } from "../lib/starlink.js";
import { leadingZeroBits } from "../lib/pow.js";

test("parses lines, commas, spaced IMEIs, and duplicates", () => {
  const parsed = parseIdentifiers(`
    1234 5678 9012 345
    KIT4M001234567, ut12345678-90abcdef-12345678
    123456789012345
  `);
  assert.deepEqual(parsed.identifiers, [
    "123456789012345",
    "KIT4M001234567",
    "ut12345678-90abcdef-12345678",
  ]);
  assert.equal(parsed.duplicates, 1);
});

test("classifies the same identifier shapes the activation page accepts", () => {
  assert.equal(isValidIdentifier("123456789012345"), true);
  assert.equal(isValidIdentifier("KIT4M001234567"), true);
  assert.equal(isValidIdentifier("ut12345678-90abcdef-12345678"), true);
  assert.equal(isValidIdentifier("nope"), false);
  assert.equal(identifierKind("123456789012345"), "IMEI");
  assert.equal(identifierKind("KIT4M001234567"), "Kit ID");
});

test("counts leading zero bits the way the activation challenge does", () => {
  assert.equal(leadingZeroBits(Buffer.from([0b00001111, 0xff])), 4);
  assert.equal(leadingZeroBits(Buffer.from([0b10000000])), 0);
});

test("maps the activation lookup to available, assigned, and unknown", () => {
  assert.equal(interpretLookup(200, { isValid: true, content: { deviceId: "ut1", kitType: "PRD_TAG-MINI1" } }).status, "available");
  assert.equal(interpretLookup(200, { isValid: true, content: { deviceId: null, kitType: null } }).status, "activated");
  assert.equal(interpretLookup(400, { isValid: false, errors: [{ errorMessage: "invalid_device_id" }] }).status, "not_recognized");
});
