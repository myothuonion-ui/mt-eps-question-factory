type ProviderName = 'gemini' | 'glm';

type ProviderState = {
  nextAllowedAt: number;
  cooldownUntil: number;
  consecutive429: number;
  last429At: number;
};

const states: Record<ProviderName, ProviderState> = {
  gemini: { nextAllowedAt: 0, cooldownUntil: 0, consecutive429: 0, last429At: 0 },
  glm: { nextAllowedAt: 0, cooldownUntil: 0, consecutive429: 0, last429At: 0 }
};

let globalNextAllowedAt = 0;
let gate: Promise<void> = Promise.resolve();

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function numberEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function providerMinInterval(provider: ProviderName) {
  const common = numberEnv('AI_MIN_REQUEST_INTERVAL_MS', 3000, 0, 60_000);
  if (provider === 'gemini') return numberEnv('GEMINI_MIN_REQUEST_INTERVAL_MS', Math.max(common, 6500), 0, 60_000);
  return numberEnv('GLM_MIN_REQUEST_INTERVAL_MS', Math.max(common, 4500), 0, 60_000);
}

function globalMinInterval() {
  return numberEnv('AI_GLOBAL_MIN_REQUEST_INTERVAL_MS', 1500, 0, 60_000);
}

function parseDurationText(text: string) {
  const matches = [...text.matchAll(/(?:retryDelay|retry[_ -]?after|retry in)[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)/gi)];
  if (!matches.length) return 0;
  const values = matches.map(match => {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(value)) return 0;
    if (unit.startsWith('ms')) return value;
    if (unit.startsWith('m')) return value * 60_000;
    return value * 1000;
  });
  return Math.max(...values, 0);
}

export function retryAfterMs(error: unknown) {
  const anyError = error as any;
  const explicit = Number(anyError?.retryAfterMs ?? anyError?.details?.retryAfterMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const text = error instanceof Error ? error.message : String(error ?? '');
  return parseDurationText(text);
}

export function isRateLimitError(error: unknown) {
  const anyError = error as any;
  const status = Number(anyError?.status ?? anyError?.details?.status ?? 0);
  const classification = String(anyError?.details?.classification ?? '');
  const text = error instanceof Error ? error.message : String(error ?? '');
  return status === 429 || classification.endsWith('_429') || /\b429\b|too many requests|resource_exhausted|quota\/rate limit|rate limit/i.test(text);
}

function quotaClass(error: unknown) {
  return String((error as any)?.details?.classification ?? '');
}

export function registerRateLimit(provider: ProviderName, error: unknown) {
  const state = states[provider];
  const now = Date.now();
  state.consecutive429 = state.last429At && now - state.last429At < 10 * 60_000 ? state.consecutive429 + 1 : 1;
  state.last429At = now;

  const serverRetry = retryAfterMs(error);
  const exponential = Math.min(90_000, 8_000 * (2 ** Math.min(4, state.consecutive429 - 1)));
  const classification = quotaClass(error);
  const classFloor = classification === 'DAILY_QUOTA_429'
    ? 6 * 60 * 60_000
    : classification === 'MODEL_QUOTA_429'
      ? 30 * 60_000
      : 0;
  const cooldown = Math.max(serverRetry, exponential, classFloor, 5_000);
  state.cooldownUntil = Math.max(state.cooldownUntil, now + cooldown);
  return cooldown;
}

export function clearRateLimit(provider: ProviderName) {
  const state = states[provider];
  state.consecutive429 = 0;
  state.cooldownUntil = 0;
  state.last429At = 0;
}

export function providerCooldownMs(provider: ProviderName) {
  return Math.max(0, states[provider].cooldownUntil - Date.now());
}

export function earliestCooldownMs(providers: ProviderName[]) {
  const waits = providers.map(providerCooldownMs).filter(ms => ms > 0);
  return waits.length ? Math.min(...waits) : 0;
}

export async function waitForProviderSlot(provider: ProviderName, onWait?: (seconds: number, reason: string) => void) {
  let release!: () => void;
  const previous = gate;
  gate = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const now = Date.now();
    const state = states[provider];
    const waitMs = Math.max(0, state.cooldownUntil - now, state.nextAllowedAt - now, globalNextAllowedAt - now);
    if (waitMs > 0) {
      onWait?.(Math.max(1, Math.ceil(waitMs / 1000)), state.cooldownUntil > now ? `${provider.toUpperCase()} cooldown` : 'request pacing');
      await sleep(waitMs);
    }
    const sentAt = Date.now();
    state.nextAllowedAt = sentAt + providerMinInterval(provider);
    globalNextAllowedAt = sentAt + globalMinInterval();
  } finally {
    release();
  }
}

export async function waitForCooldown(ms: number, onTick?: (seconds: number) => void) {
  let remaining = Math.max(0, ms);
  while (remaining > 0) {
    const chunk = Math.min(1000, remaining);
    onTick?.(Math.max(1, Math.ceil(remaining / 1000)));
    await sleep(chunk);
    remaining -= chunk;
  }
}

export function queueSnapshot() {
  const now = Date.now();
  return {
    gemini: { cooldownMs: Math.max(0, states.gemini.cooldownUntil - now), consecutive429: states.gemini.consecutive429 },
    glm: { cooldownMs: Math.max(0, states.glm.cooldownUntil - now), consecutive429: states.glm.consecutive429 }
  };
}
