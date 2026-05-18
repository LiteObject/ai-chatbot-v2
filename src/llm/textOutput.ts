export interface NormalizeAssistantTextOptions {
  fallback?: string;
  maxLength?: number;
}

const defaultFallback = "Could you share a little more detail about the app you want to build?";
const defaultMaxLength = 1000;

export function normalizeAssistantText(text: string, options: NormalizeAssistantTextOptions = {}): string {
  const fallback = options.fallback ?? defaultFallback;
  const maxLength = options.maxLength ?? defaultMaxLength;
  const normalized = removeUnsafeControlCharacters(text)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return truncateAssistantText(normalized || fallback, maxLength);
}

function removeUnsafeControlCharacters(text: string): string {
  return [...text].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 9 || codePoint === 10 || codePoint === 13 || (codePoint >= 32 && codePoint !== 127);
  }).join("");
}

function truncateAssistantText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, Math.max(1, maxLength)).trimEnd();
}
