import { describe, expect, it } from "vitest";
import { createEmptyTicketSpec } from "../../src/domain/ticketSpec";
import { mergeTicketSpec } from "../../src/domain/mergeTicketSpec";

describe("mergeTicketSpec", () => {
  it("preserves existing scalar values when extracted values are empty", () => {
    const existing = {
      ...createEmptyTicketSpec(),
      summary: "Need VPN access",
      ticketType: "request" as const
    };

    expect(mergeTicketSpec(existing, { summary: null }).summary).toBe("Need VPN access");
  });

  it("applies non-empty scalar corrections", () => {
    const existing = {
      ...createEmptyTicketSpec(),
      summary: "Payroll portal issue",
      ticketType: "incident" as const,
      impact: "A few reports are delayed"
    };

    const merged = mergeTicketSpec(existing, { impact: "Payroll processing is blocked" });
    expect(merged.impact).toBe("Payroll processing is blocked");
  });

  it("deduplicates list fields case-insensitively", () => {
    const existing = {
      ...createEmptyTicketSpec(),
      details: ["VPN access"]
    };

    const merged = mergeTicketSpec(existing, { details: ["vpn access", "MFA reset"] });
    expect(merged.details).toEqual(["VPN access", "MFA reset"]);
  });
});

