import { describe, expect, it } from "vitest";
import { createEmptyAppSpec } from "../../src/domain/appSpec";
import { getMissingFields, getRequiredFieldsForSpec, isReadyToBuild } from "../../src/domain/validation";

describe("getMissingFields", () => {
  it("requires app type and purpose for an empty spec", () => {
    expect(getMissingFields(createEmptyAppSpec())).toEqual(["appType", "purpose"]);
  });

  it("requires CRUD app fields", () => {
    const spec = {
      ...createEmptyAppSpec(),
      appType: "crud" as const,
      purpose: "manage employees"
    };

    expect(getMissingFields(spec)).toEqual(["targetUsers", "dataEntities", "coreFeatures"]);
  });

  it("treats false boolean fields as present", () => {
    const spec = {
      ...createEmptyAppSpec(),
      appType: "portal" as const,
      purpose: "share project updates",
      targetUsers: ["customers"],
      coreFeatures: ["view project status"],
      authRequired: false
    };

    expect(getMissingFields(spec)).toEqual([]);
    expect(isReadyToBuild(spec)).toBe(true);
  });
});

describe("getRequiredFieldsForSpec", () => {
  it("requires app type and purpose before an app type is known", () => {
    expect(getRequiredFieldsForSpec(createEmptyAppSpec())).toEqual(["appType", "purpose"]);
  });

  it("adds app-type-specific required fields", () => {
    expect(getRequiredFieldsForSpec({
      ...createEmptyAppSpec(),
      appType: "workflow"
    })).toEqual(["appType", "purpose", "targetUsers", "coreFeatures", "workflowSteps"]);
  });
});
