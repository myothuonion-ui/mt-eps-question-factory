import { randomUUID } from 'node:crypto';
import { CHAPTERS } from '../../src/shared/chapters.js';
import type { ListeningScriptLine, NormalizedQuestion, QuestionType } from '../../src/shared/types.js';
import { getProviderSettings } from '../providerSettings.js';
import {
  clearRateLimit,
  earliestCooldownMs,
  isRateLimitError,
  providerCooldownMs,
  registerRateLimit,
  waitForCooldown,
  waitForProviderSlot
} from './requestQueue.js';

export type GenerationSpec = {
  slot: number;
  section: 'listening' | 'reading';
  expectedType: QuestionType;
  patternId: string;
  chapter: number;
  sourceExamples?: NormalizedQuestion[];
  listeningContext?: string | null;
  mediaConstrained?: boolean;
  preserveQuestion?: NormalizedQuestion | null;
  mode?: 'entire' | 'choices' | 'explanation' | 'script';
};

export type ProviderAttemptEvent = {
  provider: string;
  fallback: boolean;
  level: 'info' | 'warn';
  message: string;
};

type AiQuestionPayload = {
  slot?: number;
  stem: string;
  options: string[];
  correctAnswerIndex: number;
  explanation?: string;
  listeningScript?: ListeningScriptLine[];
};

type ProviderName = 'gemini' | 'glm' | 'mock';
type RealProviderName = Exclude<ProviderName, 'mock'>;

function jsonValue(text: string) {
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const objectStart = cleaned.indexOf('{');
  const arrayStart = cleaned.indexOf('[');
  let start = -1;
  let end = -1;
  if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
    start = objectStart; end = cleaned.lastIndexOf('}');
  } else if (arrayStart >= 0) {
    start = arrayStart; end = cleaned.lastIndexOf(']');
  }
  if (start < 0 || end < start) throw new Error('AI response did not contain JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function exampleFor(q: NormalizedQuestion, i: number) {
  return { example: i + 1, type: q.type, stem: q.stem, options: q.options, answer: q.correctAnswerIndex };
}

function specInput(spec: GenerationSpec) {
  return {
    slot: spec.slot,
    section: spec.section,
    patternId: spec.patternId,
    questionType: spec.expectedType,
    chapter: spec.chapter,
    chapterTitle: CHAPTERS[spec.chapter - 1] ?? `Chapter ${spec.chapter}`,
    sourcePatternExamples: (spec.sourceExamples ?? []).slice(0, 3).map(exampleFor),
    listeningContext: spec.listeningContext?.trim().slice(0, 6500) || null,
    mediaConstrained: !!spec.mediaConstrained,
    existingQuestion: spec.preserveQuestion ?? null,
    regenerationMode: spec.mode ?? 'entire'
  };
}

function batchPrompt(specs: GenerationSpec[]) {
  return `You produce original EPS-TOPIK Korean practice questions for a teacher's private question factory.
Return JSON only in this exact outer shape: {"questions":[...]}.
Create exactly one output object for every input item and keep the same slot number.
Rules for every question:
- Natural Korean appropriate for EPS-TOPIK learners.
- Exactly 4 non-empty options and exactly one unambiguous correct answer.
- correctAnswerIndex must be 0, 1, 2, or 3.
- Source questions are references for structure/difficulty. Do not simply copy their wording.
- explanation must be concise Burmese plus the key Korean reasoning.
- Listening: when listeningContext is present, the answer MUST be supported by that transcript and must not invent facts absent from it.
- Listening with mediaConstrained=true but no transcript: stay conservative and preserve the underlying factual meaning of the closest source example.
- Listening without original media grounding: include listeningScript using speaker narrator|male|female.
- Respect regenerationMode and existingQuestion when present.
- No markdown and no commentary outside JSON.
Each question object schema: {"slot":1,"stem":"...","options":["...","...","...","..."],"correctAnswerIndex":0,"explanation":"...","listeningScript":[{"speaker":"male","text":"..."}]}.
INPUT ITEMS:\n${JSON.stringify(specs.map(specInput))}`;
}

function validatePayload(raw: unknown): AiQuestionPayload {
  if (!raw || typeof raw !== 'object') throw new Error('AI payload is not an object.');
  const value = raw as Record<string, unknown>;
  if (typeof value.stem !== 'string' || !value.stem.trim()) throw new Error('AI payload is missing a question stem.');
  if (!Array.isArray(value.options) || value.options.length !== 4 || value.options.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('AI payload must contain exactly four non-empty string options.');
  }
  const answer = Number(value.correctAnswerIndex);
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) throw new Error('AI payload correctAnswerIndex must be 0-3.');
  const script = Array.isArray(value.listeningScript)
    ? value.listeningScript.filter((line): line is ListeningScriptLine => {
        if (!line || typeof line !== 'object') return false;
        const row = line as Record<string, unknown>;
        return ['narrator', 'male', 'female'].includes(String(row.speaker)) && typeof row.text === 'string';
      }).map(line => ({ speaker: line.speaker, text: line.text.trim() })).filter(line => line.text)
    : undefined;
  return {
    slot: Number.isInteger(Number(value.slot)) ? Number(value.slot) : undefined,
    stem: value.stem.trim(),
    options: (value.options as string[]).map(item => item.trim()),
    correctAnswerIndex: answer,
    explanation: typeof value.explanation === 'string' ? value.explanation.trim() : undefined,
    listeningScript: script
  };
}

function validateBatch(raw: unknown, specs: GenerationSpec[]) {
  const container = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const items = Array.isArray(raw) ? raw : Array.isArray(container?.questions) ? container!.questions : [];
  if (items.length !== specs.length) throw new Error(`AI returned ${items.length} questions; expected ${specs.length}.`);
  const payloads = items.map(validatePayload);
  const bySlot = new Map(payloads.filter(p => p.slot).map(p => [p.slot!, p]));
  return specs.map((spec, index) => bySlot.get(spec.slot) ?? payloads[index]);
}

function retryAfterFromResponse(response: Response, body: string) {
  const raw = response.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  }
  const match = body.match(/"retryDelay"\s*:\s*"([0-9]+(?:\.[0-9]+)?)s"/i)
    ?? body.match(/retry(?:Delay|[_ -]?after| in)[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)\s*s/i);
  return match ? Math.ceil(Number(match[1]) * 1000) : 0;
}

function providerHttpError(provider: string, response: Response, body: string) {
  const error = new Error(`${provider} failed: HTTP ${response.status} ${body}`);
  (error as any).status = response.status;
  const retryAfter = retryAfterFromResponse(response, body);
  if (retryAfter > 0) (error as any).retryAfterMs = retryAfter;
  return error;
}

async function callGemini(specs: GenerationSpec[]) {
  const settings = getProviderSettings();
  const key = process.env.GEMINI_API_KEY ?? '';
  if (!key) throw new Error('Gemini API key is not configured.');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.gemini.model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: batchPrompt(specs) }] }],
      generationConfig: { temperature: 0.55, responseMimeType: 'application/json' }
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw providerHttpError('Gemini', response, text);
  }
  const json = await response.json() as any;
  const text = json?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? '').join('');
  if (typeof text !== 'string' || !text) throw new Error('Gemini returned no content.');
  return validateBatch(jsonValue(text), specs);
}

async function callGlm(specs: GenerationSpec[]) {
  const settings = getProviderSettings();
  const base = settings.glm.baseUrl.replace(/\/$/, '');
  const key = process.env.GLM_API_KEY ?? process.env.AI_API_KEY ?? '';
  if (!base || !key || !settings.glm.model) throw new Error('GLM API settings are not configured.');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: settings.glm.model,
      temperature: 0.55,
      messages: [{ role: 'user', content: batchPrompt(specs) }]
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw providerHttpError('GLM', response, text);
  }
  const json = await response.json() as any;
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) throw new Error('GLM returned no content.');
  return validateBatch(jsonValue(text), specs);
}

function mockPayload(spec: GenerationSpec): AiQuestionPayload {
  const title = CHAPTERS[spec.chapter - 1] ?? `제${spec.chapter}과`;
  const listening = spec.section === 'listening';
  return {
    slot: spec.slot,
    stem: listening ? '들은 내용과 알맞은 것을 고르십시오.' : `${title}와 관련된 내용으로 알맞은 것을 고르십시오.`,
    options: ['안내 사항을 확인합니다.', '아무 준비 없이 시작합니다.', '필요한 물건을 버립니다.', '작업 내용을 확인하지 않습니다.'],
    correctAnswerIndex: 0,
    explanation: 'Local mock mode စမ်းသပ်မေးခွန်းဖြစ်သည်။ API provider ကို Settings မှာ ထည့်နိုင်ပါသည်။',
    listeningScript: listening ? [
      { speaker: 'male', text: `${title}와 관련된 일을 시작하기 전에 무엇을 확인해야 합니까?` },
      { speaker: 'female', text: '먼저 안내 사항을 확인하고 필요한 준비를 하겠습니다.' }
    ] : undefined
  };
}

function providerSequence(): ProviderName[] {
  const settings = getProviderSettings();
  switch (settings.order) {
    case 'gemini-glm': return ['gemini', 'glm'];
    case 'glm-gemini': return ['glm', 'gemini'];
    case 'gemini': return ['gemini'];
    case 'glm': return ['glm'];
    default: return ['mock'];
  }
}

function configured(provider: ProviderName) {
  const settings = getProviderSettings();
  if (provider === 'gemini') return settings.gemini.configured;
  if (provider === 'glm') return settings.glm.configured;
  return true;
}

async function callProvider(provider: ProviderName, specs: GenerationSpec[]) {
  if (provider === 'gemini') return callGemini(specs);
  if (provider === 'glm') return callGlm(specs);
  return specs.map(mockPayload);
}

function shortError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/Gemini failed: HTTP 429/i.test(text)) return 'Gemini is temporarily rate-limited (HTTP 429).';
  if (/GLM failed: HTTP 429|Too Many Requests/i.test(text)) return 'GLM is temporarily rate-limited (HTTP 429).';
  return text.length > 260 ? `${text.slice(0, 257)}...` : text;
}

function toQuestion(spec: GenerationSpec, payload: AiQuestionPayload, provider: string): NormalizedQuestion {
  const preserved = spec.preserveQuestion;
  const next = spec.mode === 'choices' && preserved
    ? { ...preserved, options: payload.options, correctAnswerIndex: payload.correctAnswerIndex, explanation: payload.explanation ?? preserved.explanation }
    : spec.mode === 'explanation' && preserved
      ? { ...preserved, explanation: payload.explanation }
      : spec.mode === 'script' && preserved
        ? { ...preserved, listeningScript: payload.listeningScript }
        : {
            id: preserved?.id ?? `GEN-${randomUUID()}`,
            sourceOrder: spec.slot,
            stem: payload.stem,
            options: payload.options,
            correctAnswerIndex: payload.correctAnswerIndex,
            explanation: payload.explanation ?? null,
            type: spec.expectedType,
            chapter: { chapter: spec.chapter, title: CHAPTERS[spec.chapter - 1] ?? null, confidence: 1, reason: 'Generator target chapter' },
            patternId: spec.patternId,
            media: [],
            listeningScript: payload.listeningScript,
            audioAsset: null,
            qaFlags: [],
            origin: 'generated' as const,
            generatedBy: provider,
            revision: preserved?.revision ?? 1,
            reviewState: 'not_reviewed' as const,
            provenance: { sourceUrl: 'local://generated', sourceTitle: 'MT EPS Question Factory', sourceQuestionId: preserved?.id ?? null }
          };
  return {
    ...next,
    id: next.id ?? `GEN-${randomUUID()}`,
    sourceOrder: next.sourceOrder ?? spec.slot,
    type: next.type ?? spec.expectedType,
    patternId: spec.patternId,
    chapter: next.chapter ?? { chapter: spec.chapter, title: CHAPTERS[spec.chapter - 1] ?? null, confidence: 1, reason: 'Generator target chapter' },
    media: next.media ?? [],
    qaFlags: [...new Set([...(next.qaFlags ?? []), ...(provider === 'mock' ? ['MOCK_PROVIDER'] : [])])],
    origin: next.origin ?? 'generated',
    generatedBy: provider,
    revision: (preserved?.revision ?? 0) + 1,
    reviewState: preserved?.reviewState ?? 'not_reviewed',
    provenance: next.provenance ?? { sourceUrl: 'local://generated', sourceTitle: 'MT EPS Question Factory' }
  } as NormalizedQuestion;
}

export function activeAiProviderName() {
  const settings = getProviderSettings();
  return settings.order.replace('gemini-glm', 'gemini→glm').replace('glm-gemini', 'glm→gemini');
}

function maxRateLimitWaitMs() {
  const value = Number(process.env.AI_RATE_LIMIT_MAX_WAIT_MS ?? 12 * 60_000);
  return Number.isFinite(value) ? Math.max(30_000, Math.min(60 * 60_000, Math.round(value))) : 12 * 60_000;
}

export async function generateQuestionBatch(specs: GenerationSpec[], onAttempt?: (event: ProviderAttemptEvent) => void) {
  const sequence = providerSequence();
  if (sequence.length === 1 && sequence[0] === 'mock') {
    return specs.map(spec => toQuestion(spec, mockPayload(spec), 'mock'));
  }

  const realProviders = sequence.filter((provider): provider is RealProviderName => provider !== 'mock' && configured(provider));
  if (!realProviders.length) throw new Error('No AI provider is configured. Add Gemini or GLM in API Keys.');

  const startedAt = Date.now();
  let lastError: unknown = null;
  let cycle = 0;

  while (Date.now() - startedAt < maxRateLimitWaitMs()) {
    cycle += 1;
    let sawRateLimit = false;
    let attemptedProvider = false;

    for (let index = 0; index < sequence.length; index += 1) {
      const provider = sequence[index];
      if (provider === 'mock') continue;
      if (!configured(provider)) {
        onAttempt?.({ provider, fallback: index > 0, level: 'warn', message: `${provider.toUpperCase()} is not configured; skipping it.` });
        continue;
      }

      const cooldown = providerCooldownMs(provider);
      if (cooldown > 0) {
        sawRateLimit = true;
        onAttempt?.({
          provider,
          fallback: true,
          level: 'info',
          message: `${provider.toUpperCase()} is cooling down. Checking another provider first; ${Math.ceil(cooldown / 1000)}s remain.`
        });
        continue;
      }

      attemptedProvider = true;
      try {
        await waitForProviderSlot(provider, (seconds, reason) => {
          onAttempt?.({
            provider,
            fallback: index > 0,
            level: 'info',
            message: `Queue · ${reason}. Waiting ${seconds}s before Q${specs[0].slot}–Q${specs[specs.length - 1].slot}.`
          });
        });
        onAttempt?.({ provider, fallback: index > 0, level: 'info', message: `Using ${provider.toUpperCase()} for Q${specs[0].slot}–Q${specs[specs.length - 1].slot}.` });
        const payloads = await callProvider(provider, specs);
        clearRateLimit(provider);
        return specs.map((spec, i) => toQuestion(spec, payloads[i], provider));
      } catch (error) {
        lastError = error;
        if (isRateLimitError(error)) {
          sawRateLimit = true;
          const cooldownMs = registerRateLimit(provider, error);
          const hasOther = realProviders.some(other => other !== provider && providerCooldownMs(other) === 0);
          onAttempt?.({
            provider,
            fallback: true,
            level: 'warn',
            message: `${shortError(error)} ${provider.toUpperCase()} paused for ${Math.ceil(cooldownMs / 1000)}s.${hasOther ? ' Trying the next provider now.' : ''}`
          });
          continue;
        }

        const hasNext = sequence.slice(index + 1).some(item => item !== 'mock' && configured(item));
        onAttempt?.({ provider, fallback: hasNext, level: 'warn', message: `${shortError(error)}${hasNext ? ' Falling back automatically.' : ''}` });
        if (!hasNext) throw error;
      }
    }

    if (!sawRateLimit) break;

    const waitMs = earliestCooldownMs(realProviders);
    if (waitMs <= 0 && attemptedProvider) continue;
    const elapsed = Date.now() - startedAt;
    if (elapsed + waitMs > maxRateLimitWaitMs()) break;

    onAttempt?.({
      provider: 'queue',
      fallback: true,
      level: 'info',
      message: `All configured AI providers are rate-limited. Job is paused, not failed. Retrying in ${Math.max(1, Math.ceil(waitMs / 1000))}s (queue cycle ${cycle}).`
    });
    await waitForCooldown(waitMs);
  }

  const raw = shortError(lastError ?? new Error('AI providers did not become available.'));
  if (isRateLimitError(lastError)) {
    throw new Error(`${raw} The job waited for provider cooldowns but the configured APIs stayed rate-limited. Retry later or use another API key/provider.`);
  }
  throw new Error(raw);
}

export async function generateQuestion(spec: GenerationSpec): Promise<NormalizedQuestion> {
  return (await generateQuestionBatch([spec]))[0];
}
