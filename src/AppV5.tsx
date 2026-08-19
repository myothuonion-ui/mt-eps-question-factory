import { useEffect, useMemo, useState } from 'react';
import type { ExamSet, ImportAnalysis, NormalizedQuestion, SystemStatus } from './shared/types';

type Tab = 'oneclick' | 'result' | 'debug' | 'bank' | 'api';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data as T;
}

function friendlyError(text: string) {
  if (/HTTP 429|quota|RESOURCE_EXHAUSTED/i.test(text)) return 'Gemini quota/rate limit reached. GLM fallback can continue when its key is configured.';
  return text.length > 650 ? `${text.slice(0, 647)}…` : text;
}

export function AppV5() {
  const [tab, setTab] = useState<Tab>('oneclick');
  const [set40, setSet40] = useState<ExamSet | null>(null);
  const [latestImport, setLatestImport] = useState<ImportAnalysis | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [bankCount, setBankCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    try {
      const [sets, imports, bank, system] = await Promise.all([
        api<{ ok: true; sets: ExamSet[] }>('/api/sets'),
        api<{ ok: true; imports: ImportAnalysis[] }>('/api/imports'),
        api<{ ok: true; questions: NormalizedQuestion[] }>('/api/bank'),
        api<{ ok: true; status: SystemStatus }>('/api/system/status')
      ]);
      setSet40(sets.sets[0] ?? null);
      setLatestImport(imports.imports[0] ?? null);
      setBankCount(bank.questions.length);
      setStatus(system.status);
    } catch {}
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const handler = () => void refresh();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, []);

  const questions = useMemo(() => set40?.slots.flatMap(slot => slot.question ? [slot.question] : []) ?? [], [set40]);
  const selected = questions.find(question => question.id === selectedId) ?? questions[0] ?? null;
  const readingCount = set40?.slots.filter(slot => slot.section === 'reading' && !!slot.question).length ?? 0;
  const listeningCount = set40?.slots.filter(slot => slot.section === 'listening' && !!slot.question).length ?? 0;

  async function saveEdit(question: NormalizedQuestion, patch: Partial<NormalizedQuestion>) {
    if (!set40) return;
    setError(''); setBusy('Saving question…');
    try {
      const body: Record<string, unknown> = {};
      if (patch.stem !== undefined) body.stem = patch.stem;
      if (patch.options !== undefined) body.options = patch.options;
      if (patch.correctAnswerIndex !== undefined) body.correctAnswerIndex = patch.correctAnswerIndex;
      if (patch.explanation !== undefined) body.explanation = patch.explanation;
      body.reviewState = 'edited';
      const result = await api<{ ok: true; set: ExamSet }>(`/api/sets/${set40.id}/questions/${question.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      setSet40(result.set);
    } catch (e) { setError(e instanceof Error ? e.message : 'Edit failed.'); }
    finally { setBusy(''); }
  }

  async function regenerate(question: NormalizedQuestion, mode: 'entire' | 'choices' | 'explanation' | 'script') {
    if (!set40) return;
    setError(''); setBusy(`Regenerating ${mode}…`);
    try {
      const result = await api<{ ok: true; set: ExamSet }>(`/api/sets/${set40.id}/questions/${question.id}/regenerate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode })
      });
      setSet40(result.set);
    } catch (e) { setError(e instanceof Error ? e.message : 'Regeneration failed.'); }
    finally { setBusy(''); }
  }

  async function regenerateAudio(question: NormalizedQuestion) {
    if (!set40) return;
    setError(''); setBusy('Regenerating audio…');
    try {
      const result = await api<{ ok: true; set: ExamSet }>(`/api/sets/${set40.id}/questions/${question.id}/audio`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'mt-eps-standard' })
      });
      setSet40(result.set);
    } catch (e) { setError(e instanceof Error ? e.message : 'Audio generation failed.'); }
    finally { setBusy(''); }
  }

  async function saveBank() {
    if (!set40) return;
    setError(''); setBusy('Saving to local bank…');
    try {
      const result = await api<{ ok: true; set: ExamSet }>(`/api/sets/${set40.id}/publish`, { method: 'POST' });
      setSet40(result.set);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Bank save failed.'); }
    finally { setBusy(''); }
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <div><div className="brand-mark">MT</div><h1>EPS Question Factory</h1><p>Controller Teacher Studio · v0.5.0</p></div>
      <nav>
        <button className={tab === 'oneclick' ? 'active' : ''} onClick={() => setTab('oneclick')}>01 One Click Build</button>
        <button className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}>02 40Q Builder</button>
        <button className={tab === 'debug' ? 'active' : ''} onClick={() => setTab('debug')}>03 Advanced Debug</button>
        <button className={tab === 'bank' ? 'active' : ''} onClick={() => setTab('bank')}>04 Local Bank</button>
        <button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>05 API & Tools</button>
      </nav>
      <div className="sidebar-note">Normal use: answered Form link → BUILD 40Q. Reading 20 first, Listening 20 after. Review is optional.</div>
    </aside>

    <section className="workspace">
      <header className="hero">
        <div><span className="eyebrow">CONTROLLER AGENT FACTORY</span><h2>Answered Form → Reading 20 → Listening 20 → Fresh 40Q</h2><p>Form order, section headings and YouTube placement are analyzed before generation. Agents run automatically in the background.</p></div>
        <div className="status-stack"><span className="status-pill">AI · {status?.aiProvider ?? '...'}</span><span className="status-pill">Bank · {bankCount}</span></div>
      </header>

      {busy && <div className="working-banner"><span className="spinner" />{busy}</div>}
      {error && <div className="error-box top-error"><strong>Action stopped</strong><span>{friendlyError(error)}</span></div>}

      {tab === 'oneclick' && <OneClickHome latestImport={latestImport} set40={set40} onResult={() => setTab('result')} />}
      {tab === 'result' && <ResultPanel set40={set40} readingCount={readingCount} listeningCount={listeningCount} selected={selected} selectedId={selectedId} setSelectedId={setSelectedId} reviewOpen={reviewOpen} setReviewOpen={setReviewOpen} onSave={saveEdit} onRegenerate={regenerate} onAudio={regenerateAudio} onBank={saveBank} busy={!!busy} />}
      {tab === 'debug' && <DebugPanel status={status} latestImport={latestImport} onRefresh={() => void refresh()} />}
      {tab === 'bank' && <BankPanel count={bankCount} set40={set40} onSave={saveBank} busy={!!busy} />}
      {tab === 'api' && <ApiPanel status={status} onRefresh={() => void refresh()} />}
    </section>
  </main>;
}

function OneClickHome({ latestImport, set40, onResult }: { latestImport: ImportAnalysis | null; set40: ExamSet | null; onResult: () => void }) {
  return <>
    <section className="panel">
      <div className="panel-heading"><div><span className="step">01</span><h3>One-Click Controller</h3></div><span className="complete-badge">Primary workflow</span></div>
      <div className="success-box">Use the floating <strong>CONTROLLER AGENTS v0.5</strong> panel: paste the answered Google Forms result link and press <strong>BUILD 40Q</strong>. No separate Analyze Form or Listening step is required.</div>
      <div className="agent-flow-cards">
        {['Form','Structure','Media','Alignment','Generator','QA'].map((name, index) => <div key={name}><b>{String(index + 1).padStart(2, '0')}</b><strong>{name} Agent</strong><span>{name === 'Form' ? 'questions · answers · images · YouTube' : name === 'Structure' ? 'Reading 20 → Listening 20' : name === 'Media' ? 'captions · audio · cache' : name === 'Alignment' ? 'question ↔ timestamp' : name === 'Generator' ? 'fresh batched questions' : 'answer · section · audio · duplicates'}</span></div>)}
      </div>
    </section>
    {latestImport && <section className="metrics"><Metric label="Latest refs" value={latestImport.counts.questions}/><Metric label="Reading" value={latestImport.counts.reading}/><Metric label="Listening" value={latestImport.counts.listening}/><Metric label="Answers" value={latestImport.counts.answersDetected}/><Metric label="YouTube" value={latestImport.counts.youtube}/><Metric label="Images" value={latestImport.counts.images}/></section>}
    {set40?.complete && <section className="panel"><div className="panel-heading"><div><span className="step">✓</span><h3>Latest 40Q set is ready</h3></div><span className="complete-badge">40 / 40</span></div><button onClick={onResult}>Open Result / Optional Review</button></section>}
  </>;
}

function ResultPanel(props: { set40: ExamSet | null; readingCount: number; listeningCount: number; selected: NormalizedQuestion | null; selectedId: string | null; setSelectedId: (id: string) => void; reviewOpen: boolean; setReviewOpen: (value: boolean) => void; onSave: (q: NormalizedQuestion, patch: Partial<NormalizedQuestion>) => void; onRegenerate: (q: NormalizedQuestion, mode: 'entire'|'choices'|'explanation'|'script') => void; onAudio: (q: NormalizedQuestion) => void; onBank: () => void; busy: boolean }) {
  if (!props.set40) return <Empty title="No finished set yet" text="Paste the answered Form link in the Controller panel and press BUILD 40Q."/>;
  const set = props.set40;
  return <section className="panel">
    <div className="panel-heading"><div><span className="step">40</span><h3>{set.name ?? 'EPS 40Q Set'}</h3></div><span className={set.complete ? 'complete-badge' : 'pending-badge'}>{set.slots.filter(slot => slot.question).length} / 40</span></div>
    <div className="result-section-summary"><span>Reading <b>{props.readingCount}/20</b></span><span>Listening <b>{props.listeningCount}/20</b></span><span>QA <b>{set.qaCompleted ? 'done' : 'pending'}</b></span></div>
    <p className="review-policy">The set is completed before review. Use it/save it immediately, or open Optional Review only when you want to change something.</p>
    <div className="set-actions"><button className="secondary" onClick={() => props.setReviewOpen(!props.reviewOpen)} disabled={!set.complete}>{props.reviewOpen ? 'Close Review' : 'Open Optional Review'}</button><button onClick={props.onBank} disabled={!set.complete || props.busy}>{set.published ? 'Saved in Local Bank ✓' : 'Save to Local Bank'}</button></div>
    <div className="slot-grid">{set.slots.map(slot => <button key={slot.slot} className={`slot ${slot.question ? 'filled' : 'missing'} ${props.selectedId === slot.question?.id ? 'selected' : ''}`} onClick={() => slot.question && props.setSelectedId(slot.question.id)}><strong>{slot.slot}</strong><span>{slot.patternId}</span><small>{slot.section === 'reading' ? 'Reading' : 'Listening'} · Ch {slot.question?.chapter.chapter ?? '?'}</small><em>{slot.question?.qa?.score ?? '—'}</em></button>)}</div>
    {props.reviewOpen && props.selected && <ReviewEditor question={props.selected} onSave={patch => props.onSave(props.selected!, patch)} onRegenerate={mode => props.onRegenerate(props.selected!, mode)} onAudio={() => props.onAudio(props.selected!)} busy={props.busy}/>} 
  </section>;
}

function ReviewEditor({ question, onSave, onRegenerate, onAudio, busy }: { question: NormalizedQuestion; onSave: (patch: Partial<NormalizedQuestion>) => void; onRegenerate: (mode: 'entire'|'choices'|'explanation'|'script') => void; onAudio: () => void; busy: boolean }) {
  const [stem, setStem] = useState(question.stem);
  const [options, setOptions] = useState(question.options);
  const [answer, setAnswer] = useState(question.correctAnswerIndex ?? 0);
  const [explanation, setExplanation] = useState(question.explanation ?? '');
  useEffect(() => { setStem(question.stem); setOptions(question.options); setAnswer(question.correctAnswerIndex ?? 0); setExplanation(question.explanation ?? ''); }, [question.id, question.revision]);
  return <div className="review-editor">
    <div className="review-head"><div><strong>Q{question.sourceOrder} · {question.patternId}</strong><span>{question.section} · Chapter {question.chapter.chapter ?? '?'} · {question.generatedBy ?? 'source'} · rev {question.revision ?? 1}</span></div><div className="qa-score">QA {question.qa?.score ?? '—'}</div></div>
    {question.audioAsset && <audio controls src={question.audioAsset.url}/>} 
    <textarea value={stem} onChange={e => setStem(e.target.value)}/>
    {options.map((option, index) => <div className="option-edit" key={index}><input type="radio" checked={answer === index} onChange={() => setAnswer(index)}/><input value={option} onChange={e => { const next = [...options]; next[index] = e.target.value; setOptions(next); }}/></div>)}
    <textarea className="explain" value={explanation} onChange={e => setExplanation(e.target.value)} placeholder="Myanmar explanation"/>
    <div className="review-actions"><button onClick={() => onSave({ stem, options, correctAnswerIndex: answer, explanation })} disabled={busy}>Save Edit</button><button className="secondary" onClick={() => onRegenerate('choices')} disabled={busy}>Choices Only</button><button className="secondary" onClick={() => onRegenerate('entire')} disabled={busy}>Regenerate Question</button><button className="secondary" onClick={() => onRegenerate('explanation')} disabled={busy}>Explanation Only</button>{question.section === 'listening' && <><button className="secondary" onClick={() => onRegenerate('script')} disabled={busy}>Script Only</button><button className="secondary" onClick={onAudio} disabled={busy}>Audio Only</button></>}</div>
    {!!question.qaFlags.length && <div className="flag-row">{question.qaFlags.map(flag => <span key={flag}>{flag}</span>)}</div>}
  </div>;
}

function DebugPanel({ status, latestImport, onRefresh }: { status: SystemStatus | null; latestImport: ImportAnalysis | null; onRefresh: () => void }) {
  const d = latestImport?.diagnostics;
  return <>
    <section className="panel"><div className="panel-heading"><div><span className="step">03</span><h3>Advanced Debug</h3></div><button className="secondary" onClick={onRefresh}>Refresh</button></div><p className="review-policy">Normal builds do not require this page. Use it only to diagnose local tools or Form extraction.</p><div className="system-grid"><Tool name={`AI: ${status?.aiProvider ?? '...'}`} ok={status?.aiProvider !== 'mock'}/><Tool name="ffmpeg" ok={status?.tools.ffmpeg}/><Tool name="yt-dlp" ok={status?.tools.ytdlp}/><Tool name="Whisper (optional)" ok={status?.tools.whisper}/></div></section>
    {latestImport && <section className="panel"><div className="panel-heading"><div><span className="step">F</span><h3>Latest Form Analysis</h3></div><span className="subtle">{latestImport.sourceTitle}</span></div><div className="diagnostic-grid"><span><small>Parser</small><strong>{d?.parserStrategy ?? '—'}</strong></span><span><small>Section source</small><strong>{d?.sectionSource ?? '—'}</strong></span><span><small>Order</small><strong>{d?.sectionOrder?.join(' → ') ?? '—'}</strong></span><span><small>Answer evidence</small><strong>{d?.answerEvidenceCount ?? 0}</strong></span></div>{d?.detectedSections?.map((section, index) => <div className="success-box" key={`${section.kind}-${index}`}>{section.label} · {section.kind} · Q{section.questionStart ?? '?'}–Q{section.questionEnd ?? '?'} · {Math.round(section.confidence * 100)}%</div>)}{!!d?.warnings.length && <div className="diagnostic-warnings">{d.warnings.map(warning => <div key={warning}>⚠ {warning}</div>)}</div>}</section>}
  </>;
}

function BankPanel({ count, set40, onSave, busy }: { count: number; set40: ExamSet | null; onSave: () => void; busy: boolean }) {
  return <section className="panel"><div className="panel-heading"><div><span className="step">04</span><h3>Local Question Bank</h3></div><span className="complete-badge">{count} questions</span></div><p className="review-policy">This is the handoff point for the future Student App. Review is optional before saving a complete set.</p>{set40?.complete && !set40.published && <button onClick={onSave} disabled={busy}>Save Current 40Q Set</button>}{set40?.published && <div className="success-box">Current set is stored in the local bank.</div>}</section>;
}

function ApiPanel({ status, onRefresh }: { status: SystemStatus | null; onRefresh: () => void }) {
  return <section className="panel"><div className="panel-heading"><div><span className="step">05</span><h3>API & Tools</h3></div><button className="secondary" onClick={onRefresh}>Refresh</button></div><div className="success-box">Use the floating <strong>API Keys</strong> panel to add Gemini, GLM/NVIDIA and Cloudflare credentials. The Controller handles provider fallback automatically.</div><div className="system-grid"><Tool name={`AI: ${status?.aiProvider ?? '...'}`} ok={status?.aiProvider !== 'mock'}/><Tool name={`TTS: ${status?.ttsProvider ?? '...'}`} ok={true}/><Tool name="ffmpeg" ok={status?.tools.ffmpeg}/><Tool name="yt-dlp" ok={status?.tools.ytdlp}/><Tool name="Whisper (optional)" ok={status?.tools.whisper}/></div></section>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="metric"><strong>{value}</strong><span>{label}</span></div>; }
function Tool({ name, ok }: { name: string; ok: boolean | undefined }) { return <span className={`tool-chip ${ok ? 'ok' : 'off'}`}>{name} · {ok ? 'ready' : 'not ready'}</span>; }
function Empty({ title, text }: { title: string; text: string }) { return <section className="panel empty"><h3>{title}</h3><p>{text}</p></section>; }
