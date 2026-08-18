import { useEffect, useMemo, useState } from 'react';
import type { ExamSet, ImportAnalysis, MediaAnalysis, NormalizedQuestion, SystemStatus, VoiceProfile } from './shared/types';

type Tab = 'source' | 'set' | 'listening' | 'bank' | 'settings';
type ChapterScope = 'source' | 'all' | `${number}`;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data as T;
}

function scopeToChapters(scope: ChapterScope) {
  if (scope === 'source') return undefined;
  if (scope === 'all') return Array.from({ length: 60 }, (_, index) => index + 1);
  const chapter = Number(scope);
  return Number.isInteger(chapter) && chapter >= 1 && chapter <= 60 ? [chapter] : undefined;
}

export function App() {
  const [tab, setTab] = useState<Tab>('source');
  const [url, setUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [set40, setSet40] = useState<ExamSet | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [bankCount, setBankCount] = useState(0);
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [mediaAnalysis, setMediaAnalysis] = useState<MediaAnalysis | null>(null);
  const [chapterScope, setChapterScope] = useState<ChapterScope>('source');

  useEffect(() => {
    void refreshSystem();
    void refreshProfiles();
    void refreshBank();
    void restoreLatest();
  }, []);

  async function restoreLatest() {
    try {
      const [importsResult, setsResult] = await Promise.all([
        api<{ ok: true; imports: ImportAnalysis[] }>('/api/imports'),
        api<{ ok: true; sets: ExamSet[] }>('/api/sets')
      ]);
      if (importsResult.imports[0]) setAnalysis(importsResult.imports[0]);
      if (setsResult.sets[0]) setSet40(setsResult.sets[0]);
    } catch {}
  }

  async function refreshSystem() {
    try { setStatus((await api<{ ok: true; status: SystemStatus }>('/api/system/status')).status); } catch {}
  }
  async function refreshProfiles() {
    try { setProfiles((await api<{ ok: true; profiles: VoiceProfile[] }>('/api/voice-profiles')).profiles); } catch {}
  }
  async function refreshBank() {
    try { setBankCount((await api<{ ok: true; questions: NormalizedQuestion[] }>('/api/bank')).questions.length); } catch {}
  }

  async function analyzeUrl() {
    setError(''); setLoading('Importing Google Form and analyzing questions…');
    try {
      const result = await api<{ ok: true; analysis: ImportAnalysis }>('/api/import/google-form', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url })
      });
      setAnalysis(result.analysis); setSet40(null); setReviewOpen(false); setTab('source');
    } catch (e) { setError(e instanceof Error ? e.message : 'Import failed'); }
    finally { setLoading(''); }
  }

  async function analyzeFiles() {
    if (!files.length) return;
    setError(''); setLoading('Uploading and extracting local files…');
    try {
      const form = new FormData(); files.forEach(file => form.append('files', file));
      const result = await api<{ ok: true; analysis: ImportAnalysis }>('/api/import/files', { method: 'POST', body: form });
      setAnalysis(result.analysis); setSet40(null); setReviewOpen(false); setTab('source');
    } catch (e) { setError(e instanceof Error ? e.message : 'File import failed'); }
    finally { setLoading(''); }
  }

  async function complete40() {
    if (!analysis) return;
    setError(''); setLoading('Generating a fresh 40-question set from the analyzed patterns. Review will not interrupt this process…');
    try {
      const generationAnalysis: ImportAnalysis = { ...analysis, generationChapters: scopeToChapters(chapterScope) };
      const result = await api<{ ok: true; set: ExamSet }>('/api/exam/complete-40', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analysis: generationAnalysis })
      });
      setSet40(result.set); setTab('set'); setReviewOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : '40Q completion failed'); }
    finally { setLoading(''); }
  }

  async function editQuestion(question: NormalizedQuestion, patch: Partial<NormalizedQuestion>) {
    if (!set40) return;
    setError(''); setLoading('Saving question…');
    try {
      const body: Record<string, unknown> = {};
      if (patch.stem !== undefined) body.stem = patch.stem;
      if (patch.options !== undefined) body.options = patch.options;
      if (patch.correctAnswerIndex !== undefined) body.correctAnswerIndex = patch.correctAnswerIndex;
      if (patch.explanation !== undefined) body.explanation = patch.explanation;
      if (patch.reviewState !== undefined) body.reviewState = patch.reviewState;
      if (patch.chapter?.chapter) body.chapter = patch.chapter.chapter;
      const result = await api<{ ok: true; set: ExamSet }>(`/api/sets/${set40.id}/questions/${question.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      setSet40(result.set);
    } catch (e) { setError(e instanceof Error ? e.message : 'Edit failed'); }
    finally { setLoading(''); }
  }

  async function regenerate(question: NormalizedQuestion, mode: 'entire' | 'choices' | 'explanation' | 'script') {
    if (!set40) return;
    setError(''); setLoading(`Regenerating ${mode}…`);
    try {
      const result = await api<{ ok: true; set: ExamSet }>(`/api/sets/${set40.id}/questions/${question.id}/regenerate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode })
      });
      setSet40(result.set);
    } catch (e) { setError(e instanceof Error ? e.message : 'Regeneration failed'); }
    finally { setLoading(''); }
  }

  async function regenerateAudio(question: NormalizedQuestion) {
    if (!set40) return;
    setError(''); setLoading('Generating listening audio…');
    try {
      const result = await api<{ ok: true; set: ExamSet }>(`/api/sets/${set40.id}/questions/${question.id}/audio`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: profiles[0]?.id ?? 'mt-eps-standard' })
      });
      setSet40(result.set);
    } catch (e) { setError(e instanceof Error ? e.message : 'Audio generation failed'); }
    finally { setLoading(''); }
  }

  async function publishLocal() {
    if (!set40) return;
    setError(''); setLoading('Saving 40Q set to local question bank…');
    try {
      const result = await api<{ ok: true; set: ExamSet }>(`/api/sets/${set40.id}/publish`, { method: 'POST' });
      setSet40(result.set); await refreshBank();
    } catch (e) { setError(e instanceof Error ? e.message : 'Bank save failed'); }
    finally { setLoading(''); }
  }

  async function analyzeYoutube() {
    setError(''); setLoading('Downloading YouTube audio and detecting listening segments…');
    try {
      const result = await api<{ ok: true; analysis: MediaAnalysis }>('/api/media/youtube/analyze', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: youtubeUrl })
      });
      setMediaAnalysis(result.analysis);
    } catch (e) { setError(e instanceof Error ? e.message : 'YouTube analysis failed'); }
    finally { setLoading(''); }
  }

  const setQuestions = useMemo(() => set40?.slots.flatMap(slot => slot.question ? [slot.question] : []) ?? [], [set40]);
  const selectedQuestion = setQuestions.find(q => q.id === selectedId) ?? setQuestions[0] ?? null;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div><div className="brand-mark">MT</div><h1>EPS Question Factory</h1><p>Local Teacher Studio · v0.2.1</p></div>
        <nav>
          <button className={tab === 'source' ? 'active' : ''} onClick={() => setTab('source')}>01 Source Factory</button>
          <button className={tab === 'set' ? 'active' : ''} onClick={() => setTab('set')}>02 40Q Builder</button>
          <button className={tab === 'listening' ? 'active' : ''} onClick={() => setTab('listening')}>03 Listening Studio</button>
          <button className={tab === 'bank' ? 'active' : ''} onClick={() => setTab('bank')}>04 Local Bank</button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>05 Voice & Tools</button>
        </nav>
        <div className="sidebar-note">40 questions finish first. Review is optional and happens only after the set is complete.</div>
      </aside>

      <section className="workspace">
        <header className="hero"><div><span className="eyebrow">SINGLE-USER LOCAL FACTORY</span><h2>Source → Fresh 40Q → Listening → Optional Review</h2><p>Reference questions teach the pattern. The finished 40Q set is generated fresh; the source Form is not simply copied.</p></div><div className="status-stack"><span className="status-pill">AI · {status?.aiProvider ?? '...'}</span><span className="status-pill">Bank · {bankCount}</span></div></header>
        {loading && <div className="working-banner"><span className="spinner" />{loading}</div>}
        {error && <div className="error-box top-error">{error}</div>}
        {tab === 'source' && <SourceFactory url={url} setUrl={setUrl} files={files} setFiles={setFiles} analysis={analysis} chapterScope={chapterScope} setChapterScope={setChapterScope} onAnalyzeUrl={analyzeUrl} onAnalyzeFiles={analyzeFiles} onComplete={complete40} busy={!!loading} />}
        {tab === 'set' && <SetBuilder set40={set40} reviewOpen={reviewOpen} setReviewOpen={setReviewOpen} selectedQuestion={selectedQuestion} selectedId={selectedId} setSelectedId={setSelectedId} onEdit={editQuestion} onRegenerate={regenerate} onAudio={regenerateAudio} onPublish={publishLocal} busy={!!loading} />}
        {tab === 'listening' && <ListeningStudio youtubeUrl={youtubeUrl} setYoutubeUrl={setYoutubeUrl} mediaAnalysis={mediaAnalysis} onAnalyze={analyzeYoutube} status={status} busy={!!loading} />}
        {tab === 'bank' && <BankPanel bankCount={bankCount} set40={set40} onPublish={publishLocal} busy={!!loading} />}
        {tab === 'settings' && <SettingsPanel status={status} profiles={profiles} onProfiles={setProfiles} onRefresh={refreshSystem} />}
      </section>
    </main>
  );
}

function SourceFactory(props: { url: string; setUrl: (v: string) => void; files: File[]; setFiles: (v: File[]) => void; analysis: ImportAnalysis | null; chapterScope: ChapterScope; setChapterScope: (v: ChapterScope) => void; onAnalyzeUrl: () => void; onAnalyzeFiles: () => void; onComplete: () => void; busy: boolean }) {
  const a = props.analysis;
  return <>
    <section className="panel"><div className="panel-heading"><div><span className="step">01</span><h3>Source Inbox</h3></div><span className="subtle">Google Form or local source files</span></div><div className="stack-gap"><div className="url-row"><input value={props.url} onChange={e => props.setUrl(e.target.value)} placeholder="Paste Google Forms viewscore/result link" /><button onClick={props.onAnalyzeUrl} disabled={!props.url || props.busy}>Analyze Form</button></div><div className="drop-row"><label className="file-picker">Choose ZIP / PDF / DOCX / XLSX / CSV / Audio / Video<input type="file" multiple onChange={e => props.setFiles(Array.from(e.target.files ?? []))} /></label><span>{props.files.length ? `${props.files.length} file(s) ready` : 'No files selected'}</span><button onClick={props.onAnalyzeFiles} disabled={!props.files.length || props.busy}>Analyze Files</button></div></div></section>
    {a && <><section className="metrics"><Metric label="Questions" value={a.counts.questions}/><Metric label="Listening" value={a.counts.listening}/><Metric label="Reading/Other" value={a.counts.reading}/><Metric label="Answers" value={a.counts.answersDetected}/><Metric label="Images" value={a.counts.images}/><Metric label="YouTube" value={a.counts.youtube}/></section><section className="panel"><div className="panel-heading"><div><span className="step">02</span><h3>Analysis + Fresh Generation</h3></div><span className="subtle">{a.sourceTitle}</span></div><div className="generation-row"><div><label>Chapter scope</label><select value={props.chapterScope} onChange={e => props.setChapterScope(e.target.value as ChapterScope)}><option value="source">Follow source chapter analysis</option><option value="all">Use all Chapters 1–60</option>{Array.from({ length: 60 }, (_, index) => <option key={index + 1} value={String(index + 1)}>Chapter {index + 1}</option>)}</select></div><div className="generation-summary"><strong>40 fresh questions</strong><span>Listening 20 + Reading 20 · source used as pattern reference</span></div><button className="primary" onClick={props.onComplete} disabled={props.busy}>Generate Complete 40Q</button></div><div className="analysis-toolbar"><span><strong>{a.questions.length}</strong> extracted references</span><span><strong>{a.questions.filter(q => q.qaFlags.length).length}</strong> flags recorded (non-blocking)</span></div><div className="question-grid compact">{a.questions.slice(0, 12).map(q => <QuestionMini key={q.id} question={q}/>)}</div>{a.questions.length > 12 && <p className="subtle center">+ {a.questions.length - 12} more imported references</p>}</section></>}
  </>;
}

function SetBuilder(props: { set40: ExamSet | null; reviewOpen: boolean; setReviewOpen: (v: boolean) => void; selectedQuestion: NormalizedQuestion | null; selectedId: string | null; setSelectedId: (v: string) => void; onEdit: (q: NormalizedQuestion, patch: Partial<NormalizedQuestion>) => void; onRegenerate: (q: NormalizedQuestion, mode: 'entire'|'choices'|'explanation'|'script') => void; onAudio: (q: NormalizedQuestion) => void; onPublish: () => void; busy: boolean }) {
  if (!props.set40) return <Empty title="No 40Q set yet" text="Import a source first, then generate a fresh 40-question set."/>;
  const set = props.set40;
  return <section className="panel"><div className="panel-heading"><div><span className="step">40</span><h3>{set.name ?? 'EPS 40Q Set'}</h3></div><span className={set.complete ? 'complete-badge' : 'pending-badge'}>{set.slots.filter(s => s.question).length} / 40</span></div><p className="review-policy">All 40 are generated and QA is recorded before review. You can save the completed set without reviewing, or open review and modify only a question you choose.</p><div className="set-actions"><button className="secondary" onClick={() => props.setReviewOpen(!props.reviewOpen)} disabled={!set.complete}>{props.reviewOpen ? 'Close Review' : 'Open Optional Review'}</button><button onClick={props.onPublish} disabled={!set.complete || props.busy}>{set.published ? 'Saved in Local Bank ✓' : 'Save to Local Bank'}</button></div><div className="slot-grid">{set.slots.map(slot => <button key={slot.slot} className={`slot ${slot.question ? 'filled' : 'missing'} ${props.selectedId === slot.question?.id ? 'selected' : ''}`} onClick={() => slot.question && props.setSelectedId(slot.question.id)}><strong>{slot.slot}</strong><span>{slot.patternId}</span><small>Ch {slot.question?.chapter.chapter ?? '?'} · {slot.question?.type ?? 'missing'}</small><em>{slot.question?.qa?.score ?? '—'}</em></button>)}</div>{props.reviewOpen && props.selectedQuestion && <ReviewEditor question={props.selectedQuestion} onSave={patch => props.onEdit(props.selectedQuestion!, patch)} onRegenerate={mode => props.onRegenerate(props.selectedQuestion!, mode)} onAudio={() => props.onAudio(props.selectedQuestion!)} busy={props.busy}/>}</section>;
}

function ReviewEditor({ question, onSave, onRegenerate, onAudio, busy }: { question: NormalizedQuestion; onSave: (patch: Partial<NormalizedQuestion>) => void; onRegenerate: (mode: 'entire'|'choices'|'explanation'|'script') => void; onAudio: () => void; busy: boolean }) {
  const [stem, setStem] = useState(question.stem); const [options, setOptions] = useState(question.options); const [answer, setAnswer] = useState(question.correctAnswerIndex ?? 0); const [explanation, setExplanation] = useState(question.explanation ?? '');
  useEffect(() => { setStem(question.stem); setOptions(question.options); setAnswer(question.correctAnswerIndex ?? 0); setExplanation(question.explanation ?? ''); }, [question.id, question.revision]);
  return <div className="review-editor"><div className="review-head"><div><strong>Q{question.sourceOrder} · {question.patternId}</strong><span>Chapter {question.chapter.chapter ?? '?'} · {question.type} · rev {question.revision ?? 1}</span></div><div className="qa-score">QA {question.qa?.score ?? '—'}</div></div>{question.audioAsset && <audio controls src={question.audioAsset.url}/>}<textarea value={stem} onChange={e => setStem(e.target.value)}/>{options.map((option, i) => <div className="option-edit" key={i}><input type="radio" checked={answer === i} onChange={() => setAnswer(i)}/><input value={option} onChange={e => { const next=[...options]; next[i]=e.target.value; setOptions(next); }}/></div>)}<textarea className="explain" value={explanation} onChange={e => setExplanation(e.target.value)} placeholder="Myanmar explanation"/><div className="review-actions"><button onClick={() => onSave({ stem, options, correctAnswerIndex: answer, explanation, reviewState: 'edited' })} disabled={busy}>Save Edit</button><button className="secondary" onClick={() => onRegenerate('choices')} disabled={busy}>Choices Only</button><button className="secondary" onClick={() => onRegenerate('entire')} disabled={busy}>Regenerate Question</button>{question.type === 'listening' && <><button className="secondary" onClick={() => onRegenerate('script')} disabled={busy}>Script Only</button><button className="secondary" onClick={onAudio} disabled={busy}>Audio Only</button></>}</div>{!!question.qaFlags.length && <div className="flag-row">{question.qaFlags.map(flag => <span key={flag}>{flag}</span>)}</div>}</div>;
}

function ListeningStudio({ youtubeUrl, setYoutubeUrl, mediaAnalysis, onAnalyze, status, busy }: { youtubeUrl: string; setYoutubeUrl: (v:string)=>void; mediaAnalysis: MediaAnalysis|null; onAnalyze:()=>void; status:SystemStatus|null; busy:boolean }) {
  return <><section className="panel"><div className="panel-heading"><div><span className="step">03</span><h3>YouTube / Listening Source</h3></div><span className="subtle">Your source → WAV → segments → transcript when Whisper is available</span></div><div className="url-row"><input value={youtubeUrl} onChange={e=>setYoutubeUrl(e.target.value)} placeholder="Paste your YouTube source URL"/><button onClick={onAnalyze} disabled={!youtubeUrl || busy}>Analyze Audio</button></div><div className="tool-row"><Tool name="yt-dlp" ok={status?.tools.ytdlp}/><Tool name="ffmpeg" ok={status?.tools.ffmpeg}/><Tool name="Whisper" ok={status?.tools.whisper}/></div></section>{mediaAnalysis && <section className="panel"><div className="panel-heading"><div><span className="step">A</span><h3>Detected Segments</h3></div><span className="subtle">{mediaAnalysis.segments.length} segments</span></div><audio controls src={mediaAnalysis.audioUrl}/><div className="segment-list">{mediaAnalysis.segments.slice(0,100).map(seg => <div key={seg.id}><strong>{fmt(seg.start)}–{fmt(seg.end)}</strong><span>{seg.text || 'Audio segment'}</span></div>)}</div>{mediaAnalysis.flags.map(flag=><span className="warn-chip" key={flag}>{flag}</span>)}</section>}</>;
}

function SettingsPanel({ status, profiles, onProfiles, onRefresh }: { status:SystemStatus|null; profiles:VoiceProfile[]; onProfiles:(v:VoiceProfile[])=>void; onRefresh:()=>void }) {
  const profile = profiles[0]; const [draft, setDraft] = useState<VoiceProfile | null>(profile ?? null);
  useEffect(()=>setDraft(profile ?? null),[profile?.id, profile?.updatedAt]);
  async function save(){ if(!draft)return; const result=await api<{ok:true;profile:VoiceProfile}>(`/api/voice-profiles/${draft.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(draft)}); onProfiles([result.profile,...profiles.filter(p=>p.id!==result.profile.id)]); }
  return <><section className="panel"><div className="panel-heading"><div><span className="step">05</span><h3>Local Runtime</h3></div><button className="secondary" onClick={onRefresh}>Refresh</button></div><div className="system-grid"><Tool name={`AI: ${status?.aiProvider ?? '...'}`} ok={status?.aiProvider !== 'mock'}/><Tool name={`TTS: ${status?.ttsProvider ?? '...'}`} ok={true}/><Tool name="ffmpeg" ok={status?.tools.ffmpeg}/><Tool name="yt-dlp" ok={status?.tools.ytdlp}/><Tool name="Whisper" ok={status?.tools.whisper}/></div><p className="subtle">No API key is needed for UI/pipeline testing now. Mock AI can be replaced by Gemini or an OpenAI-compatible model later through local .env settings.</p></section>{draft && <section className="panel voice-panel"><div className="panel-heading"><div><span className="step">V</span><h3>Voice Profile</h3></div><span className="subtle">One preset reused across listening questions</span></div><div className="form-grid"><label>Name<input value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label>Provider<select value={draft.provider} onChange={e=>setDraft({...draft,provider:e.target.value as VoiceProfile['provider']})}><option value="local-system">Windows local-system</option><option value="openai-compatible">OpenAI-compatible TTS</option></select></label><label>Narrator voice<input value={draft.narratorVoice} onChange={e=>setDraft({...draft,narratorVoice:e.target.value})}/></label><label>Male voice<input value={draft.maleVoice} onChange={e=>setDraft({...draft,maleVoice:e.target.value})}/></label><label>Female voice<input value={draft.femaleVoice} onChange={e=>setDraft({...draft,femaleVoice:e.target.value})}/></label><label>Speed<input type="number" step="0.01" min="0.5" max="2" value={draft.speed} onChange={e=>setDraft({...draft,speed:Number(e.target.value)})}/></label><label>Speaker pause ms<input type="number" value={draft.speakerPauseMs} onChange={e=>setDraft({...draft,speakerPauseMs:Number(e.target.value)})}/></label><label>Question pause ms<input type="number" value={draft.questionPauseMs} onChange={e=>setDraft({...draft,questionPauseMs:Number(e.target.value)})}/></label></div><button onClick={save}>Save Voice Profile</button></section>}</>;
}

function BankPanel({ bankCount, set40, onPublish, busy }: { bankCount:number; set40:ExamSet|null; onPublish:()=>void; busy:boolean }) { return <section className="panel"><div className="panel-heading"><div><span className="step">04</span><h3>Local Question Bank</h3></div><span className="complete-badge">{bankCount} questions</span></div><p className="review-policy">This local bank is the future Student App handoff point. Saving a finished 40Q set does not require review.</p>{set40?.complete && !set40.published && <button onClick={onPublish} disabled={busy}>Save Current 40Q Set</button>}{set40?.published && <div className="success-box">Current set is stored in the local bank.</div>}</section>; }
function QuestionMini({question}:{question:NormalizedQuestion}){return <article className="question-card"><div className="question-meta"><span>Q{question.sourceOrder}</span><span>{question.type}</span><span>Ch {question.chapter.chapter ?? '?'}</span></div><h4>{question.stem}</h4><ol>{question.options.map((o,i)=><li className={question.correctAnswerIndex===i?'correct':''} key={i}>{o}</li>)}</ol></article>}
function Metric({label,value}:{label:string;value:number}){return <div className="metric"><strong>{value}</strong><span>{label}</span></div>}
function Tool({name,ok}:{name:string;ok:boolean|undefined}){return <span className={`tool-chip ${ok?'ok':'off'}`}>{name} · {ok?'ready':'not ready'}</span>}
function Empty({title,text}:{title:string;text:string}){return <section className="panel empty"><h3>{title}</h3><p>{text}</p></section>}
function fmt(seconds:number){const m=Math.floor(seconds/60);const s=Math.floor(seconds%60);return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
