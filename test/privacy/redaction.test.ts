import { describe, expect, it } from "vitest";
import { createCompositeTelemetry, getErrorAttributes, type Telemetry, type TelemetryAttributes } from "../../src/observability/telemetry";
import { redactSensitiveText, redactSensitiveValue } from "../../src/privacy/redaction";

class RecordingTelemetry implements Telemetry {
  readonly events: Array<{ name: string; attributes?: TelemetryAttributes }> = [];
  readonly metrics: Array<{ name: string; value: number; attributes?: TelemetryAttributes }> = [];

  event(name: string, attributes?: TelemetryAttributes): void {
    this.events.push({ name, attributes });
  }

  metric(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.metrics.push({ name, value, attributes });
  }
}

describe("redaction", () => {
  it("redacts secret-shaped text", () => {
    const result = redactSensitiveText("Use apiKey=super-secret-123 and contact admin@example.com.");

    expect(result.value).toContain("apiKey=[REDACTED:labeled_secret]");
    expect(result.value).toContain("[REDACTED:email]");
    expect(result.value).not.toContain("super-secret-123");
    expect(result.value).not.toContain("admin@example.com");
    expect(result.findings.map((finding) => finding.type)).toEqual(expect.arrayContaining(["labeled_secret", "email"]));
  });

  it("redacts nested values and sensitive object fields", () => {
    const result = redactSensitiveValue({
      purpose: "Build with Bearer abcdefghijklmnop",
      apiKey: "secret-value",
      users: ["owner@example.com"]
    });

    expect(result.value).toEqual({
      purpose: "Build with Bearer [REDACTED:bearer_token]",
      apiKey: "[REDACTED:sensitive_field]",
      users: ["[REDACTED:email]"]
    });
  });

  it("redacts telemetry attributes and error messages", () => {
    const recording = new RecordingTelemetry();
    const telemetry = createCompositeTelemetry(recording);

    telemetry.event("example", {
      errorMessage: "Builder failed with token=secret-token-123"
    });

    expect(recording.events[0]?.attributes?.errorMessage).toBe("Builder failed with token=[REDACTED:labeled_secret]");
    expect(getErrorAttributes(new Error("password=hunter2-value"))).toEqual({
      errorName: "Error",
      errorMessage: "password=[REDACTED:labeled_secret]"
    });
  });
});