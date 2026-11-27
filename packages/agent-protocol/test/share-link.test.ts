import { describe, expect, it } from "@effect/vitest";
import { parseShareInput, shareLink } from "../src/shares.ts";

describe("share links", () => {
  it("builds {server}/s/{code}", () => {
    expect(shareLink("https://cloud.example/", "ABCD-EFGH-JKLM")).toBe("https://cloud.example/s/ABCD-EFGH-JKLM");
  });

  it("parses a bare code", () => {
    expect(parseShareInput("  abcd-efgh-jklm ")).toEqual({ shareCode: "abcd-efgh-jklm" });
    expect(parseShareInput("ABCD EFGH JKLM")).toEqual({ shareCode: "ABCD EFGH JKLM" });
  });

  it("parses a link into its code and server", () => {
    expect(parseShareInput("https://cloud.example/s/ABCD-EFGH-JKLM")).toEqual({
      shareCode: "ABCD-EFGH-JKLM",
      server: "https://cloud.example",
    });
    expect(parseShareInput("http://127.0.0.1:8787/base/s/ABCDEFGHJKLM/")).toEqual({
      shareCode: "ABCDEFGHJKLM",
      server: "http://127.0.0.1:8787/base",
    });
    const link = shareLink("https://cloud.example", "ABCD-EFGH-JKLM");
    expect(parseShareInput(link)?.shareCode).toBe("ABCD-EFGH-JKLM");
  });

  it("rejects anything else", () => {
    expect(parseShareInput("")).toBeUndefined();
    expect(parseShareInput("https://cloud.example/x/ABCD")).toBeUndefined();
    expect(parseShareInput("ftp://cloud.example/s/ABCD")).toBeUndefined();
    expect(parseShareInput("ABCD/EFGH")).toBeUndefined();
    expect(parseShareInput("https://cloud.example/s/AB%2FCD")).toBeUndefined();
  });
});
