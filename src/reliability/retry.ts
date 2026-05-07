export interface RetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (delayMs: number) => Promise<void>;
}

const defaultBaseDelayMs = 250;
const defaultMaxDelayMs = 2000;

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const baseDelayMs = options.baseDelayMs ?? defaultBaseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? defaultMaxDelayMs;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleep = options.sleep ?? delay;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error, attempt)) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw new Error("Retry operation exited unexpectedly.");
}

export function isRetryableServiceError(error: unknown): boolean {
  const metadata = getErrorMetadata(error);
  const statusCode = metadata?.httpStatusCode;

  if (statusCode === 408 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
    return true;
  }

  const errorName = error instanceof Error ? error.name : undefined;
  if (!errorName) {
    return false;
  }

  return [
    "ThrottlingException",
    "TooManyRequestsException",
    "RequestTimeout",
    "TimeoutError",
    "ServiceUnavailableException",
    "InternalServerException",
    "ModelTimeoutException",
    "ModelNotReadyException"
  ].includes(errorName);
}

function getRetryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponentialDelay, maxDelayMs);
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function getErrorMetadata(error: unknown): { httpStatusCode?: number } | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }

  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata;
}