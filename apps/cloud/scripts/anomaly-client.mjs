// Generate the share server's "Sign in with Anomaly" client key (decision 0014).
//
//   node scripts/anomaly-client.mjs https://cloud.example [client-id]
//
// Prints the private JWK to store as the ANOMALY_CLIENT_KEY secret, and the
// first-party ACCOUNT_CLIENTS entry to add in anomalyco/account (public key
// only). Without a registration, a public https server can instead use its
// client ID metadata document, <origin>/api/shares/auth/client.json, as the
// client id (leave ANOMALY_CLIENT_ID unset).
const origin = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(origin)) {
  console.error("usage: node scripts/anomaly-client.mjs <public origin> [client id]");
  process.exit(1);
}
const id = process.argv[3] ?? "ballast";
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const thumbprint = Buffer.from(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))),
).toString("base64url");
const privateKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d, kid: thumbprint };

console.log("ANOMALY_CLIENT_ID=" + id);
console.log("ANOMALY_CLIENT_KEY='" + JSON.stringify(privateKey) + "'");
console.log("\nACCOUNT_CLIENTS entry:");
console.log(
  JSON.stringify(
    {
      id,
      name: "Ballast",
      firstParty: true,
      redirects: [origin + "/api/shares/auth/callback"],
      origins: [origin],
      alg: "ES256",
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "ES256",
      jwks: { keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: thumbprint, alg: "ES256", use: "sig" }] },
    },
    null,
    2,
  ),
);
