export type QuestionType = 'listening' | 'reading' | 'blank' | 'vocabulary' | 'grammar' | 'image' | 'unknown';
export type QuestionOrigin = 'imported' | 'generated';
export type ReviewState = 'not_reviewed' | 'edited' | 'approved' | 'rejected';
export type SpeakerRole = 'narrator' | 'male' | 'female';

export type MediaRef = {
  kind: 'image' | 'youtube' | 'audio' | 'video' | 'link';
  url: string;
  localPath?: string | null;
  label?: string | null;
};

export type ChapterGuess = {
  chapter: number | null;
  title: string | null;
  confidence: number;
  reason: string;
};

export type ListeningScriptLine = {
  speaker: SpeakerRole;
  text: string;
};

export type AudioAsset = {
  id: string;
  url: string;
  localPath: string;
  durationSeconds?: number | null;
  source: 'youtube' | 'upload' | 'tts';
};

export type QaResult = {
  passed: boolean;
  score: number;
  flags: string[];
  checks: Record<string, boolean>;
};

export type NormalizedQuestion = {
  id: string;
  sourceOrder: number;
  stem: string;
  options: string[];
  correctAnswerIndex: number | null;
  answerEvidence?: string | null;
  explanation?: string | null;
  type: QuestionType;
  chapter: ChapterGuess;
  patternId?: string | null;
  media: MediaRef[];
  listeningScript?: ListeningScriptLine[];
  audioAsset?: AudioAsset | null;
  qaFlags: string[];
  qa?: QaResult | null;
  origin?: QuestionOrigin;
  generatedBy?: string | null;
  revision?: number;
  reviewState?: ReviewState;
  provenance: {
    sourceUrl: string;
    sourceTitle: string;
    sourceId?: string | null;
    sourceQuestionId?: string | null;
  };
};

export type ImportAnalysis = {
  id?: string;
  sourceUrl: string;
  sourceTitle: string;
  importedAt: string;
  mediaPool?: MediaRef[];
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
  patternId: string;
  expectedType: QuestionType;
  question: NormalizedQuestion | null;
  generationRequired: boolean;
};

export type ExamSet = {
  id: string;
  name?: string;
  createdAt: string;
  updatedAt?: string;
  sourceImportId?: string | null;
  slots: ExamSlot[];
  complete: boolean;
  qaCompleted?: boolean;
  published?: boolean;
  reviewOptional: true;
};

export type QuestionRevision = {
  id: string;
  setId: string;
  questionId: string;
  createdAt: string;
  reason: string;
  snapshot: NormalizedQuestion;
};

export type VoiceProfile = {
  id: string;
  name: string;
  narratorVoice: string;
  maleVoice: string;
  femaleVoice: string;
  speed: number;
  pitch: number;
  sentencePauseMs: number;
  speakerPauseMs: number;
  questionPauseMs: number;
  provider: 'local-system' | 'openai-compatible';
  createdAt: string;
  updatedAt: string;
};

export type MediaSegment = {
  id: string;
  start: number;
  end: number;
  text?: string;
  speaker?: string | null;
  score?: number;
};

export type MediaAnalysis = {
  id: string;
  sourceUrl: string;
  audioPath: string;
  audioUrl: string;
  transcriptAvailable: boolean;
  segments: MediaSegment[];
  flags: string[];
};

export type SystemStatus = {
  version: string;
  localMode: true;
  aiProvider: string;
  ttsProvider: string;
  tools: {
    ffmpeg: boolean;
    ytdlp: boolean;
    whisper: boolean;
  };
};
