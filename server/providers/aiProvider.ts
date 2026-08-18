import { randomUUID } from 'node:crypto';
import { CHAPTERS } from '../../src/shared/chapters.js';
import type { ListeningScriptLine, NormalizedQuestion, QuestionType } from '../../src/shared/types.js';

export type GenerationSpec = {
  slot: number;
  section: 'listening' | 'reading';
  expectedType: QuestionType;
  patternId: string;
  chapter: number;
  sourceExamples?: NormalizedQuestion[];
  preserveQuestion?: NormalizedQuestion | null;
  mode?: 'entire' | 'choices' | 'explanation' | 'script';
};

type AiQuestionPayload = {
  stem: string;
  options: string[];
  correctAnswerIndex: number;
  explanation?: string;
  listeningScript?: ListeningScriptLine[];
};

function jsonObject(text: string) {
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI response did not contain JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function promptFor(spec: GenerationSpec) {
  const title = CHAPTERS[spec.chapter - 1] ?? `Chapter ${spec.chapter}`;
  const examples = (spec.sourceExamples ?? []).slice(0, 3).map((q, i) => ({
    example: i + 1,
    type: q.type,
    stem: q.stem,
    options: q.options,
    answer: q.correctAnswerIndex
  }));
  return `You are producing one original EPS-TOPIK Korean exam practice question for a teacher's private question factory.
Return JSON only.
Slot: ${spec.slot}
Section: ${spec.section}
Pattern ID: ${spec.patternId}
Question type: ${spec.expectedType}
Chapter: ${spec.chapter} ${title}
Requirements:
- Natural Korean appropriate for EPS-TOPIK learners.
- Exactly 4 options.
- Exactly one unambiguous correct answer, correctAnswerIndex is 0-3.
- Do not copy source wording; use examples only to learn structure/difficulty.
- explanation should be concise Burmese with key Korean reasoning.
- If listening, include listeningScript as an array of {speaker:"narrator"|"male"|"female",text:string}. Keep it concise and natural.
- If not listening, listeningScript may be omitted.
- No markdown.
Source pattern examples: ${JSON.stringify(examples)}
Existing question to preserve/modify when requested: ${JSON.stringify(spec.preserveQuestion ?? null)}
Requested regeneration mode: ${spec.mode ?? 'entire'}
JSON schema: {"stem":"...","options":["...","...","...","..."],"correctAnswerIndex":0,"explanation":"...","listeningScript":[{"speaker":"male","text":"..."}]}`;
}

function validatePayload(raw: unknown): AiQuestionPayload {
  if (!raw || typeof raw !== 'object') throw new Error('AI payload is not an object.');
  const value = raw as Record<string, unknown>;
  if (typeof value.stem !== 'string' || !value.stem.trim()) throw new Error('AI payload is missing a question stem.');
  if (!Array.isArray(value.options) || value.options.length !== 4 || value.options.some(item => typeof item !== 'string')) {
    throw new Error('AI payload must contain exactly four string options.');
  }
  const answer = Number(value.correctAnswerIndex);
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) throw new Error('AI payload correctAnswerIndex must be 0-3.');
  const script = Array.isArray(value.listeningScript)
    ? value.listeningScript.filter((line): line is ListeningScriptLine => {
        if (!line || typeof line !== 'object') return false;
        const row = line as Record<string, unknown>;
        return ['narrator', 'male', 'female'].includes(String(row.speaker)) && typeof row.text === 'string';
      }).map(line => ({ speaker: line.speaker, text: line.text.trim() }))
    : undefined;
  return {
    stem: value.stem.trim(),
    options: (value.options as string[]).map(item => item.trim()),
    correctAnswerIndex: answer,
    explanation: typeof value.explanation === 'string' ? value.explanation.trim() : undefined,
    listeningScript: script
  };
}

async function generateOpenAiCompatible(spec: GenerationSpec): Promise<AiQuestionPayload> {
  const base = (process.env.AI_BASE_URL ?? '').replace(/\/$/, '');
  const key = process.env.AI_API_KEY ?? '';
  const model = process.env.AI_MODEL ?? '';
  if (!base || !key || !model) throw new Error('AI_BASE_URL, AI_API_KEY and AI_MODEL are required.');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.65,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: promptFor(spec) }]
    })
  });
  if (!response.ok) throw new Error(`AI provider failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json() as any;
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('AI provider returned no content.');
  return validatePayload(jsonObject(text));
}

async function generateGemini(spec: GenerationSpec): Promise<AiQuestionPayload> {
  const key = process.env.GEMINI_API_KEY ?? '';
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  if (!key) throw new Error('GEMINI_API_KEY is required.');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptFor(spec) }] }],
      generationConfig: { temperature: 0.65, responseMimeType: 'application/json' }
    })
  });
  if (!response.ok) throw new Error(`Gemini failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json() as any;
  const text = json?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? '').join('');
  if (typeof text !== 'string' || !text) throw new Error('Gemini returned no content.');
  return validatePayload(jsonObject(text));
}

function mockPayload(spec: GenerationSpec): AiQuestionPayload {
  const title = CHAPTERS[spec.chapter - 1] ?? `제${spec.chapter}과`;
  const listening = spec.section === 'listening';
  const script: ListeningScriptLine[] | undefined = listening ? [
    { speaker: 'male', text: `${title}와 관련된 일을 시작하기 전에 무엇을 확인해야 합니까?` },
    { speaker: 'female', text: '먼저 안내 사항을 확인하고 필요한 준비를 하겠습니다.' }
  ] : undefined;
  return {
    stem: listening ? '들은 내용과 알맞은 것을 고르십시오.' : `${title}와 관련된 내용으로 알맞은 것을 고르십시오.`,
    options: ['안내 사항을 확인합니다.', '아무 준비 없이 시작합니다.', '필요한 물건을 버립니다.', '작업 내용을 확인하지 않습니다.'],
    correctAnswerIndex: 0,
    explanation: 'Local mock mode စမ်းသပ်မေးခွန်းဖြစ်သည်။ API key ထည့်ပြီး AI provider ပြောင်းသုံးပါ။',
    listeningScript: script
  };
}

export function activeAiProviderName() {
  return (process.env.AI_PROVIDER ?? 'mock').toLowerCase();
}

export async function generateQuestion(spec: GenerationSpec): Promise<NormalizedQuestion> {
  const provider = activeAiProviderName();
  const payload = provider === 'gemini'
    ? await generateGemini(spec)
    : provider === 'openai-compatible'
      ? await generateOpenAiCompatible(spec)
      : mockPayload(spec);

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
            chapter: {
              chapter: spec.chapter,
              title: CHAPTERS[spec.chapter - 1] ?? null,
              confidence: 1,
              reason: 'Generator target chapter'
            },
            patternId: spec.patternId,
            media: [],
            listeningScript: payload.listeningScript,
            audioAsset: null,
            qaFlags: [],
            origin: 'generated' as const,
            generatedBy: provider,
            revision: preserved?.revision ?? 1,
            reviewState: 'not_reviewed' as const,
            provenance: {
              sourceUrl: 'local://generated',
              sourceTitle: 'MT EPS Question Factory',
              sourceQuestionId: preserved?.id ?? null
            }
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
    revision: (preserved?.revision ?? 0) + (preserved ? 1 : 1),
    reviewState: preserved?.reviewState ?? 'not_reviewed',
    provenance: next.provenance ?? { sourceUrl: 'local://generated', sourceTitle: 'MT EPS Question Factory' }
  } as NormalizedQuestion;
}
