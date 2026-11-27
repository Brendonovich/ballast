// The Worker entry. It exports only its handler: workerd rejects a module whose
// other exports aren't handlers or entrypoints.
import { createHandler, type Env } from "./index"

export default { fetch: createHandler() } satisfies ExportedHandler<Env>
