import { describe, expect, it } from "vitest";
import { isRetryableServiceError, withRetry } from "../../src/reliability/retry";

describe("withRetry", () => {
  it("retries retryable failures before succeeding", async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("temporarily unavailable"), {
          name: "ServiceUnavailableException"
        });
      }

      return "ok";
    }, {
      attempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      shouldRetry: isRetryableServiceError,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      }
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it("does not retry non-retryable failures", async () => {
    let calls = 0;

    await expect(withRetry(async () => {
      calls += 1;
      throw Object.assign(new Error("bad request"), {
        name: "ValidationException"
      });
    }, {
      attempts: 3,
      shouldRetry: isRetryableServiceError,
      sleep: async () => {}
    })).rejects.toThrow("bad request");

    expect(calls).toBe(1);
  });
});