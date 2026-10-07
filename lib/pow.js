import { createHash } from "node:crypto";

export function leadingZeroBits(buffer) {
  let bits = 0;
  for (const byte of buffer) {
    for (let shift = 7; shift >= 0; shift -= 1) {
      if (byte & (1 << shift)) return bits;
      bits += 1;
    }
  }
  return bits;
}

export function solveCaptcha(challenge, webDriver = false) {
  const timestamp = new Date(challenge.expiresAt).getTime();
  const prefix = `${challenge.id}${timestamp}${challenge.ip}${webDriver}`;
  const needed = challenge.solutions;
  const difficulty = challenge.difficulty;
  const started = Date.now();
  const nonces = [];
  let nonce = 0;
  const maxNonce = 100_000_000;

  while (nonce <= maxNonce && nonces.length < needed) {
    const digest = createHash("sha256").update(prefix + nonce).digest();
    if (leadingZeroBits(digest) >= difficulty) nonces.push(nonce);
    nonce += 1;
  }

  if (nonces.length < needed) {
    throw new Error("Could not solve the activation check challenge");
  }

  const payload = {
    nonces,
    durationMs: Date.now() - started,
    webDriver,
    strategy: "worker",
    id: challenge.id,
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
