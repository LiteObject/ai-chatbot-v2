import { describe, expect, it } from "vitest";
import { createEmptyTicketSpec } from "../../src/domain/ticketSpec";
import { createUserPreferences, mergeUserPreferencesFromTicketSpec } from "../../src/domain/userPreferences";

describe("user preferences", () => {
  it("tracks reusable preferences from ticket specs", () => {
    const preferences = createUserPreferences("user_1", "2026-05-18T00:00:00.000Z");

    const updated = mergeUserPreferencesFromTicketSpec(preferences, {
      ...createEmptyTicketSpec(),
      ticketType: "request",
      environment: "web",
      affectedServices: ["VPN", "vpn", "SSO"]
    });

    expect(updated).toMatchObject({
      userId: "user_1",
      preferredTicketType: "request",
      preferredEnvironment: "web",
      preferredAffectedServices: ["VPN", "SSO"]
    });
  });
});
