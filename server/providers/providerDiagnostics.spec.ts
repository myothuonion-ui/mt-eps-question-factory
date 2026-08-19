import { classifyProviderHttpError } from './providerDiagnostics.js';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const daily = classifyProviderHttpError({
  provider: 'gemini', model: 'gemini-2.5-flash', status: 429,
  body: JSON.stringify({ error: { message: 'Quota exceeded', details: [{ violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model: 'gemini-2.5-flash' } }] }, { retryDelay: '53s' }] } })
});
assert(daily.classification === 'DAILY_QUOTA_429', 'Per-day quota must classify as DAILY_QUOTA_429');
assert(daily.retryAfterMs === 53000, 'Retry delay must be parsed');

const temp = classifyProviderHttpError({ provider: 'gemini', model: 'gemini-2.5-flash', status: 429, body: '{"error":{"message":"Too Many Requests"}}', retryAfterHeader: '12' });
assert(temp.classification === 'TEMP_RATE_LIMIT_429', 'Generic 429 must be temporary rate limit');
assert(temp.retryAfterMs === 12000, 'Retry-After header must be parsed');

const auth = classifyProviderHttpError({ provider: 'glm', model: 'z-ai/glm-5.2', status: 401, body: '{"detail":"Authentication failed"}' });
assert(auth.classification === 'AUTH_401', '401 must classify as AUTH_401');

console.log('provider diagnostics classification: PASS');
