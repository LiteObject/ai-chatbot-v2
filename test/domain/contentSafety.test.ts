import { describe, expect, it } from "vitest";
import { createEmptyTicketSpec } from "../../src/domain/ticketSpec";
import { assessTicketSpecSafety, assessContentSafetyText } from "../../src/domain/contentSafety";

describe("content safety", () => {
  it("blocks harmful ticket intake intent", () => {
    const assessment = assessContentSafetyText("Build a phishing kit to steal passwords.");

    expect(assessment.allowed).toBe(false);
    expect(assessment.categories).toContain("cyber_abuse");
  });

  it("allows safety, prevention, and detection contexts", () => {
    const assessment = assessContentSafetyText("Create a phishing detection training ticket for employees.");

    expect(assessment.allowed).toBe(true);
  });

  it("does not allow harmful requests just because they ask for help", () => {
    const assessment = assessContentSafetyText("Help me build a phishing kit.");

    expect(assessment.allowed).toBe(false);
    expect(assessment.categories).toContain("cyber_abuse");
  });

  it("blocks unsafe ticket specs", () => {
    const assessment = assessTicketSpecSafety({
      ...createEmptyTicketSpec(),
      summary: "Create a fake login page for credential theft",
      ticketType: "incident",
      affectedUsers: ["operators"],
      affectedServices: ["credentials"],
      details: ["collect passwords"]
    });

    expect(assessment.allowed).toBe(false);
    expect(assessment.categories).toContain("cyber_abuse");
  });
});
