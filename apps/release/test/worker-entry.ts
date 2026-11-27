// Test-only Worker: the production handler with an injected JWKS, registry and clock.
import { createHandler, type Env } from "../src/worker/index"

type TestEnv = Env & { TEST_JWKS: string; TEST_REGISTRY: string }

export default {
  fetch(request: Request, env: TestEnv) {
    const handler = createHandler({
      jwks: async () => JSON.parse(env.TEST_JWKS),
      registry: JSON.parse(env.TEST_REGISTRY),
      now: () => (request.headers.get("x-test-now") ? Number(request.headers.get("x-test-now")) : Date.now()),
    })
    return handler(request, env)
  },
}
