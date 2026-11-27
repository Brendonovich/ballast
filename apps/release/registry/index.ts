// Every registered app. Add registry/<app>.json and list it here; test/registry.test.ts fails on unlisted files.
import ballast from "./ballast.json"

export const apps: unknown[] = [ballast]
