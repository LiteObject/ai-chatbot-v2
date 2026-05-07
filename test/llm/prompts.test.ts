import { describe, expect, it } from "vitest";
import { createEmptyAppSpec } from "../../src/domain/appSpec";
import { buildClarifyingQuestionPrompt, buildExtractionPrompt } from "../../src/llm/prompts";

describe("prompt builders", () => {
  it("tells extraction to treat platform words as deployment target", () => {
    const prompt = buildExtractionPrompt("mobile", createEmptyAppSpec(), ["appType", "purpose"]);

    expect(prompt).toContain("put that in deploymentTarget");
    expect(prompt).toContain("Do not use those words as appType");
  });

  it("clarifies that appType is not web/mobile/desktop", () => {
    const prompt = buildClarifyingQuestionPrompt(createEmptyAppSpec(), ["appType", "purpose"]);

    expect(prompt).toContain("appType is the internal builder template");
    expect(prompt).toContain("Do not ask whether the app is web, mobile, or desktop");
  });
});