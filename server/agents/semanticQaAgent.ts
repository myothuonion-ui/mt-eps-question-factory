import type { ExamSlot, NormalizedQuestion } from '../../src/shared/types.js';
import { getProviderSettings } from '../providerSettings.js';
import type { ProgressEvent } from '../jobManager.js';
import {
  appendProviderDiagnostic,
  classifyProviderHttpError,
  classifyUnknownProviderError,
  type ProviderErrorDetails
} from '../providers/providerDiagnostics.js';

export type SemanticVerdict = {
  slot: number;
  answerCorrect: boolean;
  unambiguous: boolean;
  koreanNatural: boolean;
  sectionFit: boolean;
  explanationCorrect: boolean;
  suggestedAnswerIndex: number | null;
  confidence: number;
  issues: string[];
};

type Verifier = 'gemini' | 'glm';
type QaError = Error & { details?: ProviderErrorDetails; status?: number; retryAfterMs?: number };

function parseJson(text: string) {
  const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const objectStart = clean.indexOf('{');
  const arrayStart = clean.indexOf('[');
  let start = -1;
  let end = -1;
  if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) { start = objectStart; end = clean.lastIndexOf('}'); }
  else if (arrayStart >= 0) { start = arrayStart; end = clean.lastIndexOf(']'); }
  if (start < 0 || end < start) throw new Error('QA verifier returned no JSON.');
  return JSON.parse(clean.slice(start, end + 1));
}

function questionPayload(slot: ExamSlot) {
  const q = slot.question!;
  return {
    slot: slot.slot,
    section: slot.section,
    patternId: slot.patternId,
    stem: q.stem,
    options: q.options,
    correctAnswerIndex: q.correctAnswerIndex,
    explanation: q.explanation ?? null,
    listeningScript: q.listeningScript ?? null,
    chapter: q.chapter.chapter
  };
}

function prompt(slots: ExamSlot[]) {
  return `You are the independent final QA verifier for EPS-TOPIK Korean practice questions created for Myanmar learners.
Return JSON only: {"results":[...]}. Return exactly one result per input slot.
Do NOT rewrite the question. Verify it independently.
For each item check:
1. The marked correct answer is actually supported by the Korean question/passage/listening script.
2. Exactly one option is clearly best; no ambiguous second answer.
3. Korean wording and grammar are natural and appropriate for EPS-TOPIK.
4. Reading items are genuinely Reading/text questions; Listening items are supported by their listening script/context when a script is supplied.
5. The Burmese/Korean explanation is consistent with the correct answer.
If the marked answer is wrong, suggestedAnswerIndex must be the best 0-based index; otherwise use null.
confidence is 0..1. issues must be short machine-friendly strings such as ANSWER_WRONG, AMBIGUOUS, KOREAN_UNNATURAL, SECTION_MISMATCH, EXPLANATION_MISMATCH, LISTENING_NOT_GROUNDED.
Schema: {"slot":1,"answerCorrect":true,"unambiguous":true,"koreanNatural":true,"sectionFit":true,"explanationCorrect":true,"suggestedAnswerIndex":null,"confidence":0.96,"issues":[]}.
INPUT:\n${JSON.stringify(slots.map(questionPayload))}`;
}

function validate(raw: unknown, expected: ExamSlot[]): SemanticVerdict[] {
  const container = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const rows = Array.isArray(raw) ? raw : Array.isArray(container?.results) ? container!.results : [];
  const bySlot = new Map<number, SemanticVerdict>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const v = row as Record<string, unknown>;
    const slot = Number(v.slot);
    if (!Number.isInteger(slot)) continue;
    const suggestedRaw = v.suggestedAnswerIndex;
    const suggested = suggestedRaw === null || suggestedRaw === undefined ? null : Number(suggestedRaw);
    bySlot.set(slot, {
      slot,
      answerCorrect: v.answerCorrect === true,
      unambiguous: v.unambiguous === true,
      koreanNatural: v.koreanNatural === true,
      sectionFit: v.sectionFit === true,
      explanationCorrect: v.explanationCorrect === true,
      suggestedAnswerIndex: suggested !== null && Number.isInteger(suggested) && suggested >= 0 && suggested <= 3 ? suggested : null,
      confidence: Math.max(0, Math.min(1, Number(v.confidence ?? 0))),
      issues: Array.isArray(v.issues) ? v.issues.map(String).filter(Boolean).slice(0, 12) : []
    });
  }
  return expected.flatMap(slot => bySlot.has(slot.slot) ? [bySlot.get(slot.slot)!] : []);
}

function httpError(provider: Verifier, model: string, response: Response, body: string): QaError {
  const details = classifyProviderHttpError({ provider, model, status: response.status, body, retryAfterHeader: response.headers.get('retry-after') });
  const error = new Error(`${provider.toUpperCase()} QA ${details.classification} HTTP ${response.status}: ${details.message}`) as QaError;
  error.status = response.status;
  error.retryAfterMs = details.retryAfterMs;
  error.details = details;
  return error;
}

async function callGemini(slots: ExamSlot[]) {
  const settings = getProviderSettings();
  const key = process.env.GEMINI_API_KEY ?? '';
  if (!key || !settings.gemini.configured) throw new Error('Gemini QA verifier is not configured.');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.gemini.model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt(slots) }] }], generationConfig: { temperature: 0.05, responseMimeType: 'application/json' } })
  });
  if (!response.ok) {
    const body = await response.text();
    throw httpError('gemini', settings.gemini.model, response, body);
  }
  const json = await response.json() as any;
  const text = json?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? '').join('');
  if (!text) throw new Error('Gemini QA returned no content.');
  return validate(parseJson(text), slots);
}

async function callGlm(slots: ExamSlot[]) {
  const settings = getProviderSettings();
  const key = process.env.GLM_API_KEY ?? process.env.AI_API_KEY ?? '';
  const base = settings.glm.baseUrl.replace(/\/$/, '');
  if (!key || !base || !settings.glm.model) throw new Error('GLM QA verifier is not configured.');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: settings.glm.model, temperature: 0.05, messages: [{ role: 'user', content: prompt(slots) }] })
  });
  if (!response.ok) {
    const body = await response.text();
    throw httpError('glm', settings.glm.model, response, body);
  }
  const json = await response.json() as any;
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('GLM QA returned no content.');
  return validate(parseJson(text), slots);
}

function verifierOrder(slots: ExamSlot[]): Verifier[] {
  const settings = getProviderSettings();
  const gemini = settings.gemini.configured;
  const glm = settings.glm.configured;
  if (!gemini && !glm) return [];
  const generatedByGemini = slots.filter(slot => slot.question?.generatedBy === 'gemini').length;
  const generatedByGlm = slots.filter(slot => slot.question?.generatedBy === 'glm').length;
  if (generatedByGlm >= generatedByGemini && gemini) return glm ? ['gemini', 'glm'] : ['gemini'];
  if (generatedByGemini > generatedByGlm && glm) return gemini ? ['glm', 'gemini'] : ['glm'];
  return gemini ? (glm ? ['gemini', 'glm'] : ['gemini']) : ['glm'];
}

function exactMessage(provider: Verifier, error: unknown) {
  const attached = (error as QaError)?.details;
  const settings = getProviderSettings();
  const details = attached ?? classifyUnknownProviderError(provider, provider === 'gemini' ? settings.gemini.model : settings.glm.model, error);
  if (details.classification === 'AUTH_401' || details.classification === 'AUTH_403') return `${provider.toUpperCase()} QA authentication failed · ${details.classification}.`;
  if (details.classification === 'DAILY_QUOTA_429') return `${provider.toUpperCase()} QA daily quota reached · ${details.quotaId ?? 'per-day quota'}.`;
  if (details.classification === 'TEMP_RATE_LIMIT_429') return `${provider.toUpperCase()} QA temporary rate limit · retry ${details.retryAfterMs ? `${Math.ceil(details.retryAfterMs / 1000)}s` : 'later'}.`;
  return `${provider.toUpperCase()} QA ${details.classification} · ${details.message}`;
}

async function verifyBatch(slots: ExamSlot[], report?: (event: ProgressEvent) => void) {
  const order = verifierOrder(slots);
  if (!order.length) return { verdicts: [] as SemanticVerdict[], provider: null as string | null, skipped: 'No independent AI verifier configured.' };
  let lastError = '';
  let attempt = 0;
  for (const verifier of order) {
    attempt += 1;
    try {
      report?.({ stage: 'qa', agent: 'QA Agent', question: slots[0]?.slot ?? null, provider: verifier, message: `Independent semantic QA Q${slots[0]?.slot}–Q${slots[slots.length - 1]?.slot} with ${verifier.toUpperCase()}.` });
      const verdicts = verifier === 'gemini' ? await callGemini(slots) : await callGlm(slots);
      if (verdicts.length !== slots.length) throw new Error(`${verifier} returned ${verdicts.length}/${slots.length} QA verdicts.`);
      return { verdicts, provider: verifier, skipped: null };
    } catch (error) {
      const settings = getProviderSettings();
      const attached = (error as QaError)?.details;
      const details = attached ?? classifyUnknownProviderError(verifier, verifier === 'gemini' ? settings.gemini.model : settings.glm.model, error);
      await appendProviderDiagnostic(details, slots[0]?.slot ?? null, slots[slots.length - 1]?.slot ?? null, attempt);
      lastError = exactMessage(verifier, error);
      report?.({ stage: 'qa', agent: 'QA Agent', question: slots[0]?.slot ?? null, provider: verifier, level: 'warn', fallback: true, message: `${lastError} Trying fallback when available. Exact sanitized details saved to data/diagnostics/provider-errors.jsonl.` });
    }
  }
  return { verdicts: [] as SemanticVerdict[], provider: null as string | null, skipped: lastError || 'Semantic QA unavailable.' };
}

function applyVerdict(question: NormalizedQuestion, verdict: SemanticVerdict, provider: string) {
  const flags = [...question.qaFlags];
  for (const issue of verdict.issues) flags.push(`AI_QA_${issue.replace(/[^A-Z0-9_]/gi, '_').toUpperCase()}`);
  if (!verdict.answerCorrect && verdict.suggestedAnswerIndex !== null && verdict.confidence >= 0.88) {
    question.correctAnswerIndex = verdict.suggestedAnswerIndex;
    flags.push(`AI_QA_ANSWER_CORRECTED_BY_${provider.toUpperCase()}`);
  } else if (!verdict.answerCorrect) flags.push('AI_QA_ANSWER_UNCERTAIN');
  if (!verdict.unambiguous) flags.push('AI_QA_AMBIGUOUS');
  if (!verdict.koreanNatural) flags.push('AI_QA_KOREAN_UNNATURAL');
  if (!verdict.sectionFit) flags.push('AI_QA_SECTION_MISMATCH');
  if (!verdict.explanationCorrect) flags.push('AI_QA_EXPLANATION_MISMATCH');
  question.qaFlags = [...new Set(flags)];
  return question;
}

export async function runSemanticQaAgent(slots: ExamSlot[], report?: (event: ProgressEvent) => void) {
  const populated = slots.filter(slot => !!slot.question);
  const batchSize = 10;
  let verified = 0;
  let skippedReason: string | null = null;
  for (let start = 0; start < populated.length; start += batchSize) {
    const batch = populated.slice(start, start + batchSize);
    const result = await verifyBatch(batch, report);
    if (!result.provider || !result.verdicts.length) {
      skippedReason = result.skipped;
      continue;
    }
    const bySlot = new Map(result.verdicts.map(verdict => [verdict.slot, verdict]));
    for (const slot of batch) {
      const verdict = bySlot.get(slot.slot);
      if (!slot.question || !verdict) continue;
      slot.question = applyVerdict(slot.question, verdict, result.provider);
      verified += 1;
      report?.({
        stage: 'qa', agent: 'QA Agent', question: slot.slot, provider: result.provider,
        level: verdict.answerCorrect && verdict.unambiguous && verdict.koreanNatural && verdict.sectionFit ? 'success' : 'warn',
        message: `Q${slot.slot}: semantic QA ${Math.round(verdict.confidence * 100)}% · ${verdict.issues.length ? verdict.issues.join(', ') : 'PASS'}.`
      });
    }
  }
  if (!verified) {
    report?.({ stage: 'qa', agent: 'QA Agent', question: null, level: 'warn', message: `Semantic AI QA skipped; deterministic QA still runs. ${skippedReason ?? ''}`.trim() });
  } else {
    report?.({ stage: 'qa', agent: 'QA Agent', question: null, level: 'success', message: `Independent semantic QA completed for ${verified}/${populated.length} questions.` });
  }
  return slots;
}
