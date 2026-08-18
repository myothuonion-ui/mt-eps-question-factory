import { useMemo, useState } from 'react';
import type { ExamSet, ImportAnalysis, NormalizedQuestion } from './shared/types';

type ImportResponse = { ok: true; analysis: ImportAnalysis } | { ok: false; error: string };
type BuildResponse = { ok: true; set: ExamSet } | { ok: false; error: string };

function confidenceLabel(value: number) {
  if (value >= 0.8) return 'high';
  if (value >= 0.6) return 'medium';
  return 'low';
}

export function App() {
  const [url, setUrl] = useState('');
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [set40, setSet40] = useState<ExamSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const qaFlagCount = useMemo(() => analysis?.questions.filter(q => q.qaFlags.length > 0).length ?? 0, [analysis]);

  async function analyze() {
    setLoading(true);
    setError('');
    setAnalysis(null);
    setSet40(null);
    setReviewOpen(false);
    try {
      const response = await fetch('/api/import/google-form', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = (await response.json()) as ImportResponse;
      if (!data.ok) throw new Error(data.error);
      setAnalysis(data.analysis);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  }

  async function build40() {
    if (!analysis) return;
    setLoading(true);
    setError('');
    setReviewOpen(false);
    try {
      const response = await fetch('/api/exam/build-40', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questions: analysis.questions })
      });
      const data = (await response.json()) as BuildResponse;
      if (!data.ok) throw new Error(data.error);
      setSet40(data.set);
    } catch (e) {
      setError(e instanceof Error ? e.message : '40Q build failed');
    } finally {
      setLoading(false);
    }
  }

  function updateQuestion(id: string, patch: Partial<NormalizedQuestion>) {
    setAnalysis(current => current ? {
      ...current,
      questions: current.questions.map(q => q.id === id ? { ...q, ...patch } : q)
    } : current);
    setSet40(current => current ? {
      ...current,
      slots: current.slots.map(slot => slot.question?.id === id
        ? { ...slot, question: { ...slot.question, ...patch } }
        : slot)
    } : current);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand-mark">MT</div>
          <h1>EPS Question Factory</h1>
          <p>Teacher Production Studio</p>
        </div>
        <nav>
          <span className="active">01 Source Inbox</span>
          <span>02 Analyzer</span>
          <span>03 Pattern Lab</span>
          <span>04 40Q Builder</span>
          <span>05 Listening Factory</span>
          <span>06 QA</span>
          <span>07 Review · Optional</span>
        </nav>
        <div className="sidebar-note">The factory finishes all 40 first. Review is optional afterwards.</div>
      </aside>

      <section className="workspace">
        <header className="hero">
          <div>
            <span className="eyebrow">STAGE 1 · v0.1.0</span>
            <h2>Google Form → analyzed 40Q pipeline</h2>
            <p>Paste a Google Forms viewscore/result link. The factory extracts question structure, answer evidence, media, YouTube references, type and Chapter 1–60 hints. QA flags never stop the build.</p>
          </div>
          <div className="status-pill">Standalone project</div>
        </header>

        <section className="panel import-panel">
          <div className="panel-heading">
            <div><span className="step">01</span><h3>Source Inbox</h3></div>
            <span className="subtle">Google Forms active · ZIP/PDF/Image/Video next</span>
          </div>
          <div className="url-row">
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="Paste Google Forms viewscore link"
              spellCheck={false}
            />
            <button onClick={analyze} disabled={!url || loading}>{loading ? 'Working…' : 'Analyze Source'}</button>
          </div>
          <div className="source-types">
            <span className="ready">Google Form</span><span>ZIP</span><span>PDF</span><span>Images</span><span>XLSX/CSV</span><span>Audio</span><span>Video</span><span>YouTube</span>
          </div>
          {error && <div className="error-box">{error}</div>}
        </section>

        {analysis && (
          <>
            <section className="metrics">
              <Metric label="Questions" value={analysis.counts.questions} />
              <Metric label="Listening" value={analysis.counts.listening} />
              <Metric label="Reading/Other" value={analysis.counts.reading} />
              <Metric label="Answers found" value={analysis.counts.answersDetected} />
              <Metric label="Images" value={analysis.counts.images} />
              <Metric label="YouTube" value={analysis.counts.youtube} />
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div><span className="step">02</span><h3>Analysis</h3></div>
                <span className="subtle">{analysis.sourceTitle}</span>
              </div>
              <div className="analysis-toolbar">
                <div><strong>{analysis.questions.length}</strong> normalized questions</div>
                <div><strong>{qaFlagCount}</strong> QA flags recorded · no blocking</div>
                <button className="secondary" onClick={build40} disabled={loading}>Continue to 40Q</button>
              </div>
              <div className="question-grid">
                {analysis.questions.map(question => (
                  <article className="question-card" key={question.id}>
                    <div className="question-meta">
                      <span>Q{String(question.sourceOrder).padStart(2, '0')}</span>
                      <span>{question.type}</span>
                      <span className={`confidence ${confidenceLabel(question.chapter.confidence)}`}>
                        Ch {question.chapter.chapter ?? '?'} · {Math.round(question.chapter.confidence * 100)}%
                      </span>
                    </div>
                    <h4>{question.stem}</h4>
                    <ol>
                      {question.options.map((option, i) => <li className={question.correctAnswerIndex === i ? 'correct' : ''} key={`${question.id}-${i}`}>{option}</li>)}
                    </ol>
                    <div className="card-footer">
                      <div className="tags">
                        {question.media.map((m, i) => <span key={`${m.kind}-${i}`}>{m.kind}</span>)}
                        {question.qaFlags.map(flag => <span className="warn" key={flag}>{flag}</span>)}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}

        {set40 && (
          <section className="panel">
            <div className="panel-heading">
              <div><span className="step">04</span><h3>40Q Set</h3></div>
              <span className={set40.complete ? 'complete-badge' : 'pending-badge'}>{set40.complete ? '40 / 40 complete' : `${set40.slots.filter(s => s.question).length} / 40 imported`}</span>
            </div>
            <p className="review-policy">No review gate. The next generator stage will automatically fill missing slots, then Listening + QA will finish the set. Only after 40/40 is complete will optional review be offered.</p>
            <div className="slot-grid">
              {set40.slots.map(slot => (
                <div className={`slot ${slot.question ? 'filled' : 'missing'}`} key={slot.slot}>
                  <strong>{slot.slot}</strong>
                  <span>{slot.section}</span>
                  <small>{slot.question ? slot.question.type : 'generation required'}</small>
                </div>
              ))}
            </div>
            {set40.complete && (
              <div className="analysis-toolbar review-launcher">
                <div><strong>40/40 finished.</strong> Use now, or open review only if you want to change something.</div>
                <button className="secondary" onClick={() => setReviewOpen(value => !value)}>{reviewOpen ? 'Close Review' : 'Open Optional Review'}</button>
              </div>
            )}
          </section>
        )}

        {set40?.complete && reviewOpen && (
          <section className="panel">
            <div className="panel-heading">
              <div><span className="step">07</span><h3>Optional Review</h3></div>
              <span className="subtle">Edit only what you want. No forced approval step.</span>
            </div>
            <div className="question-grid">
              {set40.slots.map(slot => slot.question && (
                <article className="question-card" key={`review-${slot.question.id}`}>
                  <div className="question-meta"><span>Q{String(slot.slot).padStart(2, '0')}</span><span>{slot.section}</span><span>{slot.question.type}</span></div>
                  {editingId === slot.question.id ? (
                    <QuestionEditor question={slot.question} onChange={patch => updateQuestion(slot.question!.id, patch)} />
                  ) : (
                    <>
                      <h4>{slot.question.stem}</h4>
                      <ol>{slot.question.options.map((option, i) => <li className={slot.question!.correctAnswerIndex === i ? 'correct' : ''} key={i}>{option}</li>)}</ol>
                    </>
                  )}
                  <div className="card-footer">
                    <div className="tags">{slot.question.qaFlags.map(flag => <span className="warn" key={flag}>{flag}</span>)}</div>
                    <button className="text-button" onClick={() => setEditingId(editingId === slot.question!.id ? null : slot.question!.id)}>{editingId === slot.question.id ? 'Done' : 'Edit Question'}</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

function QuestionEditor({ question, onChange }: { question: NormalizedQuestion; onChange: (patch: Partial<NormalizedQuestion>) => void }) {
  return (
    <div className="editor">
      <textarea value={question.stem} onChange={e => onChange({ stem: e.target.value })} />
      {question.options.map((option, index) => (
        <div className="option-edit" key={index}>
          <input type="radio" checked={question.correctAnswerIndex === index} onChange={() => onChange({ correctAnswerIndex: index })} />
          <input value={option} onChange={e => {
            const options = [...question.options];
            options[index] = e.target.value;
            onChange({ options });
          }} />
        </div>
      ))}
      <div className="source-types"><span>Regenerate question · Stage 3</span><span>Regenerate choices · Stage 3</span><span>Audio only · Listening Stage</span></div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}
