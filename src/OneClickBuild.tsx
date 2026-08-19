import { useEffect, useState } from 'react';
import type { GenerationJob, ImportAnalysis } from './shared/types';

async function jsonApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data as T;
}

function friendly(text: string) {
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(text)) return 'Gemini quota is limited right now. The hybrid flow will use captions/Whisper where possible and GLM generation when configured.';
  return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

export function OneClickBuild() {
  const [minimized, setMinimized] = useState(false);
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState('Paste an answered Google Forms score/result link.');
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [error, setError] = useState('');
  const [busyImport, setBusyImport] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('mt-open-finished-set') !== '1') return;
    localStorage.removeItem('mt-open-finished-set');
    const timer = window.setTimeout(() => {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent?.includes('02 40Q Builder')) as HTMLButtonElement | undefined;
      button?.click();
    }, 1600);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const result = await jsonApi<{ ok: true; job: GenerationJob }>(`/api/jobs/${job.id}`);
          if (stopped) return;
          setJob(result.job);
          const last = result.job.logs[result.job.logs.length - 1];
          if (last) setPhase(last.message);
          if (result.job.status === 'completed') {
            setPhase('40/40 complete. Opening the finished set…');
            localStorage.setItem('mt-open-finished-set', '1');
            window.setTimeout(() => window.location.reload(), 900);
          } else if (result.job.status === 'failed') {
            setError(result.job.error ?? '40Q build stopped.');
          }
        } catch (e) {
          if (!stopped) setError(e instanceof Error ? e.message : 'Could not read build progress.');
        }
      })();
    }, 700);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [job?.id, job?.status]);

  async function build40() {
    if (!url.trim()) return;
    setError('');
    setAnalysis(null);
    setJob(null);
    setBusyImport(true);
    setPhase('1/2 · Reading the full answered Google Form: questions, answers, images and YouTube links…');
    try {
      const imported = await jsonApi<{ ok: true; analysis: ImportAnalysis }>('/api/import/google-form', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim() })
      });
      setAnalysis(imported.analysis);
      setPhase(`2/2 · Form analyzed: ${imported.analysis.counts.questions} references, ${imported.analysis.counts.youtube} YouTube source(s). Starting hybrid 40Q build…`);
      const started = await jsonApi<{ ok: true; job: GenerationJob }>('/api/exam/generate-40-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ analysis: imported.analysis, name: `One-Click EPS 40Q ${new Date().toLocaleDateString('en-CA')}` })
      });
      setJob(started.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'One-click build failed.');
      setPhase('Stopped. Fix the message below and press BUILD 40Q again.');
    } finally {
      setBusyImport(false);
    }
  }

  if (minimized) return <button className="one-click-reopen" onClick={() => setMinimized(false)}>ONE CLICK 40Q</button>;

  const percent = busyImport && !job ? 4 : job?.percent ?? 0;
  const running = busyImport || !!job && ['queued', 'running'].includes(job.status);
  const recentLogs = job?.logs.slice(-5).reverse() ?? [];

  return <aside className={`one-click-build ${running ? 'running' : ''}`}>
    <div className="one-click-head">
      <div>
        <span className="one-click-badge">HYBRID v0.4</span>
        <strong>Answered Google Form → Fresh EPS 40Q</strong>
      </div>
      <button className="one-click-minimize" onClick={() => setMinimized(true)} aria-label="Minimize">—</button>
    </div>
    <div className="one-click-input-row">
      <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Paste Google Forms viewscore / answered result link" disabled={running} />
      <button onClick={build40} disabled={running || !url.trim()}>{running ? 'BUILDING…' : 'BUILD 40Q'}</button>
    </div>
    <div className="one-click-progress-row">
      <div className="one-click-track"><div className="one-click-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>
      <b>{Math.round(percent)}%</b>
    </div>
    <p className="one-click-phase">{phase}</p>
    {analysis && <div className="one-click-metrics">
      <span>{analysis.counts.questions} refs</span><span>{analysis.counts.listening} listening</span><span>{analysis.counts.answersDetected} answers</span><span>{analysis.counts.youtube} YouTube</span>
    </div>}
    {!!recentLogs.length && <div className="one-click-logs">{recentLogs.map(log => <div key={log.id}><b>{log.question ? `Q${log.question}` : log.stage}</b><span>{log.message}</span></div>)}</div>}
    {error && <div className="one-click-error">{friendly(error)}</div>}
    <small>Normal workflow is one button. Captions → Gemini video alignment → Whisper/audio fallback → FFmpeg clip run automatically when available. Review stays optional.</small>
  </aside>;
}
