import { useEffect, useMemo, useState } from 'react';
import type { AgentName, GenerationJob } from './shared/types';

async function jsonApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data as T;
}

function friendly(text: string) {
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(text)) return 'Gemini quota is limited right now. The Controller will keep using captions/Whisper and GLM fallback when configured.';
  return text.length > 420 ? `${text.slice(0, 417)}...` : text;
}

const workerAgents: AgentName[] = ['Form Agent', 'Structure Agent', 'Media Agent', 'Alignment Agent', 'Generator Agent', 'QA Agent'];

export function OneClickBuild() {
  const [minimized, setMinimized] = useState(false);
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState('Paste an answered Google Forms score/result link.');
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('mt-open-finished-set') !== '1') return;
    localStorage.removeItem('mt-open-finished-set');
    const timer = window.setTimeout(() => {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent?.includes('02 40Q Builder')) as HTMLButtonElement | undefined;
      button?.click();
    }, 1300);
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
            setPhase('40/40 complete. Reading 20 + Listening 20 are ready. Opening the finished set…');
            localStorage.setItem('mt-open-finished-set', '1');
            window.setTimeout(() => window.location.reload(), 900);
          } else if (result.job.status === 'failed') {
            setError(result.job.error ?? '40Q build stopped.');
          }
        } catch (e) {
          if (!stopped) setError(e instanceof Error ? e.message : 'Could not read build progress.');
        }
      })();
    }, 650);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [job?.id, job?.status]);

  async function build40() {
    if (!url.trim()) return;
    setError('');
    setJob(null);
    setStarting(true);
    setPhase('Controller Agent is starting the Form → Structure → Media/Alignment → Generator → QA pipeline…');
    try {
      const started = await jsonApi<{ ok: true; job: GenerationJob }>('/api/agent/build-form-40-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), name: `Controller EPS 40Q ${new Date().toLocaleDateString('en-CA')}` })
      });
      setJob(started.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'One-click Controller build failed.');
      setPhase('Stopped. Fix the message below and press BUILD 40Q again.');
    } finally {
      setStarting(false);
    }
  }

  const agentState = useMemo(() => {
    const touched = new Set((job?.logs ?? []).map(log => log.agent).filter(Boolean));
    return workerAgents.map(agent => ({
      agent,
      state: job?.status === 'completed' || (touched.has(agent) && job?.currentAgent !== agent) ? 'done' : job?.currentAgent === agent ? 'active' : 'waiting'
    }));
  }, [job]);

  if (minimized) return <button className="one-click-reopen" onClick={() => setMinimized(false)}>CONTROLLER 40Q</button>;

  const percent = starting && !job ? 1 : job?.percent ?? 0;
  const running = starting || !!job && ['queued', 'running'].includes(job.status);
  const recentLogs = job?.logs.slice(-8).reverse() ?? [];
  const summary = job?.summary;

  return <aside className={`one-click-build ${running ? 'running' : ''}`}>
    <div className="one-click-head">
      <div>
        <span className="one-click-badge">CONTROLLER AGENTS v0.5</span>
        <strong>Answered Google Form → Reading 20 → Listening 20 → Fresh 40Q</strong>
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

    <div className="one-click-now">
      <span>{job?.currentAgent ?? 'Controller Agent'}</span>
      <strong>{job?.currentQuestion ? `Q${job.currentQuestion}` : job?.stage ?? 'ready'}</strong>
      <em>{job?.provider && job.provider !== 'pending' ? job.provider : 'waiting'}</em>
    </div>
    <p className="one-click-phase">{phase}</p>

    <div className="one-click-agents">
      {agentState.map(item => <div key={item.agent} className={`agent-pill ${item.state}`}>
        <span>{item.state === 'done' ? '✓' : item.state === 'active' ? '●' : '○'}</span>{item.agent.replace(' Agent', '')}
      </div>)}
    </div>

    {summary && <div className="one-click-metrics">
      <span>{summary.references} source refs</span>
      <span>Reading {summary.reading}</span>
      <span>Listening {summary.listening}</span>
      <span>{summary.answers} answers</span>
      <span>{summary.youtube} YouTube</span>
      <span>{summary.sectionOrder.join(' → ')}</span>
    </div>}

    {!!recentLogs.length && <div className="one-click-logs">{recentLogs.map(log => <div key={log.id}>
      <b>{log.question ? `Q${log.question}` : log.agent?.replace(' Agent', '') ?? log.stage}</b>
      <span><i>{log.agent ?? 'Controller'}</i>{log.message}</span>
    </div>)}</div>}

    {error && <div className="one-click-error">{friendly(error)}</div>}
    <small>Normal use is one link + one button. The Form order is the source of truth: section headers and YouTube placement are detected first; YouTube is analyzed once and reused across Listening questions. Review happens only after 40/40 if you want it.</small>
  </aside>;
}
