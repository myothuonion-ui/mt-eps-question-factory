import type { NormalizedQuestion } from '../src/shared/types.js';
import { getProviderSettings } from './providerSettings.js';

export type VideoAlignment = {
  questionId: string;
  sourceOrder: number;
  start: number;
  end: number;
  transcript: string;
  confidence: number;
  reason: string;
};

function jsonValue(text: string) {
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const objectStart = cleaned.indexOf('{');
  const arrayStart = cleaned.indexOf('[');
  let start = -1;
  let end = -1;
  if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
    start = objectStart;
    end = cleaned.lastIndexOf('}');
  } else if (arrayStart >= 0) {
    start = arrayStart;
    end = cleaned.lastIndexOf(']');
  }
  if (start < 0 || end < start) throw new Error('Gemini video response did not contain JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function safeQuestion(question: NormalizedQuestion) {
  return {
    questionId: question.id,
    sourceOrder: question.sourceOrder,
    stem: question.stem,
    options: question.options,
    correctAnswerIndex: question.correctAnswerIndex
  };
}

export async function alignQuestionsWithYoutube(url: string, questions: NormalizedQuestion[]): Promise<VideoAlignment[]> {
  const settings = getProviderSettings();
  const key = process.env.GEMINI_API_KEY ?? '';
  if (!settings.gemini.configured || !key || !questions.length) return [];

  const prompt = `You are aligning EPS-TOPIK listening questions to one public YouTube source owned by the teacher.
For every input question, find the single short time range in the video that best supports the question and its correct answer.
Return JSON only in this exact outer shape: {"alignments":[...]}
Each alignment schema: {"questionId":"...","sourceOrder":1,"start":12.5,"end":29.0,"transcript":"Korean speech from this range","confidence":0.0,"reason":"short reason"}
Rules:
- Use seconds from the beginning of the video.
- Prefer 5-45 second ranges. Never exceed 60 seconds.
- transcript should contain only speech relevant to the question; do not invent missing dialogue.
- confidence is 0 to 1. Use below 0.6 if the match is uncertain.
- If a question cannot be grounded, return start=0,end=0,transcript="",confidence=0.
- Keep exactly one result for every input question.
INPUT QUESTIONS:\n${JSON.stringify(questions.map(safeQuestion))}`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.gemini.model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { fileData: { fileUri: url } },
        { text: prompt }
      ] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    })
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Gemini video alignment failed: HTTP ${response.status} ${text}`);
    (error as any).status = response.status;
    throw error;
  }
  const json = await response.json() as any;
  const text = json?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? '').join('');
  if (typeof text !== 'string' || !text) throw new Error('Gemini video alignment returned no content.');
  const parsed = jsonValue(text);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.alignments) ? parsed.alignments : [];
  const byId = new Map(questions.map(question => [question.id, question]));
  return rows.flatMap((row: any): VideoAlignment[] => {
    const id = String(row?.questionId ?? '');
    const question = byId.get(id) ?? questions.find(item => item.sourceOrder === Number(row?.sourceOrder));
    if (!question) return [];
    const start = Number(row?.start ?? 0);
    const end = Number(row?.end ?? 0);
    const confidence = Math.max(0, Math.min(1, Number(row?.confidence ?? 0)));
    return [{
      questionId: question.id,
      sourceOrder: question.sourceOrder,
      start: Number.isFinite(start) ? Math.max(0, start) : 0,
      end: Number.isFinite(end) ? Math.max(0, end) : 0,
      transcript: typeof row?.transcript === 'string' ? row.transcript.trim() : '',
      confidence: Number.isFinite(confidence) ? confidence : 0,
      reason: typeof row?.reason === 'string' ? row.reason.trim() : ''
    }];
  });
}
