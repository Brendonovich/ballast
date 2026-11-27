import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ShareRow, SharesApiRpc } from "@ballast/shares-api";

import { makeOidcIdentityProvider } from "../src/shares/oidc.ts";
import { startFakeIssuer, type FakeIssuer } from "./support/fake-issuer.ts";
import { makeTestApp, type TestApp } from "./support/test-app.ts";

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
const challenge = async (value: string) =>
  b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));

const emptyShares = (): SharesApiRpc => {
  const shares: Array<ShareRow> = [];
  return {
    createShare: (input) =>
      Effect.sync(() => {
        const row: ShareRow = {
          id: "shr_" + shares.length,
          ownerUserId: input.ownerUserId,
          name: input.name,
          repo: "r",
          shareCode: "ABCDEFGHJKLM",
          currentSha: null,
          manifestHash: null,
          message: null,
          deployedAt: null,
          createdAt: 0,
          updatedAt: 0,
        };
        shares.push(row);
        return row;
      }),
    getShare: (id) => Effect.succeed(shares.find((row) => row.id === id) ?? null),
    findShareByCode: () => Effect.succeed(null),
    deployToken: () => Effect.die("unused"),
    recordDeploy: () => Effect.die("unused"),
    diff: () => Effect.die("unused"),
  };
};

/** Follow one redirect: the cloud's responses are in-process, the issuer is real HTTP. */
const location = (response: { readonly headers?: Readonly<Record<string, string>> }) => {
  const value = response.headers?.["location"];
  if (value === undefined) throw new Error("expected a redirect");
  return new URL(value);
};

describe("share sign-in (Sign in with Anomaly)", () => {
  let issuer: FakeIssuer;
  let cloud: TestApp;

  beforeAll(async () => {
    issuer = await startFakeIssuer();
    cloud = await makeTestApp({
      identity: makeOidcIdentityProvider({
        issuer: issuer.issuer,
        clientId: issuer.clientId,
        signingKey: JSON.parse(issuer.clientKey),
        insecure: true,
      }),
      shares: emptyShares(),
    });
  });
  afterAll(() => issuer.close());

  const signIn = async (agentRedirect = "http://127.0.0.1:47000/share-auth/callback") => {
    const query = new URLSearchParams({
      redirect_uri: agentRedirect,
      state: "agent-state-123",
      code_challenge: await challenge(verifier),
      code_challenge_method: "S256",
    });
    const login = await cloud.request({ method: "GET", path: "/api/shares/auth/login?" + query });
    expect(login.status).toBe(302);
    const authorize = location(login);
    expect(authorize.origin).toBe(issuer.issuer);
    // PAR: only client_id and request_uri go through the browser.
    expect([...authorize.searchParams.keys()].sort()).toEqual(["client_id", "request_uri"]);
    const issued = await fetch(authorize, { redirect: "manual" });
    const callback = new URL(issued.headers.get("location") ?? "");
    expect(callback.pathname).toBe("/api/shares/auth/callback");
    const back = await cloud.request({ method: "GET", path: callback.pathname + callback.search });
    expect(back.status).toBe(302);
    return location(back);
  };

  it("runs PAR + private_key_jwt + DPoP and hands the agent a session over PKCE", async () => {
    const agent = await signIn();
    expect(agent.origin + agent.pathname).toBe("http://127.0.0.1:47000/share-auth/callback");
    expect(agent.searchParams.get("state")).toBe("agent-state-123");
    const code = agent.searchParams.get("code") ?? "";
    expect(issuer.rejected).toEqual([]);

    // The wrong verifier burns the code.
    const wrong = await cloud.request({
      method: "POST",
      path: "/api/shares/auth/token",
      body: { code, codeVerifier: b64u(crypto.getRandomValues(new Uint8Array(32))) },
    });
    expect(wrong.status).toBe(400);
    const reused = await cloud.request({
      method: "POST",
      path: "/api/shares/auth/token",
      body: { code, codeVerifier: verifier },
    });
    expect(reused.status).toBe(400);

    const again = await signIn();
    const redeemed = await cloud.request({
      method: "POST",
      path: "/api/shares/auth/token",
      body: { code: again.searchParams.get("code"), codeVerifier: verifier, deviceName: "Studio PC" },
    });
    expect(redeemed.status).toBe(200);
    const session = JSON.parse(redeemed.body ?? "{}");
    expect(session.token).toMatch(/^blst_s_/);
    expect(session.user).toMatchObject({ issuer: issuer.issuer, name: "Ada Lovelace", username: "ada" });

    const auth = { authorization: "Bearer " + session.token };
    const me = await cloud.request({ method: "GET", path: "/api/shares/auth/me", headers: auth });
    expect(JSON.parse(me.body ?? "{}").user.id).toBe(session.user.id);

    // The same subject always maps to the same user, so shares survive a new sign-in.
    const third = await signIn();
    const second = JSON.parse(
      (
        await cloud.request({
          method: "POST",
          path: "/api/shares/auth/token",
          body: { code: third.searchParams.get("code"), codeVerifier: verifier },
        })
      ).body ?? "{}",
    );
    expect(second.user.id).toBe(session.user.id);
    expect(second.token).not.toBe(session.token);

    const created = await cloud.request({ method: "POST", path: "/api/shares", headers: auth, body: { name: "Demo" } });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body ?? "{}").share).toMatchObject({ owner: true });

    // Machine tokens and missing tokens do not reach the share routes.
    expect((await cloud.request({ method: "GET", path: "/api/shares/subscriptions" })).status).toBe(401);
    const { token: machineToken } = await cloud.seedMachine("12345");
    expect(
      (await cloud.request({ method: "GET", path: "/api/shares/subscriptions", headers: { authorization: "Bearer " + machineToken } })).status,
    ).toBe(401);

    expect((await cloud.request({ method: "POST", path: "/api/shares/auth/logout", headers: auth })).status).toBe(200);
    expect((await cloud.request({ method: "GET", path: "/api/shares/auth/me", headers: auth })).status).toBe(401);
  });

  it("only redirects codes to loopback and requires S256", async () => {
    const base = { state: "agent-state-123", code_challenge: await challenge(verifier), code_challenge_method: "S256" };
    for (const redirect of ["https://evil.example/cb", "http://evil.example/cb", "http://127.0.0.1.evil.example/cb"]) {
      const response = await cloud.request({
        method: "GET",
        path: "/api/shares/auth/login?" + new URLSearchParams({ ...base, redirect_uri: redirect }),
      });
      expect(response.status).toBe(400);
    }
    const plain = await cloud.request({
      method: "GET",
      path:
        "/api/shares/auth/login?" +
        new URLSearchParams({ ...base, code_challenge_method: "plain", redirect_uri: "http://localhost:5000/cb" }),
    });
    expect(plain.status).toBe(400);
  });

  it("answers 503 when no client key is configured", async () => {
    const unconfigured = await makeTestApp({ shares: emptyShares() });
    const response = await unconfigured.request({
      method: "GET",
      path:
        "/api/shares/auth/login?" +
        new URLSearchParams({
          redirect_uri: "http://127.0.0.1:1/cb",
          state: "agent-state-123",
          code_challenge: await challenge(verifier),
          code_challenge_method: "S256",
        }),
    });
    expect(response.status).toBe(503);
  });
});
