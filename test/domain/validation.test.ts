import { describe, expect, it } from "vitest";
import { createEmptyTicketSpec } from "../../src/domain/ticketSpec";
import { getMissingFields, getRequiredFieldsForSpec, isReadyToBuild } from "../../src/domain/validation";

describe("getMissingFields", () => {
  it("requires ticket type and summary for an empty spec", () => {
    expect(getMissingFields(createEmptyTicketSpec())).toEqual(["ticketType", "summary"]);
  });

  it("requires request fields", () => {
    const spec = {
      ...createEmptyTicketSpec(),
      ticketType: "request" as const,
      summary: "Need VPN access"
    };

    expect(getMissingFields(spec)).toEqual(["affectedUsers", "affectedServices", "details"]);
  });

  it("requires incident impact before a ticket is ready", () => {
    const spec = {
      ...createEmptyTicketSpec(),
      ticketType: "incident" as const,
      summary: "Payroll portal is down",
      affectedUsers: ["payroll team"],
      affectedServices: ["payroll portal"],
      details: ["users get a 500 error"]
    };

    expect(getMissingFields(spec)).toEqual(["impact"]);
  });

  it("marks a complete incident as ready", () => {
    const spec = {
      ...createEmptyTicketSpec(),
      ticketType: "incident" as const,
      summary: "Payroll portal is down",
      affectedUsers: ["payroll team"],
      affectedServices: ["payroll portal"],
      details: ["users get a 500 error"],
      impact: "Payroll processing is blocked"
    };

    expect(getMissingFields(spec)).toEqual([]);
    expect(isReadyToBuild(spec)).toBe(true);
  });
});

describe("getRequiredFieldsForSpec", () => {
  it("requires ticket type and summary before a ticket type is known", () => {
    expect(getRequiredFieldsForSpec(createEmptyTicketSpec())).toEqual(["ticketType", "summary"]);
  });

  it("adds request-specific required fields", () => {
    expect(getRequiredFieldsForSpec({
      ...createEmptyTicketSpec(),
      ticketType: "request"
    })).toEqual(["ticketType", "summary", "affectedUsers", "affectedServices", "details"]);
  });

  it("adds incident-specific required fields", () => {
    expect(getRequiredFieldsForSpec({
      ...createEmptyTicketSpec(),
      ticketType: "incident"
    })).toEqual(["ticketType", "summary", "affectedUsers", "affectedServices", "details", "impact"]);
  });
});

