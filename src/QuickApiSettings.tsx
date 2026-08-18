import { useEffect, useState } from 'react';

type Settings = {
  order: 'gemini-glm' | 'glm-gemini' | 'gemini' | 'glm' | 'mock';
  batchSize: number;
  gemini: { configured: boolean; model: string };
  glm: { configured: boolean; baseUrl: string; model: string };
  cloudflare: { configured: boolean; accountId: string; imageModel: string };
};

async function readSettings(): Promise<Settings> {
  const res = await fetch('/api/settings/providers');
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data.settings as Settings;
}

export function QuickApiSettings() {
  const [open, setOpen] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [geminiKey, setGeminiKey] = useState('');
  const [glmKey, setGlmKey] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [order, setOrder] = useState<Settings['order']>('gemini-glm');
  const [glmBaseUrl, setGlmBaseUrl] = useState('https://integrate.api.nvidia.com/v1');
  const [glmModel, setGlmModel] = useState('z-ai/glm-5.2');
  const [cfAccountId, setCfAccountId] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    void readSettings().then(value => {
      setSettings(value);
      setOrder(value.order);
      setGlmBaseUrl(value.glm.baseUrl || 'https://integrate.api.nvidia.com/v1');
      setGlmModel(value.glm.model || 'z-ai/glm-5.2');
      setCfAccountId(value.cloudflare.accountId || '');
      if (value.gemini.configured && value.glm.configured && value.cloudflare.configured) setOpen(false);
    }).catch(error => setStatus(error instanceof Error ? error.message : 'Could not load API settings'));
  }, []);

  async function save() {
    setStatus('Saving…');
    try {
      const res = await fetch('/api/settings/providers', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          order,
          batchSize: settings?.batchSize ?? 5,
          geminiApiKey: geminiKey,
          geminiModel: settings?.gemini.model || 'gemini-2.5-flash',
          glmApiKey: glmKey,
          glmBaseUrl,
          glmModel,
          cloudflareApiToken: cfToken,
          cloudflareAccountId: cfAccountId,
          cloudflareImageModel: settings?.cloudflare.imageModel || '@cf/black-forest-labs/flux-1-schnell'
        })
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setSettings(data.settings);
      setGeminiKey(''); setGlmKey(''); setCfToken('');
      setStatus('Saved locally ✓');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    }
  }

  if (!open) return <button className="quick-api-toggle" onClick={() => setOpen(true)}>API Keys</button>;

  return <aside className="quick-api-panel">
    <div className="quick-api-head"><div><strong>API Keys</strong><span>Local only</span></div><button onClick={() => setOpen(false)}>×</button></div>
    <label>Priority<select value={order} onChange={e => setOrder(e.target.value as Settings['order'])}><option value="gemini-glm">Gemini → GLM fallback</option><option value="glm-gemini">GLM → Gemini fallback</option><option value="gemini">Gemini only</option><option value="glm">GLM only</option></select></label>
    <div className="quick-provider"><div><b>Gemini</b><em>{settings?.gemini.configured ? 'saved' : 'no key'}</em></div><input type="password" value={geminiKey} onChange={e => setGeminiKey(e.target.value)} placeholder={settings?.gemini.configured ? 'Saved — leave blank to keep' : 'Paste Gemini API key'} /></div>
    <div className="quick-provider"><div><b>GLM 5.2</b><em>{settings?.glm.configured ? 'saved' : 'no key'}</em></div><input type="password" value={glmKey} onChange={e => setGlmKey(e.target.value)} placeholder={settings?.glm.configured ? 'Saved — leave blank to keep' : 'Paste NVIDIA / GLM API key'} /><input value={glmBaseUrl} onChange={e => setGlmBaseUrl(e.target.value)} placeholder="GLM base URL" /><input value={glmModel} onChange={e => setGlmModel(e.target.value)} placeholder="GLM model" /></div>
    <div className="quick-provider"><div><b>Cloudflare</b><em>{settings?.cloudflare.configured ? 'saved' : 'not ready'}</em></div><input type="password" value={cfToken} onChange={e => setCfToken(e.target.value)} placeholder={settings?.cloudflare.configured ? 'Saved — leave blank to keep' : 'Paste Cloudflare API token'} /><input value={cfAccountId} onChange={e => setCfAccountId(e.target.value)} placeholder="Cloudflare Account ID" /></div>
    <button className="quick-api-save" onClick={save}>Save API Keys</button>{status && <div className="quick-api-status">{status}</div>}
  </aside>;
}
