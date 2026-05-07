import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const configSchema = z.object({
  awsRegion: z.string().min(1).default("us-east-1"),
  bedrockModelId: z.string().min(1).default("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
  bedrockContextWindowTokens: z.coerce.number().int().positive().default(200000),
  bedrockContextWindowWarningRatio: z.coerce.number().positive().max(1).default(0.8),
  bedrockContextWindowBlockRatio: z.coerce.number().positive().max(1).default(0.95),
  bedrockMaxTokens: z.coerce.number().int().positive().default(1200),
  bedrockTemperature: z.coerce.number().min(0).max(1).default(0),
  bedrockRetryAttempts: z.coerce.number().int().positive().default(3),
  bedrockRetryBaseDelayMs: z.coerce.number().int().nonnegative().default(250),
  bedrockRetryMaxDelayMs: z.coerce.number().int().nonnegative().default(2000),
  port: z.coerce.number().int().positive().default(3000),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
}).refine((config) => config.bedrockContextWindowWarningRatio < config.bedrockContextWindowBlockRatio, {
  message: "BEDROCK_CONTEXT_WINDOW_WARNING_RATIO must be lower than BEDROCK_CONTEXT_WINDOW_BLOCK_RATIO.",
  path: ["bedrockContextWindowWarningRatio"]
}).refine((config) => config.bedrockRetryBaseDelayMs <= config.bedrockRetryMaxDelayMs, {
  message: "BEDROCK_RETRY_BASE_DELAY_MS must be less than or equal to BEDROCK_RETRY_MAX_DELAY_MS.",
  path: ["bedrockRetryBaseDelayMs"]
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse({
    awsRegion: env.AWS_REGION,
    bedrockModelId: env.BEDROCK_MODEL_ID,
    bedrockContextWindowTokens: env.BEDROCK_CONTEXT_WINDOW_TOKENS,
    bedrockContextWindowWarningRatio: env.BEDROCK_CONTEXT_WINDOW_WARNING_RATIO,
    bedrockContextWindowBlockRatio: env.BEDROCK_CONTEXT_WINDOW_BLOCK_RATIO,
    bedrockMaxTokens: env.BEDROCK_MAX_TOKENS,
    bedrockTemperature: env.BEDROCK_TEMPERATURE,
    bedrockRetryAttempts: env.BEDROCK_RETRY_ATTEMPTS,
    bedrockRetryBaseDelayMs: env.BEDROCK_RETRY_BASE_DELAY_MS,
    bedrockRetryMaxDelayMs: env.BEDROCK_RETRY_MAX_DELAY_MS,
    port: env.PORT,
    logLevel: env.LOG_LEVEL
  });
}
