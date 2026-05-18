export interface RedactionFinding {
  type: string;
  count: number;
}

export interface RedactionResult<T> {
  value: T;
  redacted: boolean;
  findings: RedactionFinding[];
}

interface TextPattern {
  type: string;
  pattern: RegExp;
  replacement?: string | ((...args: string[]) => string);
}

const labeledSecretPattern = /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|token|client[_ -]?secret|secret|password|passwd|pwd|private[_ -]?key|authorization)\b(\s*[:=]\s*)(["']?)([^\s"',;{}]{4,})(["']?)/gi;
const urlSecretPattern = /([?&](?:token|access_token|refresh_token|id_token|api[_-]?key|key|secret|sig|signature)=)([^&#\s]+)/gi;

const textPatterns: TextPattern[] = [
  {
    type: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  {
    type: "aws_access_key",
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g
  },
  {
    type: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g
  },
  {
    type: "github_token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g
  },
  {
    type: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  {
    type: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    replacement: "Bearer [REDACTED:bearer_token]"
  },
  {
    type: "connection_string",
    pattern: /\b(?:postgres(?:ql)?:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/|redis:\/\/)[^\s"'`<>]+/gi
  },
  {
    type: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  {
    type: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
  },
  {
    type: "phone",
    pattern: /\b\+?\d[\d .()/-]{7,}\d\b/g
  }
];

const sensitiveKeyPattern = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|pwd|private[_-]?key|authorization|credential)/i;

export function redactSensitiveText(text: string): RedactionResult<string> {
  const findings = new Map<string, number>();
  let value = redactUrlSecrets(text, findings);
  value = redactLabeledSecrets(value, findings);

  for (const textPattern of textPatterns) {
    value = value.replace(textPattern.pattern, (...args: string[]) => {
      incrementFinding(findings, textPattern.type);
      if (typeof textPattern.replacement === "function") {
        return textPattern.replacement(...args);
      }
      return textPattern.replacement ?? redactionMarker(textPattern.type);
    });
  }

  return {
    value,
    redacted: value !== text,
    findings: toFindings(findings)
  };
}

export function redactSensitiveValue<T>(value: T): RedactionResult<T> {
  const findings = new Map<string, number>();
  const redacted = redactUnknownValue(value, findings, new WeakSet<object>()) as T;

  return {
    value: redacted,
    redacted: toFindings(findings).length > 0,
    findings: toFindings(findings)
  };
}

function redactUnknownValue(value: unknown, findings: Map<string, number>, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactTextIntoFindings(value, findings);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknownValue(item, findings, seen));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[REDACTED:circular_reference]";
  }

  seen.add(value);
  const redactedEntries = Object.entries(value).map(([key, entryValue]) => {
    if (sensitiveKeyPattern.test(key)) {
      incrementFinding(findings, "sensitive_field");
      return [key, redactSensitiveFieldValue(entryValue)];
    }

    return [key, redactUnknownValue(entryValue, findings, seen)];
  });

  seen.delete(value);
  return Object.fromEntries(redactedEntries);
}

function redactSensitiveFieldValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(() => redactionMarker("sensitive_field"));
  }

  if (typeof value === "object") {
    return redactionMarker("sensitive_field");
  }

  return redactionMarker("sensitive_field");
}

function redactTextIntoFindings(text: string, findings: Map<string, number>): string {
  const result = redactSensitiveText(text);
  for (const finding of result.findings) {
    incrementFinding(findings, finding.type, finding.count);
  }
  return result.value;
}

function redactUrlSecrets(text: string, findings: Map<string, number>): string {
  return text.replace(urlSecretPattern, (_match, prefix: string) => {
    incrementFinding(findings, "url_secret");
    return `${prefix}REDACTED_url_secret`;
  });
}

function redactLabeledSecrets(text: string, findings: Map<string, number>): string {
  return text.replace(labeledSecretPattern, (match, label: string, separator: string, openingQuote: string, secret: string, closingQuote: string) => {
    if (secret.startsWith("REDACTED_") || secret.startsWith("[REDACTED:")) {
      return match;
    }

    incrementFinding(findings, "labeled_secret");
    const close = closingQuote && closingQuote === openingQuote ? closingQuote : "";
    return `${label}${separator}${openingQuote}${redactionMarker("labeled_secret")}${close}`;
  });
}

function incrementFinding(findings: Map<string, number>, type: string, amount = 1): void {
  findings.set(type, (findings.get(type) ?? 0) + amount);
}

function toFindings(findings: Map<string, number>): RedactionFinding[] {
  return [...findings.entries()].map(([type, count]) => ({ type, count }));
}

function redactionMarker(type: string): string {
  return `[REDACTED:${type}]`;
}