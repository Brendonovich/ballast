// Local-only bridge to the Artifacts simulator for local dev.
//
// Alchemy's local workerd only offers Artifacts as a remote binding, which
// needs Cloudflare credentials. Wrangler's local simulator (wrangler >= 4.163,
// git >= 2.32) runs real git repos on this machine, so this tiny Worker runs
// under `wrangler dev` and exposes the handful of binding calls the shares
// shares API's repo storage needs over HTTP (see src/repos.ts). The shares API uses
// it when BALLAST_SHARES is this bridge's URL. Never deploy it.

const json = (status, value) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const failure = (error) =>
  json(error?.code === "NOT_FOUND" ? 404 : 500, {
    code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  });

const repo = async (env, name) => {
  const found = await env.SHARES.get(name);
  if (found === null || found === undefined) {
    const error = new Error("Artifacts repo '" + name + "' not found");
    error.code = "NOT_FOUND";
    throw error;
  }
  return found;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((part) => part.length > 0).map(decodeURIComponent);
    try {
      if (parts[0] !== "repos") return json(404, { code: "NOT_FOUND", message: "Not found" });
      const name = parts[1];
      if (request.method === "POST" && parts.length === 1) {
        const body = await request.json();
        const created = await env.SHARES.create(body.name, { setDefaultBranch: "main" });
        return json(200, { name: created.name, remote: created.remote });
      }
      if (name === undefined) return json(404, { code: "NOT_FOUND", message: "Not found" });
      if (request.method === "DELETE" && parts.length === 2) {
        return json(200, { deleted: await env.SHARES.delete(name) });
      }
      if (request.method === "POST" && parts[2] === "tokens") {
        const body = await request.json();
        const target = await repo(env, name);
        const info = await target.info();
        const token = await target.createToken(body.scope, body.ttl);
        return json(200, {
          remote: info.remote,
          plaintext: token.plaintext,
          expiresAt: token.expiresAt,
        });
      }
      if (request.method === "GET" && parts[2] === "commits" && parts[3] !== undefined) {
        const commit = await (await repo(env, name)).readCommit(parts[3]);
        return commit === null ? json(404, { code: "NOT_FOUND", message: "No commit" }) : json(200, commit);
      }
      if (request.method === "GET" && parts[2] === "files") {
        const ref = url.searchParams.get("ref") ?? "";
        const path = url.searchParams.get("path") ?? "";
        const file = await (await repo(env, name)).readFile({ ref, path });
        if (file === null) return json(404, { code: "NOT_FOUND", message: "No file" });
        return new Response(await file.arrayBuffer(), {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return json(404, { code: "NOT_FOUND", message: "Not found" });
    } catch (error) {
      return failure(error);
    }
  },
};
