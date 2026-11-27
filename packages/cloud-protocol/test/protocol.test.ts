import { describe, expect, it } from "vitest";

import { conditionKey } from "../src/index.ts";

describe("cloud protocol", () => {
  it("conditionKey is independent of condition key order", () => {
    expect(
      conditionKey({ broadcaster_user_id: "1", moderator_user_id: "2" }),
    ).toBe(conditionKey({ moderator_user_id: "2", broadcaster_user_id: "1" }));
  });
});
