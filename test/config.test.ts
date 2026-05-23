import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("uses Ollama defaults when no env vars are provided", () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "gemma4:latest",
      ollamaContextWindowTokens: 256000,
      ollamaContextWindowWarningRatio: 0.8,
      ollamaContextWindowBlockRatio: 0.95,
      ollamaMaxTokens: 1200,
      ollamaTemperature: 0,
      ollamaRetryAttempts: 3,
      ollamaRetryBaseDelayMs: 250,
      ollamaRetryMaxDelayMs: 2000,
      port: 3000,
      logLevel: "info"
    });
  });

  it("loads Ollama overrides from environment variables", () => {
    const config = loadConfig({
      OLLAMA_BASE_URL: "http://127.0.0.1:11435",
      OLLAMA_MODEL: "gemma4:latest",
      OLLAMA_CONTEXT_WINDOW_TOKENS: "128000",
      OLLAMA_CONTEXT_WINDOW_WARNING_RATIO: "0.7",
      OLLAMA_CONTEXT_WINDOW_BLOCK_RATIO: "0.9",
      OLLAMA_MAX_TOKENS: "512",
      OLLAMA_TEMPERATURE: "0.2",
      OLLAMA_RETRY_ATTEMPTS: "5",
      OLLAMA_RETRY_BASE_DELAY_MS: "100",
      OLLAMA_RETRY_MAX_DELAY_MS: "500",
      PORT: "4000",
      LOG_LEVEL: "debug"
    });

    expect(config).toMatchObject({
      ollamaBaseUrl: "http://127.0.0.1:11435",
      ollamaModel: "gemma4:latest",
      ollamaContextWindowTokens: 128000,
      ollamaContextWindowWarningRatio: 0.7,
      ollamaContextWindowBlockRatio: 0.9,
      ollamaMaxTokens: 512,
      ollamaTemperature: 0.2,
      ollamaRetryAttempts: 5,
      ollamaRetryBaseDelayMs: 100,
      ollamaRetryMaxDelayMs: 500,
      port: 4000,
      logLevel: "debug"
    });
  });
});