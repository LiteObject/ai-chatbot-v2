import { describe, expect, it } from "vitest";
import { partialAppSpecSchema } from "../../src/domain/appSpec";

describe("partialAppSpecSchema", () => {
  it("moves platform-like app type values to deployment target", () => {
    expect(partialAppSpecSchema.parse({ appType: "mobile" })).toEqual({
      deploymentTarget: "mobile"
    });
  });

  it("keeps template words when app type includes a platform", () => {
    expect(partialAppSpecSchema.parse({ appType: "mobile dashboard" })).toEqual({
      appType: "dashboard",
      deploymentTarget: "mobile"
    });
  });

  it("maps unsupported app categories to other instead of failing extraction", () => {
    expect(partialAppSpecSchema.parse({ appType: "social" })).toEqual({
      appType: "other"
    });
  });

  it("rejects model-invented fields", () => {
    expect(() => partialAppSpecSchema.parse({
      purpose: "manage employees",
      unexpectedAction: "create the app now"
    })).toThrow();
  });

  it("rejects oversized list output", () => {
    const tooManyUsers = [...Array(26).keys()].map((index) => `user group ${index}`);

    expect(() => partialAppSpecSchema.parse({
      targetUsers: tooManyUsers
    })).toThrow();
  });
});