import { describe, expect, it } from "vitest";
import { normalizeAssistantText } from "../../src/llm/textOutput";

describe("normalizeAssistantText", () => {
  it("removes common markdown decoration", () => {
    const text = normalizeAssistantText("# Title\n\n- **Question:** What should it track?");
    expect(text).toBe("Title\n\nQuestion: What should it track?");
  });

  it("removes unsafe control characters and falls back when output is empty", () => {
    const text = normalizeAssistantText("\u0000\u0007\u001F");

    expect(text).toBe("Could you share a little more detail about the app you want to build?");
  });

  it("limits assistant output length", () => {
    const text = normalizeAssistantText("A".repeat(20), { maxLength: 12 });

    expect(text).toBe("A".repeat(12));
  });
});
