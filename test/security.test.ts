import { describe, expect, it } from "vitest";
import { constantTimeEqual, hmacSha256Hex, verifyHmacSha256 } from "../src/security";

describe("webhook HMAC security", () => {
  it("matches a known HMAC-SHA256 vector", async () => {
    await expect(hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog"))
      .resolves.toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  it("accepts the exact Tremendous signature format", async () => {
    const digest = await hmacSha256Hex("secret", '{"uuid":"evt_1"}');
    await expect(verifyHmacSha256("secret", '{"uuid":"evt_1"}', `sha256=${digest}`)).resolves.toBe(true);
  });

  it("rejects changed bodies and malformed signatures", async () => {
    const digest = await hmacSha256Hex("secret", '{"uuid":"evt_1"}');
    await expect(verifyHmacSha256("secret", '{"uuid":"evt_2"}', `sha256=${digest}`)).resolves.toBe(false);
    await expect(verifyHmacSha256("secret", "body", "sha256=not-hex")).resolves.toBe(false);
  });

  it("compares tokens without early character exits", () => {
    expect(constantTimeEqual("token", "token")).toBe(true);
    expect(constantTimeEqual("token", "t0ken")).toBe(false);
    expect(constantTimeEqual("short", "longer")).toBe(false);
  });
});
