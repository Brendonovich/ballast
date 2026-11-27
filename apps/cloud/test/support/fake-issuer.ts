import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal OpenID Connect issuer shaped like Anomaly's first-party rules:
 * PAR is required, every client request carries an ES256 `private_key_jwt`
 * assertion addressed to the issuer, `/token` needs a DPoP proof (and
 * challenges the first one with a nonce), PKCE is S256, and ID tokens are
 * ES256. It signs in `user` without a login page.
 */
export interface FakeUser {
  readonly sub: string;
  readonly name: string | null;
  readonly preferred_username: string | null;
}

export interface FakeIssuer {
  readonly issuer: string;
  readonly clientId: string;
  /** The client's private JWK, as the cloud's ANOMALY_CLIENT_KEY. */
  readonly clientKey: string;
  readonly user: () => FakeUser;
  /** Who the next sign-in is (there is no login page). */
  readonly setUser: (user: FakeUser) => void;
  /** Requests the issuer refused, for assertions. */
  readonly rejected: Array<string>;
  readonly close: () => Promise<void>;
}

const ec = { name: "ECDSA", namedCurve: "P-256" } as const;
const sig = { name: "ECDSA", hash: "SHA-256" } as const;

const keyPair = async (): Promise<CryptoKeyPair> => {
  const generated = await crypto.subtle.generateKey(ec, true, ["sign", "verify"]);
  if (!("privateKey" in generated)) throw new Error("expected a key pair");
  return generated;
};

const b64u = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");
const fromB64u = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64url"));
const json = (value: unknown) => b64u(new TextEncoder().encode(JSON.stringify(value)));

const signJwt = async (key: CryptoKey, header: object, payload: object): Promise<string> => {
  const input = json(header) + "." + json(payload);
  const signature = new Uint8Array(await crypto.subtle.sign(sig, key, new TextEncoder().encode(input)));
  return input + "." + b64u(signature);
};

const verifyJwt = async (token: string, key: CryptoKey) => {
  const [header, payload, signature] = token.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return undefined;
  const ok = await crypto.subtle.verify(sig, key, fromB64u(signature), new TextEncoder().encode(header + "." + payload));
  if (!ok) return undefined;
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>,
  };
};

const thumbprint = async (jwk: JsonWebKey): Promise<string> =>
  b64u(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })),
      ),
    ),
  );

const s256 = async (value: string) =>
  b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));

const readBody = (request: IncomingMessage): Promise<URLSearchParams> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString())));
    request.on("error", reject);
  });

export const startFakeIssuer = async (options: {
  readonly user?: FakeUser;
  readonly clientId?: string;
  readonly port?: number;
} = {}): Promise<FakeIssuer> => {
  const clientId = options.clientId ?? "ballast-test";
  let user: FakeUser = options.user ?? { sub: "pairwise-sub-1", name: "Ada Lovelace", preferred_username: "ada" };
  const signing = await keyPair();
  const signingJwk = { ...(await crypto.subtle.exportKey("jwk", signing.publicKey)), kid: "issuer-1", alg: "ES256", use: "sig" };
  const client = await keyPair();
  const clientPrivate = { ...(await crypto.subtle.exportKey("jwk", client.privateKey)), kid: "client-1" };
  const rejected: Array<string> = [];
  const pushed = new Map<string, URLSearchParams>();
  const codes = new Map<string, URLSearchParams>();
  const nonce = "dpop-nonce-1";
  let issuer = "";

  const clientAssertion = async (body: URLSearchParams) => {
    if (body.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return false;
    const verified = await verifyJwt(body.get("client_assertion") ?? "", client.publicKey);
    if (verified === undefined || verified.header["alg"] !== "ES256" || verified.header["kid"] !== "client-1") return false;
    const aud = verified.payload["aud"];
    const audiences = Array.isArray(aud) ? aud : [aud];
    return verified.payload["iss"] === clientId && verified.payload["sub"] === clientId && audiences.includes(issuer);
  };

  const dpop = async (request: IncomingMessage, url: string, requireNonce: boolean) => {
    const header = request.headers["dpop"];
    if (typeof header !== "string") return { ok: false as const };
    const [encoded] = header.split(".");
    const parsed = JSON.parse(Buffer.from(encoded ?? "", "base64url").toString()) as { typ?: string; jwk?: JsonWebKey };
    if (parsed.typ !== "dpop+jwt" || parsed.jwk === undefined) return { ok: false as const };
    const key = await crypto.subtle.importKey("jwk", parsed.jwk, ec, true, ["verify"]);
    const verified = await verifyJwt(header, key);
    if (verified === undefined || verified.payload["htm"] !== "POST" || verified.payload["htu"] !== url)
      return { ok: false as const };
    if (requireNonce && verified.payload["nonce"] !== nonce) return { ok: false as const, nonce: true };
    return { ok: true as const, jkt: await thumbprint(parsed.jwk) };
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", issuer);
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
      };
      const refuse = (reason: string, error = "invalid_request") => {
        rejected.push(reason);
        send(400, { error, error_description: reason });
      };
      if (url.pathname === "/.well-known/openid-configuration")
        return send(200, {
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          pushed_authorization_request_endpoint: issuer + "/par",
          require_pushed_authorization_requests: true,
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["pairwise"],
          id_token_signing_alg_values_supported: ["ES256"],
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
          code_challenge_methods_supported: ["S256"],
          dpop_signing_alg_values_supported: ["ES256"],
        });
      if (url.pathname === "/jwks") return send(200, { keys: [signingJwk] });
      if (url.pathname === "/par" && request.method === "POST") {
        const body = await readBody(request);
        if (!(await clientAssertion(body))) return refuse("par: bad client assertion", "invalid_client");
        if (body.get("code_challenge_method") !== "S256" || body.get("code_challenge") === null)
          return refuse("par: PKCE S256 required");
        if (body.get("dpop_jkt") === null) return refuse("par: dpop_jkt required");
        const uri = "urn:ietf:params:oauth:request_uri:" + crypto.randomUUID();
        pushed.set(uri, body);
        return send(201, { request_uri: uri, expires_in: 60 });
      }
      if (url.pathname === "/authorize") {
        const params = pushed.get(url.searchParams.get("request_uri") ?? "");
        if (params === undefined || url.searchParams.get("client_id") !== clientId)
          return refuse("authorize: unknown request_uri");
        pushed.delete(url.searchParams.get("request_uri") ?? "");
        const code = crypto.randomUUID();
        codes.set(code, params);
        const target = new URL(params.get("redirect_uri") ?? "");
        target.searchParams.set("code", code);
        target.searchParams.set("state", params.get("state") ?? "");
        target.searchParams.set("iss", issuer);
        response.writeHead(302, { location: target.href });
        return response.end();
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const body = await readBody(request);
        if (!(await clientAssertion(body))) return refuse("token: bad client assertion", "invalid_client");
        const proof = await dpop(request, issuer + "/token", true);
        if (!proof.ok) {
          if ("nonce" in proof) return send(400, { error: "use_dpop_nonce" }, { "dpop-nonce": nonce });
          return refuse("token: bad DPoP proof", "invalid_dpop_proof");
        }
        const params = codes.get(body.get("code") ?? "");
        codes.delete(body.get("code") ?? "");
        if (params === undefined) return refuse("token: unknown code", "invalid_grant");
        if (params.get("redirect_uri") !== body.get("redirect_uri")) return refuse("token: redirect_uri", "invalid_grant");
        if ((await s256(body.get("code_verifier") ?? "")) !== params.get("code_challenge"))
          return refuse("token: PKCE", "invalid_grant");
        if (params.get("dpop_jkt") !== proof.jkt) return refuse("token: dpop_jkt", "invalid_grant");
        const now = Math.floor(Date.now() / 1000);
        const idToken = await signJwt(
          signing.privateKey,
          { alg: "ES256", typ: "JWT", kid: "issuer-1" },
          {
            iss: issuer,
            aud: clientId,
            sub: user.sub,
            nonce: params.get("nonce"),
            iat: now,
            exp: now + 300,
            auth_time: now,
            ...(user.name === null ? {} : { name: user.name }),
            ...(user.preferred_username === null ? {} : { preferred_username: user.preferred_username }),
          },
        );
        return send(200, { access_token: "at-" + crypto.randomUUID(), token_type: "DPoP", expires_in: 300, id_token: idToken });
      }
      send(404, { error: "not_found" });
    })().catch((cause: unknown) => {
      rejected.push("crash: " + String(cause));
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  issuer = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  return {
    issuer,
    clientId,
    clientKey: JSON.stringify(clientPrivate),
    user: () => user,
    setUser: (next) => {
      user = next;
    },
    rejected,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
