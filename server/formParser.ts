import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { classifyChapter, classifyType } from './analyzer.js';
import type { AnalysisDiagnostics, ImportAnalysis, MediaRef, NormalizedQuestion } from '../src/shared/types.js';

const GOOGLE_FORMS_HOST = 'docs.google.com';

function clean(value: string | undefined | null) {
  return (value ?? '').replace(/\u200b/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stableId(url: string, order: number, stem: string) {
  return createHash('sha256').update(`${url}|${order}|${stem}`).digest('hex').slice(0, 16);
}

function canonicalYoutube(raw: string): string | null {
  try {
    const normalized = raw.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const url = new URL(normalized, 'https://docs.google.com');
    if (url.hostname.includes('youtube.com') || url.hostname === 'youtu.be') return url.toString();
  } catch {}
  const match = raw.match(/https?:\\?\/\\?\/(?:www\.)?(?:youtube\.com|youtu\.be)[^"'<>\s\\]+/i);
  return match ? match[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/') : null;
}

function uniqueMedia(media: MediaRef[]) {
  return [...new Map(media.map(item => [`${item.kind}:${item.url}`, item])).values()];
}

function collectMedia($: cheerio.CheerioAPI, el: any): MediaRef[] {
  const media: MediaRef[] = [];
  $(el).find('img[src]').each((_, node) => {
    const src = $(node).attr('src');
    if (src && !/googleusercontent\.com\/favicon|gstatic\.com\/forms/i.test(src)) media.push({ kind: 'image', url: src });
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
  return uniqueMedia(media);
}

function optionText($: cheerio.CheerioAPI, node: any) {
  const own = clean($(node).text());
  const aria = clean($(node).attr('aria-label'));
  const value = own || aria;
  if (!value || value.length > 700) return '';
  if (/^(correct answer|incorrect|correct|answer|정답|오답|점수|points?|required)$/i.test(value)) return '';
  if (/^\d+(?:\.\d+)?\s*(?:\/|of)\s*\d+(?:\.\d+)?\s*(?:points?)?$/i.test(value)) return '';
  return value;
}

function optionCandidates($: cheerio.CheerioAPI, el: any) {
  const selectors = [
    '.docssharedWizToggleLabeledLabelText',
    '.aDTYNe',
    '[role="radio"]',
    '[role="checkbox"]',
    '.Od2TWd',
    'label'
  ];
  let best: string[] = [];
  for (const selector of selectors) {
    const out: string[] = [];
    $(el).find(selector).each((_, node) => {
      const text = optionText($, node);
      if (text && !out.includes(text)) out.push(text);
    });
    if (out.length === 4) return out;
    if (out.length > best.length && out.length <= 10) best = out;
  }
  return best.slice(0, 10);
}

function questionStem($: cheerio.CheerioAPI, el: any) {
  const selectors = ['.M7eMe', '.HoXoMd', '[role="heading"]', '.freebirdFormviewerViewItemsItemItemTitle'];
  for (const selector of selectors) {
    const text = clean($(el).find(selector).first().text());
    if (text && text.length <= 4000) return text.replace(/^\s*\d+[.)]\s*/, '');
  }
  const text = clean($(el).text());
  return text.slice(0, 1500);
}

function selectedOptionIndex($: cheerio.CheerioAPI, el: any, options: string[]) {
  let index: number | null = null;
  $(el).find('[aria-checked="true"], [data-is-selected="true"]').each((_, node) => {
    if (index !== null) return;
    const text = optionText($, node) || optionText($, $(node).closest('label').get(0));
    const found = options.findIndex(option => text.includes(option) || option.includes(text));
    if (found >= 0) index = found;
  });
  return index;
}

function detectCorrectAnswer($: cheerio.CheerioAPI, el: any, options: string[]) {
  let evidence: string | null = null;
  let index: number | null = null;

  $(el).find('[aria-label*="Correct" i], [data-correct="true"], [class*="correct" i]').each((_, node) => {
    if (index !== null) return;
    const text = clean($(node).text()) || clean($(node).attr('aria-label')) || clean($(node).parent().text());
    const found = options.findIndex(option => text.includes(option) || option.includes(text));
    if (found >= 0) { index = found; evidence = text; }
  });

  const all = clean($(el).text());
  if (index === null) {
    const marker = all.match(/(?:Correct answer|정답(?:입니다)?|정답\s*:|Answer)\s*[:：]?\s*(.{1,220}?)(?=(?:\d+(?:\.\d+)?\s*(?:\/|of)\s*\d+)|$)/i)?.[1];
    if (marker) {
      const normalizedMarker = clean(marker);
      const found = options.findIndex(option => normalizedMarker.includes(option) || option.includes(normalizedMarker));
      if (found >= 0) index = found;
      evidence = normalizedMarker;
    }
  }

  // On score pages, a selected answer is authoritative when the item itself is marked full-score/correct.
  if (index === null) {
    const score = all.match(/(\d+(?:\.\d+)?)\s*(?:\/|of)\s*(\d+(?:\.\d+)?)(?:\s*points?)?/i);
    const correctWord = /\bCorrect\b|정답입니다|맞았습니다/i.test(all);
    if ((score && Number(score[2]) > 0 && Number(score[1]) >= Number(score[2])) || correctWord) {
      const selected = selectedOptionIndex($, el, options);
      if (selected !== null) {
        index = selected;
        evidence = score ? `Selected answer received ${score[1]}/${score[2]}` : 'Selected answer marked correct';
      }
    }
  }

  return { index, evidence };
}

const BLOCK_SELECTORS = [
  '.Qr7Oae',
  'div[role="listitem"][data-params]',
  'div[role="listitem"]',
  '.geS5n',
  '.freebirdFormviewerViewItemsItemItem'
];

function usableBlock($: cheerio.CheerioAPI, node: any) {
  const stem = questionStem($, node);
  if (!stem || stem.length < 2) return false;
  const options = optionCandidates($, node);
  const media = collectMedia($, node);
  return options.length >= 2 || media.length > 0 || /\?|고르|무엇|어디|언제|누구|왜|어떻게|알맞|맞는|틀린|내용|빈칸|그림|사진|듣/i.test(stem);
}

function findQuestionBlocks($: cheerio.CheerioAPI) {
  const candidates = BLOCK_SELECTORS.map(selector => {
    const nodes = $(selector).toArray().filter(node => usableBlock($, node));
    const fourOption = nodes.filter(node => optionCandidates($, node).length === 4).length;
    return { selector, nodes, fourOption };
  });
  const counts = Object.fromEntries(candidates.map(item => [item.selector, item.nodes.length]));
  candidates.sort((a, b) => (b.fourOption - a.fourOption) || (b.nodes.length - a.nodes.length));
  const best = candidates[0];
  return { nodes: best?.nodes ?? [], selector: best?.selector ?? 'none', counts };
}

function globalYoutubeUrls($: cheerio.CheerioAPI, html: string) {
  const urls = new Set<string>();
  $('iframe[src], a[href]').each((_, node) => {
    const yt = canonicalYoutube($(node).attr('src') ?? $(node).attr('href') ?? '');
    if (yt) urls.add(yt);
  });
  for (const match of html.matchAll(/https?:\\?\/\\?\/(?:www\.)?(?:youtube\.com|youtu\.be)[^"'<>\s\\]+/gi)) {
    const yt = canonicalYoutube(match[0]);
    if (yt) urls.add(yt);
  }
  return [...urls];
}

export async function importGoogleFormViewScore(sourceUrl: string): Promise<ImportAnalysis> {
  const parsed = new URL(sourceUrl);
  if (parsed.hostname !== GOOGLE_FORMS_HOST || !parsed.pathname.includes('/forms/')) {
    throw new Error('Only Google Forms URLs are supported by this importer.');
  }

  const response = await fetch(sourceUrl, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MT-EPS-Question-Factory/0.3',
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });
  if (!response.ok) throw new Error(`Google Form fetch failed: HTTP ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const sourceTitle = clean($('meta[property="og:title"]').attr('content')) || clean($('title').text()) || 'Google Form';
  const found = findQuestionBlocks($);
  const questions: NormalizedQuestion[] = [];
  const seen = new Set<string>();

  found.nodes.forEach(block => {
    const stem = questionStem($, block);
    if (!stem || stem.length < 2) return;
    const options = optionCandidates($, block).filter(option => option !== stem).slice(0, 4);
    const fingerprint = `${stem.toLowerCase()}|${options.join('|').toLowerCase()}`;
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

  const youtubeUrls = globalYoutubeUrls($, html);
  const globalImages = new Set<string>();
  $('img[src]').each((_, node) => {
    const src = $(node).attr('src');
    if (src && !/googleusercontent\.com\/favicon|gstatic\.com\/forms/i.test(src)) globalImages.add(src);
  });

  // EPS 40Q score forms commonly place shared YouTube players outside individual question blocks.
  // When that structure is detected, map the shared players across the first 20 listening slots.
  let inferredListening = false;
  if (youtubeUrls.length > 0 && questions.length >= 35 && questions.filter(q => q.type === 'listening').length < 5) {
    inferredListening = true;
    const listeningCount = Math.min(20, questions.length);
    for (let i = 0; i < listeningCount; i += 1) {
      const q = questions[i];
      q.type = 'listening';
      if (!q.media.some(item => item.kind === 'youtube')) {
        const mediaIndex = Math.min(youtubeUrls.length - 1, Math.floor((i * youtubeUrls.length) / listeningCount));
        q.media = uniqueMedia([...q.media, { kind: 'youtube', url: youtubeUrls[mediaIndex], label: `Shared listening source ${mediaIndex + 1}` }]);
      }
      q.qaFlags = q.qaFlags.filter(flag => flag !== 'TYPE_LOW_CONFIDENCE');
    }
  }

  const imageCount = new Set(questions.flatMap(q => q.media.filter(m => m.kind === 'image').map(m => m.url))).size;
  const linkedYoutube = new Set(questions.flatMap(q => q.media.filter(m => m.kind === 'youtube').map(m => m.url)));
  const optionHistogram: Record<string, number> = {};
  for (const question of questions) optionHistogram[String(question.options.length)] = (optionHistogram[String(question.options.length)] ?? 0) + 1;
  const warnings: string[] = [];
  if (questions.length !== 40) warnings.push(`Detected ${questions.length} question blocks, not 40. Check extracted references before generation.`);
  if (questions.filter(q => q.options.length === 4).length !== questions.length) warnings.push('Some detected blocks do not have exactly four choices.');
  if (questions.filter(q => q.correctAnswerIndex !== null).length < questions.length) warnings.push('Some correct answers could not be proven from the score page and are flagged instead of guessed.');
  if (inferredListening) warnings.push('Shared YouTube sources were mapped across the first 20 EPS listening slots because the players are outside individual question blocks.');

  const diagnostics: AnalysisDiagnostics = {
    parserStrategy: `${found.selector}${inferredListening ? ' + EPS shared-YouTube mapping' : ''}`,
    candidateBlockCounts: found.counts,
    selectedBlockCount: found.nodes.length,
    rawHtmlBytes: Buffer.byteLength(html, 'utf8'),
    optionHistogram,
    globalYoutube: youtubeUrls.length,
    globalImages: globalImages.size,
    answerEvidenceCount: questions.filter(q => !!q.answerEvidence).length,
    warnings
  };

  return {
    sourceUrl,
    sourceTitle,
    importedAt: new Date().toISOString(),
    mediaPool: [
      ...youtubeUrls.map(url => ({ kind: 'youtube' as const, url })),
      ...[...globalImages].map(url => ({ kind: 'image' as const, url }))
    ],
    diagnostics,
    counts: {
      questions: questions.length,
      listening: questions.filter(q => q.type === 'listening').length,
      reading: questions.filter(q => q.type !== 'listening').length,
      images: imageCount,
      youtube: Math.max(linkedYoutube.size, youtubeUrls.length),
      answersDetected: questions.filter(q => q.correctAnswerIndex !== null).length
    },
    questions
  };
}
