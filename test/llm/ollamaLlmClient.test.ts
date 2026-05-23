import { describe, expect, it } from "vitest";
import { createEmptyAppSpec } from "../../src/domain/appSpec";
import { OllamaLlmClient, type OllamaFetch } from "../../src/llm/ollamaLlmClient";

const config = {
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "gemma4:latest",
  ollamaContextWindowTokens: 256000,
  ollamaContextWindowWarningRatio: 0.8,
  ollamaContextWindowBlockRatio: 0.95,
  ollamaMaxTokens: 1200,
  ollamaTemperature: 0,
  ollamaRetryAttempts: 2,
  ollamaRetryBaseDelayMs: 0,
  ollamaRetryMaxDelayMs: 0,
  port: 3000,
  logLevel: "info"
} as const;

function createFetchResponse(body: string, status = 200, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return body;
    }
  };
}

describe("OllamaLlmClient", () => {
  it("extracts app specs and repairs malformed JSON responses", async () => {
    const requests: Array<{ input: string | URL; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const responses = [
      createFetchResponse(JSON.stringify({ message: { content: "{\"appType\":\"crud\",\"purpose\":\"Track tickets\"" } })),
      createFetchResponse(JSON.stringify({ message: { content: "{\"appType\":\"crud\",\"purpose\":\"Track tickets\",\"targetUsers\":[\"support team\"]}" } }))
    ];
    const fetchImpl: OllamaFetch = async (input, init) => {
      requests.push({ input, init });
      const response = responses.shift();

      if (!response) {
        throw new Error("Unexpected Ollama request");
      }

      return response;
    };
    const client = new OllamaLlmClient(config, undefined, fetchImpl);

    const result = await client.extractAppSpec({
      userMessage: "Build a ticket tracker for support.",
      currentSpec: createEmptyAppSpec(),
      missingFields: ["appType", "purpose"]
    });

    expect(result).toEqual({
      appType: "crud",
      purpose: "Track tickets",
      targetUsers: ["support team"]
    });
    expect(requests).toHaveLength(2);

    const firstRequestBody = requests[0]?.init.body;
    const secondRequestBody = requests[1]?.init.body;

    expect(firstRequestBody).toBeDefined();
    expect(secondRequestBody).toBeDefined();

    const firstRequest = JSON.parse(firstRequestBody as string) as {
      model: string;
      stream: boolean;
      format: string;
      options: { temperature: number; num_predict: number };
      messages: Array<{ role: string; content: string }>;
    };
    const secondRequest = JSON.parse(secondRequestBody as string) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(firstRequest).toMatchObject({
      model: "gemma4:latest",
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 1200
      }
    });
    expect(firstRequest.messages[0]).toMatchObject({ role: "system" });
    expect(firstRequest.messages[1]).toMatchObject({ role: "user" });
    expect(secondRequest.messages[0].content).toContain("You repair malformed JSON and return strict JSON only.");
  });

  it("normalizes clarifying questions returned by Ollama", async () => {
    const requests: Array<{ input: string | URL; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const fetchImpl: OllamaFetch = async (input, init) => {
      requests.push({ input, init });

      return createFetchResponse(JSON.stringify({
        message: {
          content: "# Missing details\n\n- **Question:** What should it track?"
        }
      }));
    };
    const client = new OllamaLlmClient(config, undefined, fetchImpl);

    const result = await client.generateClarifyingQuestion({
      appSpec: createEmptyAppSpec(),
      missingFields: ["appType", "purpose"]
    });

    expect(result).toBe("Missing details\n\nQuestion: What should it track?");
    expect(requests).toHaveLength(1);

    const requestBody = requests[0]?.init.body;

    expect(requestBody).toBeDefined();

    const request = JSON.parse(requestBody as string) as {
      model: string;
      stream: boolean;
      options: { temperature: number; num_predict: number };
    };

    expect(request).toMatchObject({
      model: "gemma4:latest",
      stream: false,
      options: {
        temperature: 0,
        num_predict: 1200
      }
    });
  });
});