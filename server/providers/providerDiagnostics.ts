import fs from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../store.js';

export type ProviderErrorClass =
  | 'AUTH_401'
  | 'AUTH_403'
  | 'DAILY_QUOTA_429'
  | 'TEMP_RATE_LIMIT_429'
  | 'MODEL_QUOTA_429'
  | 'INVALID_REQUEST_400'
  | 'NOT_FOUND_404'
  | 'PROVIDER_5XX'
  | 'NETWORK'
  | 'UNKNOWN';

export type ProviderErrorDetails = {
  provider: 'gemini' | 'glm';
  model: string;
  status: number | null;
  classification: ProviderErrorClass;
  retryAfterMs: number;
  quotaMetric: string | null;
  quotaId: string | null;
  quotaDimensions: Record<string, unknown> | null;
  message: string;
  bodySnippet: string;
};

export type ProviderDiagnosticRecord = ProviderErrorDetails & {
  timestamp: string;
  batchStart: number | null;
  batchEnd: number | null;
  attempt: number;
};

const FILE = path.join(dataRoot(), 'diagnostics', 'provider-errors.jsonl');

function safeJson(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

function retryDelayFromBody(json: any, body: string) {
  const details = Array.isArray(json?.error?.details) ? json.error.details : [];
  for (const detail of details) {
    const raw = detail?.retryDelay;
    if (typeof raw === 'string') {
      const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
      if (m) return Math.ceil(Number(m[1]) * 1000);
    }
  }
  const match = body.match(/"retryDelay"\s*:\s*"([0-9]+(?:\.[0-9]+)?)s"/i)
    ?? body.match(/retry(?:Delay|[_ -]?after| in)[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)\s*s/i);
  return match ? Math.ceil(Number(match[1]) * 1000) : 0;
}

function quotaFromJson(json: any) {
  const details = Array.isArray(json?.error?.details) ? json.error.details : [];
  for (const detail of details) {
    const violations = Array.isArray(detail?.violations) ? detail.violations : [];
    if (violations.length) {
      const v = violations[0];
      return {
        metric: typeof v?.quotaMetric === 'string' ? v.quotaMetric : null,
        id: typeof v?.quotaId === 'string' ? v.quotaId : null,
        dimensions: v?.quotaDimensions && typeof v.quotaDimensions === 'object' ? v.quotaDimensions : null
      };
    }
  }
  return { metric: null, id: null, dimensions: null };
}

export function classifyProviderHttpError(input: {
  provider: 'gemini' | 'glm';
  model: string;
  status: number;
  body: string;
  retryAfterHeader?: string | null;
}): ProviderErrorDetails {
  const json = safeJson(input.body);
  const quota = quotaFromJson(json);
  let retryAfterMs = 0;
  const raw = input.retryAfterHeader?.trim();
  if (raw) {
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec > 0) retryAfterMs = sec * 1000;
    else {
      const date = Date.parse(raw);
      if (Number.isFinite(date) && date > Date.now()) retryAfterMs = date - Date.now();
    }
  }
  retryAfterMs = Math.max(retryAfterMs, retryDelayFromBody(json, input.body));

  const haystack = `${quota.metric ?? ''} ${quota.id ?? ''} ${input.body}`;
  let classification: ProviderErrorClass = 'UNKNOWN';
  if (input.status === 401) classification = 'AUTH_401';
  else if (input.status === 403) classification = 'AUTH_403';
  else if (input.status === 400) classification = 'INVALID_REQUEST_400';
  else if (input.status === 404) classification = 'NOT_FOUND_404';
  else if (input.status >= 500) classification = 'PROVIDER_5XX';
  else if (input.status === 429) {
    if (/PerDay|per day|daily quota|GenerateRequestsPerDay/i.test(haystack)) classification = 'DAILY_QUOTA_429';
    else if (/PerModel|model quota|model.*limit/i.test(haystack) && !/PerMinute|PerSecond|rate/i.test(haystack)) classification = 'MODEL_QUOTA_429';
    else classification = 'TEMP_RATE_LIMIT_429';
  }

  const providerMessage = json?.error?.message ?? json?.message ?? json?.detail ?? input.body;
  return {
    provider: input.provider,
    model: input.model,
    status: input.status,
    classification,
    retryAfterMs,
    quotaMetric: quota.metric,
    quotaId: quota.id,
    quotaDimensions: quota.dimensions,
    message: String(providerMessage ?? '').slice(0, 1000),
    bodySnippet: input.body.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]').slice(0, 1400)
  };
}

export function classifyUnknownProviderError(provider: 'gemini' | 'glm', model: string, error: unknown): ProviderErrorDetails {
  const message = error instanceof Error ? error.message : String(error);
  return {
    provider,
    model,
    status: null,
    classification: 'NETWORK',
    retryAfterMs: 0,
    quotaMetric: null,
    quotaId: null,
    quotaDimensions: null,
    message: message.slice(0, 1000),
    bodySnippet: message.slice(0, 1400)
  };
}

export async function appendProviderDiagnostic(details: ProviderErrorDetails, batchStart: number | null, batchEnd: number | null, attempt: number) {
  const record: ProviderDiagnosticRecord = {
    ...details,
    timestamp: new Date().toISOString(),
    batchStart,
    batchEnd,
    attempt
  };
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.appendFile(FILE, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function readProviderDiagnostics(limit = 100) {
  try {
    const text = await fs.readFile(FILE, 'utf8');
    const rows = text.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as ProviderDiagnosticRecord]; } catch { return []; }
    });
    return rows.slice(-Math.max(1, Math.min(1000, limit))).reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function providerDiagnosticsPath() { return FILE; }
