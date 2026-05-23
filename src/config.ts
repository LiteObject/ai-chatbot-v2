import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const configSchema = z.object({
  ollamaBaseUrl: z.string().url().default("http://localhost:11434"),
  ollamaModel: z.string().min(1).default("gemma4:latest"),
  ollamaContextWindowTokens: z.coerce.number().int().positive().default(256000),
  ollamaContextWindowWarningRatio: z.coerce.number().positive().max(1).default(0.8),
  ollamaContextWindowBlockRatio: z.coerce.number().positive().max(1).default(0.95),
  ollamaMaxTokens: z.coerce.number().int().positive().default(1200),
  ollamaTemperature: z.coerce.number().min(0).max(1).default(0),
  ollamaRetryAttempts: z.coerce.number().int().positive().default(3),
  ollamaRetryBaseDelayMs: z.coerce.number().int().nonnegative().default(250),
  ollamaRetryMaxDelayMs: z.coerce.number().int().nonnegative().default(2000),
  port: z.coerce.number().int().positive().default(3000),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
}).refine((config) => config.ollamaContextWindowWarningRatio < config.ollamaContextWindowBlockRatio, {
  message: "OLLAMA_CONTEXT_WINDOW_WARNING_RATIO must be lower than OLLAMA_CONTEXT_WINDOW_BLOCK_RATIO.",
  path: ["ollamaContextWindowWarningRatio"]
}).refine((config) => config.ollamaRetryBaseDelayMs <= config.ollamaRetryMaxDelayMs, {
  message: "OLLAMA_RETRY_BASE_DELAY_MS must be less than or equal to OLLAMA_RETRY_MAX_DELAY_MS.",
  path: ["ollamaRetryBaseDelayMs"]
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse({
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    ollamaModel: env.OLLAMA_MODEL,
    ollamaContextWindowTokens: env.OLLAMA_CONTEXT_WINDOW_TOKENS,
    ollamaContextWindowWarningRatio: env.OLLAMA_CONTEXT_WINDOW_WARNING_RATIO,
    ollamaContextWindowBlockRatio: env.OLLAMA_CONTEXT_WINDOW_BLOCK_RATIO,
    ollamaMaxTokens: env.OLLAMA_MAX_TOKENS,
    ollamaTemperature: env.OLLAMA_TEMPERATURE,
    ollamaRetryAttempts: env.OLLAMA_RETRY_ATTEMPTS,
    ollamaRetryBaseDelayMs: env.OLLAMA_RETRY_BASE_DELAY_MS,
    ollamaRetryMaxDelayMs: env.OLLAMA_RETRY_MAX_DELAY_MS,
    port: env.PORT,
    logLevel: env.LOG_LEVEL
  });
}
