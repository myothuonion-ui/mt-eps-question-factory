export type QuestionType = 'listening' | 'reading' | 'blank' | 'vocabulary' | 'grammar' | 'image' | 'unknown';

export type MediaRef = {
  kind: 'image' | 'youtube' | 'audio' | 'video' | 'link';
  url: string;
};

export type ChapterGuess = {
  chapter: number | null;
  title: string | null;
  confidence: number;
  reason: string;
};

export type NormalizedQuestion = {
  id: string;
  sourceOrder: number;
  stem: string;
  options: string[];
  correctAnswerIndex: number | null;
  answerEvidence?: string | null;
  type: QuestionType;
  chapter: ChapterGuess;
  media: MediaRef[];
  qaFlags: string[];
  provenance: {
    sourceUrl: string;
    sourceTitle: string;
  };
};

export type ImportAnalysis = {
  sourceUrl: string;
  sourceTitle: string;
  importedAt: string;
  counts: {
    questions: number;
    listening: number;
    reading: number;
    images: number;
    youtube: number;
    answersDetected: number;
  };
  questions: NormalizedQuestion[];
};

export type ExamSlot = {
  slot: number;
  section: 'listening' | 'reading';
  question: NormalizedQuestion | null;
  generationRequired: boolean;
};

export type ExamSet = {
  id: string;
  createdAt: string;
  slots: ExamSlot[];
  complete: boolean;
  reviewOptional: true;
};
