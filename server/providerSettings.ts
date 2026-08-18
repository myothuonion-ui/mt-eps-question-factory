import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProviderOrder, ProviderSettings } from '../src/shared/types.js';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const EXAMPLE_PATH = path.resolve(process.cwd(), '.env.example');

function bool(value: string | undefined) { return !!value?.trim(); }
function normalizedOrder(value?: string): ProviderOrder {
  const allowed: ProviderOrder[] = ['gemini-glm', 'glm-gemini', 'gemini', 'glm', 'mock'];
  if (allowed.includes(value as ProviderOrder)) return value as ProviderOrder;
  const legacy = (process.env.AI_PROVIDER ?? '').toLowerCase();
  if (legacy === 'gemini') return 'gemini-glm';
  if (legacy === 'openai-compatible') return 'glm-gemini';
  return 'mock';
}

async function ensureEnv() {
  try { await fs.access(ENV_PATH); return; } catch {}
  try { await fs.copyFile(EXAMPLE_PATH, ENV_PATH); } catch { await fs.writeFile(ENV_PATH, '', 'utf8'); }
}

async function updateEnv(values: Record<string, string | undefined>) {
  await ensureEnv();
  let text = await fs.readFile(ENV_PATH, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const safe = value.replace(/\r?\n/g, '');
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${key}=${safe}`);
    else text += `${text.endsWith('\n') || !text ? '' : '\n'}${key}=${safe}\n`;
    process.env[key] = safe;
  }
  await fs.writeFile(ENV_PATH, text, 'utf8');
}

export function getProviderSettings(): ProviderSettings {
  return {
    order: normalizedOrder(process.env.AI_PROVIDER_ORDER),
    batchSize: Math.max(1, Math.min(8, Number(process.env.AI_BATCH_SIZE ?? 5) || 5)),
    gemini: {
      configured: bool(process.env.GEMINI_API_KEY),
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
    },
    glm: {
      configured: bool(process.env.GLM_API_KEY ?? process.env.AI_API_KEY),
      baseUrl: process.env.GLM_BASE_URL ?? process.env.AI_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
      model: process.env.GLM_MODEL ?? process.env.AI_MODEL ?? 'z-ai/glm-5.2'
    },
    cloudflare: {
      configured: bool(process.env.CLOUDFLARE_API_TOKEN) && bool(process.env.CLOUDFLARE_ACCOUNT_ID),
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
      imageModel: process.env.CLOUDFLARE_IMAGE_MODEL ?? '@cf/black-forest-labs/flux-1-schnell'
    }
  };
}

export type ProviderSettingsInput = {
  order?: ProviderOrder;
  batchSize?: number;
  geminiApiKey?: string;
  geminiModel?: string;
  glmApiKey?: string;
  glmBaseUrl?: string;
  glmModel?: string;
  cloudflareApiToken?: string;
  cloudflareAccountId?: string;
  cloudflareImageModel?: string;
};

export async function saveProviderSettings(input: ProviderSettingsInput) {
  const current = getProviderSettings();
  const order = input.order ?? current.order;
  const values: Record<string, string | undefined> = {
    AI_PROVIDER_ORDER: order,
    AI_BATCH_SIZE: input.batchSize !== undefined ? String(Math.max(1, Math.min(8, Math.round(input.batchSize)))) : undefined,
    GEMINI_MODEL: input.geminiModel?.trim() || undefined,
    GLM_BASE_URL: input.glmBaseUrl?.trim() || undefined,
    GLM_MODEL: input.glmModel?.trim() || undefined,
    CLOUDFLARE_ACCOUNT_ID: input.cloudflareAccountId?.trim() || undefined,
    CLOUDFLARE_IMAGE_MODEL: input.cloudflareImageModel?.trim() || undefined,
    // Keep legacy variables synchronized so old code paths and local launchers still work.
    AI_PROVIDER: order.startsWith('gemini') ? 'gemini' : order.startsWith('glm') ? 'openai-compatible' : 'mock',
    AI_BASE_URL: input.glmBaseUrl?.trim() || undefined,
    AI_MODEL: input.glmModel?.trim() || undefined
  };
  if (input.geminiApiKey?.trim()) values.GEMINI_API_KEY = input.geminiApiKey.trim();
  if (input.glmApiKey?.trim()) {
    values.GLM_API_KEY = input.glmApiKey.trim();
    values.AI_API_KEY = input.glmApiKey.trim();
  }
  if (input.cloudflareApiToken?.trim()) values.CLOUDFLARE_API_TOKEN = input.cloudflareApiToken.trim();
  await updateEnv(values);
  return getProviderSettings();
}
