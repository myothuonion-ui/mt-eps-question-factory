import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { classifyChapter, classifyType } from './analyzer.js';
import type { ImportAnalysis, MediaRef, NormalizedQuestion } from '../src/shared/types.js';

const GOOGLE_FORMS_HOST = 'docs.google.com';

function clean(value: string | undefined | null) {
  return (value ?? '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

function stableId(url: string, order: number, stem: string) {
  return createHash('sha256').update(`${url}|${order}|${stem}`).digest('hex').slice(0, 16);
}

function canonicalYoutube(raw: string): string | null {
  try {
    const url = new URL(raw, 'https://docs.google.com');
    if (url.hostname.includes('youtube.com') || url.hostname === 'youtu.be') return url.toString();
  } catch {}
  const match = raw.match(/https?:\\?\/\\?\/(?:www\.)?(?:youtube\.com|youtu\.be)[^"'<>\s\\]+/i);
  return match ? match[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/') : null;
}

function collectMedia($: cheerio.CheerioAPI, el: any): MediaRef[] {
  const media: MediaRef[] = [];
  $(el).find('img[src]').each((_, node) => {
    const src = $(node).attr('src');
    if (src) media.push({ kind: 'image', url: src });
  });
  $(el).find('iframe[src], a[href]').each((_, node) => {
    const raw = $(node).attr('src') ?? $(node).attr('href') ?? '';
    const yt = canonicalYoutube(raw);
    if (yt) media.push({ kind: 'youtube', url: yt });
  });
  const html = $.html(el);
  for (const match of html.matchAll(/https?:\\?\/\\?\/(?:www\.)?(?:youtube\.com|youtu\.be)[^"'<>\s\\]+/gi)) {
    const yt = canonicalYoutube(match[0]);
    if (yt) media.push({ kind: 'youtube', url: yt });
  }
  return [...new Map(media.map(item => [`${item.kind}:${item.url}`, item])).values()];
}

function optionCandidates($: cheerio.CheerioAPI, el: any) {
  const selectors = [
    '.aDTYNe',
    '.docssharedWizToggleLabeledLabelText',
    '.Od2TWd',
    '[role="radio"]',
    '[role="checkbox"]',
    'label'
  ];
  const out: string[] = [];
  for (const selector of selectors) {
    $(el).find(selector).each((_, node) => {
      const text = clean($(node).text());
      if (text && text.length <= 500 && !out.includes(text)) out.push(text);
    });
    if (out.length >= 2) break;
  }
  return out.slice(0, 10);
}

function questionStem($: cheerio.CheerioAPI, el: any) {
  const selectors = ['.M7eMe', '.HoXoMd', '[role="heading"]', '.freebirdFormviewerViewItemsItemItemTitle'];
  for (const selector of selectors) {
    const text = clean($(el).find(selector).first().text());
    if (text) return text.replace(/^\d+[.)]\s*/, '');
  }
  const text = clean($(el).text());
  return text.slice(0, 1000);
}

function detectCorrectAnswer($: cheerio.CheerioAPI, el: any, options: string[]) {
  let evidence: string | null = null;
  let index: number | null = null;

  $(el).find('[aria-label*="Correct"], [aria-label*="correct"], [data-correct="true"]').each((_, node) => {
    const text = clean($(node).text()) || clean($(node).attr('aria-label'));
    const found = options.findIndex(option => text.includes(option));
    if (found >= 0 && index === null) {
      index = found;
      evidence = text;
    }
  });

  if (index === null) {
    const all = clean($(el).text());
    const marker = all.match(/(?:Correct answer|정답|정답입니다|정답:|Answer)\s*[:：]?\s*([^\n]{1,180})/i)?.[1];
    if (marker) {
      const found = options.findIndex(option => marker.includes(option) || option.includes(marker));
      if (found >= 0) index = found;
      evidence = marker;
    }
  }

  return { index, evidence };
}

function findQuestionBlocks($: cheerio.CheerioAPI) {
  const selectors = ['div[role="listitem"]', '.Qr7Oae', '.geS5n', '.freebirdFormviewerViewItemsItemItem'];
  for (const selector of selectors) {
    const nodes = $(selector).toArray().filter(node => clean($(node).text()).length > 3);
    if (nodes.length >= 2) return nodes;
  }
  return [];
}

export async function importGoogleFormViewScore(sourceUrl: string): Promise<ImportAnalysis> {
  const parsed = new URL(sourceUrl);
  if (parsed.hostname !== GOOGLE_FORMS_HOST || !parsed.pathname.includes('/forms/')) {
    throw new Error('Only Google Forms URLs are supported by this Stage 1 importer.');
  }

  const response = await fetch(sourceUrl, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 MT-EPS-Question-Factory/0.1',
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8'
    }
  });
  if (!response.ok) throw new Error(`Google Form fetch failed: HTTP ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const sourceTitle = clean($('meta[property="og:title"]').attr('content')) || clean($('title').text()) || 'Google Form';
  const blocks = findQuestionBlocks($);
  const questions: NormalizedQuestion[] = [];
  const seen = new Set<string>();

  blocks.forEach(block => {
    const stem = questionStem($, block);
    if (!stem || stem.length < 2) return;
    const options = optionCandidates($, block).filter(option => option !== stem);
    const fingerprint = `${stem}|${options.join('|')}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);

    const media = collectMedia($, block);
    const answer = detectCorrectAnswer($, block, options);
    const combined = `${stem} ${options.join(' ')}`;
    const type = classifyType(stem, options.join(' '), media.some(m => m.kind === 'youtube'), media.some(m => m.kind === 'image'));
    const chapter = classifyChapter(combined);
    const qaFlags: string[] = [];
    if (options.length !== 4) qaFlags.push(`OPTIONS_${options.length}`);
    if (answer.index === null) qaFlags.push('ANSWER_NOT_DETECTED');
    if (chapter.chapter === null || chapter.confidence < 0.6) qaFlags.push('CHAPTER_LOW_CONFIDENCE');
    if (type === 'unknown') qaFlags.push('TYPE_LOW_CONFIDENCE');

    const sourceOrder = questions.length + 1;
    questions.push({
      id: stableId(sourceUrl, sourceOrder, stem),
      sourceOrder,
      stem,
      options,
      correctAnswerIndex: answer.index,
      answerEvidence: answer.evidence,
      type,
      chapter,
      media,
      qaFlags,
      provenance: { sourceUrl, sourceTitle }
    });
  });

  const globalYoutube = new Set<string>();
  $('iframe[src], a[href]').each((_, node) => {
    const yt = canonicalYoutube($(node).attr('src') ?? $(node).attr('href') ?? '');
    if (yt) globalYoutube.add(yt);
  });
  for (const match of html.matchAll(/https?:\\?\/\\?\/(?:www\.)?(?:youtube\.com|youtu\.be)[^"'<>\s\\]+/gi)) {
    const yt = canonicalYoutube(match[0]);
    if (yt) globalYoutube.add(yt);
  }

  const imageCount = new Set(questions.flatMap(q => q.media.filter(m => m.kind === 'image').map(m => m.url))).size;
  const linkedYoutube = new Set(questions.flatMap(q => q.media.filter(m => m.kind === 'youtube').map(m => m.url)));

  return {
    sourceUrl,
    sourceTitle,
    importedAt: new Date().toISOString(),
    counts: {
      questions: questions.length,
      listening: questions.filter(q => q.type === 'listening').length,
      reading: questions.filter(q => q.type !== 'listening').length,
      images: imageCount,
      youtube: Math.max(linkedYoutube.size, globalYoutube.size),
      answersDetected: questions.filter(q => q.correctAnswerIndex !== null).length
    },
    questions
  };
}
