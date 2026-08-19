import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { classifyChapter, classifyType } from './analyzer.js';
import type { AnalysisDiagnostics, DetectedSection, ExamSection, ImportAnalysis, MediaRef, NormalizedQuestion } from '../src/shared/types.js';

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
  const selectors = ['.docssharedWizToggleLabeledLabelText', '.aDTYNe', '[role="radio"]', '[role="checkbox"]', '.Od2TWd', 'label'];
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

const BLOCK_SELECTORS = ['.Qr7Oae', 'div[role="listitem"][data-params]', 'div[role="listitem"]', '.geS5n', '.freebirdFormviewerViewItemsItemItem'];

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

function quotedStrings(raw: string) {
  const out: string[] = [];
  for (const match of raw.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    try {
      const value = clean(JSON.parse(`"${match[1]}"`));
      if (value) out.push(value);
    } catch {}
  }
  return out;
}

function usefulParamString(value: string) {
  if (!value || value.length > 600) return false;
  if (/^(entry\.|https?:|mailto:|video\/|image\/|application\/)/i.test(value)) return false;
  if (/^[\d._-]{8,}$/.test(value)) return false;
  if (/^(required|other|correct|incorrect|answer|정답|오답)$/i.test(value)) return false;
  return /[가-힣A-Za-z]/.test(value);
}

function dataParamRecovery($: cheerio.CheerioAPI, positions: Map<any, number>) {
  const recovered: Array<{ stem: string; options: string[]; media: MediaRef[]; node: any; position: number }> = [];
  const seen = new Set<string>();
  $('[data-params]').each((_, node) => {
    const raw = $(node).attr('data-params') ?? '';
    if (raw.length < 30) return;
    const strings = quotedStrings(raw).filter(usefulParamString);
    if (strings.length < 5) return;
    let stemIndex = strings.findIndex(value => value.length >= 2 && value.length <= 350 && /[가-힣?]|고르|알맞|무엇|어디|언제|누구|내용|빈칸|그림|사진|듣/i.test(value));
    if (stemIndex < 0) stemIndex = strings.findIndex(value => value.length >= 4 && value.length <= 350);
    if (stemIndex < 0) return;
    const stem = strings[stemIndex].replace(/^\s*\d+[.)]\s*/, '');
    const options = strings.slice(stemIndex + 1).filter(value => value !== stem && value.length <= 220).filter((value, index, arr) => arr.indexOf(value) === index).slice(0, 4);
    if (options.length !== 4) return;
    const key = `${stem.toLowerCase()}|${options.join('|').toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const media: MediaRef[] = [];
    const yt = canonicalYoutube(raw);
    if (yt) media.push({ kind: 'youtube', url: yt });
    recovered.push({ stem, options, media, node, position: positions.get(node) ?? Number.MAX_SAFE_INTEGER });
  });
  return recovered;
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

function buildDocumentPositions($: cheerio.CheerioAPI) {
  const positions = new Map<any, number>();
  let order = 0;
  const walk = (node: any) => {
    positions.set(node, order++);
    for (const child of node?.children ?? []) walk(child);
  };
  const root = $.root().get(0) as any;
  walk(root);
  return positions;
}

function sectionKind(text: string): ExamSection | null {
  const normalized = clean(text).toLowerCase();
  if (/(?:^|\s)듣기(?:\s|\d|문항|영역|$)|listening/.test(normalized)) return 'listening';
  if (/(?:^|\s)읽기(?:\s|\d|문항|영역|$)|reading/.test(normalized)) return 'reading';
  return null;
}

function nodeInsideAny(node: any, nodes: Set<any>) {
  let cursor = node;
  while (cursor) {
    if (nodes.has(cursor)) return true;
    cursor = cursor.parent;
  }
  return false;
}

function collectSectionMarkers($: cheerio.CheerioAPI, positions: Map<any, number>, questionNodes: any[]) {
  const questionSet = new Set(questionNodes);
  const markers: Array<{ kind: ExamSection; label: string; position: number }> = [];
  const selectors = 'h1,h2,h3,h4,[role="heading"],.freebirdFormviewerViewItemsSectionheaderTitle,.freebirdFormviewerViewItemsSectionheaderDescription,.freebirdFormviewerViewItemsSectionheaderHeader';
  $(selectors).each((_, node) => {
    if (nodeInsideAny(node, questionSet)) return;
    const label = clean($(node).text());
    const kind = sectionKind(label);
    if (!kind) return;
    markers.push({ kind, label, position: positions.get(node) ?? Number.MAX_SAFE_INTEGER });
  });
  markers.sort((a, b) => a.position - b.position);
  return markers.filter((item, index, arr) => index === 0 || item.kind !== arr[index - 1].kind || item.position - arr[index - 1].position > 4);
}

function collectYoutubeMarkers($: cheerio.CheerioAPI, positions: Map<any, number>) {
  const markers: Array<{ url: string; position: number }> = [];
  $('iframe[src],a[href],[data-params]').each((_, node) => {
    const raw = $(node).attr('src') ?? $(node).attr('href') ?? $(node).attr('data-params') ?? '';
    const url = canonicalYoutube(raw);
    if (url) markers.push({ url, position: positions.get(node) ?? Number.MAX_SAFE_INTEGER });
  });
  markers.sort((a, b) => a.position - b.position);
  return markers.filter((item, index, arr) => !arr.slice(0, index).some(previous => previous.url === item.url && Math.abs(previous.position - item.position) < 8));
}

function assignSections(
  questions: NormalizedQuestion[],
  sectionMarkers: Array<{ kind: ExamSection; label: string; position: number }>,
  youtubeMarkers: Array<{ url: string; position: number }>,
  youtubeUrls: string[]
) {
  let source: AnalysisDiagnostics['sectionSource'] = sectionMarkers.length ? 'heading' : youtubeMarkers.length ? 'youtube-boundary' : 'fallback-20-20';
  const firstYoutubePosition = youtubeMarkers[0]?.position ?? null;

  for (const question of questions) {
    const position = question.documentOrder ?? question.sourceOrder * 1000;
    const precedingSection = [...sectionMarkers].reverse().find(marker => marker.position < position);
    if (precedingSection) {
      question.section = precedingSection.kind;
      question.sectionLabel = precedingSection.label;
      question.sectionConfidence = 0.99;
      continue;
    }
    if (firstYoutubePosition !== null) {
      question.section = position < firstYoutubePosition ? 'reading' : 'listening';
      question.sectionLabel = position < firstYoutubePosition ? 'Before first YouTube source' : 'After YouTube source';
      question.sectionConfidence = 0.78;
    }
  }

  const known = questions.filter(question => question.section).length;
  if (known < questions.length) {
    source = known ? 'mixed' : 'fallback-20-20';
    questions.forEach((question, index) => {
      if (question.section) return;
      question.section = index < 20 ? 'reading' : 'listening';
      question.sectionLabel = 'EPS 20+20 fallback';
      question.sectionConfidence = 0.45;
      question.qaFlags = [...new Set([...question.qaFlags, 'SECTION_FALLBACK_20_20'])];
    });
  }

  // Section is authoritative. A YouTube embedded before a Listening section must not make Reading questions become Listening.
  for (const question of questions) {
    if (question.section === 'listening') {
      question.type = 'listening';
      question.qaFlags = question.qaFlags.filter(flag => flag !== 'TYPE_LOW_CONFIDENCE');
    } else if (question.section === 'reading' && question.type === 'listening') {
      const reclassified = classifyType(question.stem, question.options.join(' '), false, question.media.some(media => media.kind === 'image'));
      question.type = reclassified === 'listening' || reclassified === 'unknown' ? 'reading' : reclassified;
    }
  }

  const listening = questions.filter(question => question.section === 'listening');
  listening.forEach((question, index) => {
    if (question.media.some(media => media.kind === 'youtube')) return;
    const position = question.documentOrder ?? Number.MAX_SAFE_INTEGER;
    const precedingVideo = [...youtubeMarkers].reverse().find(marker => marker.position < position);
    let url = precedingVideo?.url ?? null;
    if (!url && youtubeUrls.length === 1) url = youtubeUrls[0];
    if (!url && youtubeUrls.length > 1) url = youtubeUrls[Math.min(youtubeUrls.length - 1, Math.floor(index * youtubeUrls.length / Math.max(1, listening.length)))];
    if (url) question.media = uniqueMedia([...question.media, { kind: 'youtube', url, label: 'Listening source detected from Form order' }]);
  });

  return source;
}

function detectedSectionGroups(questions: NormalizedQuestion[]): DetectedSection[] {
  const out: DetectedSection[] = [];
  for (const question of questions) {
    if (!question.section) continue;
    const last = out[out.length - 1];
    if (!last || last.kind !== question.section) {
      out.push({
        kind: question.section,
        label: question.sectionLabel || question.section,
        documentOrder: question.documentOrder ?? question.sourceOrder,
        questionStart: question.sourceOrder,
        questionEnd: question.sourceOrder,
        questionCount: 1,
        confidence: question.sectionConfidence ?? 0.5
      });
    } else {
      last.questionEnd = question.sourceOrder;
      last.questionCount += 1;
      last.confidence = Math.min(last.confidence, question.sectionConfidence ?? last.confidence);
    }
  }
  return out;
}

export async function importGoogleFormViewScore(sourceUrl: string): Promise<ImportAnalysis> {
  const parsed = new URL(sourceUrl);
  if (parsed.hostname !== GOOGLE_FORMS_HOST || !parsed.pathname.includes('/forms/')) throw new Error('Only Google Forms URLs are supported by this importer.');

  const response = await fetch(sourceUrl, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MT-EPS-Question-Factory/0.5',
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });
  if (!response.ok) throw new Error(`Google Form fetch failed: HTTP ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const positions = buildDocumentPositions($);
  const sourceTitle = clean($('meta[property="og:title"]').attr('content')) || clean($('title').text()) || 'Google Form';
  const found = findQuestionBlocks($);
  const questions: NormalizedQuestion[] = [];
  const seen = new Set<string>();

  function appendQuestion(stem: string, options: string[], media: MediaRef[], answer: { index: number | null; evidence: string | null }, documentOrder: number, extraFlags: string[] = []) {
    const fingerprint = `${stem.toLowerCase()}|${options.join('|').toLowerCase()}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    const combined = `${stem} ${options.join(' ')}`;
    const type = classifyType(stem, options.join(' '), media.some(m => m.kind === 'youtube'), media.some(m => m.kind === 'image'));
    const chapter = classifyChapter(combined);
    const qaFlags = [...extraFlags];
    if (options.length !== 4) qaFlags.push(`OPTIONS_${options.length}`);
    if (answer.index === null) qaFlags.push('ANSWER_NOT_DETECTED');
    if (chapter.chapter === null || chapter.confidence < 0.6) qaFlags.push('CHAPTER_LOW_CONFIDENCE');
    if (type === 'unknown') qaFlags.push('TYPE_LOW_CONFIDENCE');
    const sourceOrder = questions.length + 1;
    questions.push({
      id: stableId(sourceUrl, sourceOrder, stem), sourceOrder, documentOrder, stem, options,
      correctAnswerIndex: answer.index, answerEvidence: answer.evidence, type, section: null, sectionLabel: null, sectionConfidence: 0,
      chapter, media, qaFlags: [...new Set(qaFlags)], provenance: { sourceUrl, sourceTitle }
    });
    return true;
  }

  found.nodes.forEach(block => {
    const stem = questionStem($, block);
    if (!stem || stem.length < 2) return;
    const options = optionCandidates($, block).filter(option => option !== stem).slice(0, 4);
    appendQuestion(stem, options, collectMedia($, block), detectCorrectAnswer($, block, options), positions.get(block) ?? Number.MAX_SAFE_INTEGER);
  });

  let recoveredCount = 0;
  if (questions.length < 40) {
    for (const recovered of dataParamRecovery($, positions)) {
      if (questions.length >= 40) break;
      if (appendQuestion(recovered.stem, recovered.options, recovered.media, { index: null, evidence: null }, recovered.position, ['RECOVERED_FROM_DATA_PARAMS'])) recoveredCount += 1;
    }
  }

  questions.sort((a, b) => (a.documentOrder ?? 0) - (b.documentOrder ?? 0));
  questions.forEach((question, index) => {
    question.sourceOrder = index + 1;
    question.id = stableId(sourceUrl, question.sourceOrder, question.stem);
  });

  const youtubeUrls = globalYoutubeUrls($, html);
  const youtubeMarkers = collectYoutubeMarkers($, positions);
  const sectionMarkers = collectSectionMarkers($, positions, found.nodes);
  const sectionSource = assignSections(questions, sectionMarkers, youtubeMarkers, youtubeUrls);
  const sectionGroups = detectedSectionGroups(questions);
  const sectionOrder = sectionGroups.map(group => group.kind).filter((kind, index, arr) => index === 0 || kind !== arr[index - 1]);
  const sectionPlan = questions.slice(0, 40).map(question => question.section ?? 'reading');
  while (sectionPlan.length < 40) sectionPlan.push(sectionPlan.length < 20 ? 'reading' : 'listening');

  const globalImages = new Set<string>();
  $('img[src]').each((_, node) => {
    const src = $(node).attr('src');
    if (src && !/googleusercontent\.com\/favicon|gstatic\.com\/forms/i.test(src)) globalImages.add(src);
  });
  const imageCount = new Set(questions.flatMap(q => q.media.filter(m => m.kind === 'image').map(m => m.url))).size;
  const linkedYoutube = new Set(questions.flatMap(q => q.media.filter(m => m.kind === 'youtube').map(m => m.url)));
  const optionHistogram: Record<string, number> = {};
  for (const question of questions) optionHistogram[String(question.options.length)] = (optionHistogram[String(question.options.length)] ?? 0) + 1;
  const warnings: string[] = [];
  if (questions.length !== 40) warnings.push(`Detected ${questions.length} question blocks, not 40. The Controller Agent will still build 40 fresh questions, but source coverage is incomplete.`);
  if (questions.filter(q => q.options.length === 4).length !== questions.length) warnings.push('Some detected blocks do not have exactly four choices.');
  if (questions.filter(q => q.correctAnswerIndex !== null).length < questions.length) warnings.push('Some correct answers could not be proven from the score page and are flagged instead of guessed.');
  if (recoveredCount) warnings.push(`Recovered ${recoveredCount} additional question(s) from Google Forms structured data-params.`);
  if (sectionSource === 'fallback-20-20' || sectionSource === 'mixed') warnings.push('Some section assignments required fallback. The detailed agent log shows which questions need attention.');
  if (!sectionOrder.includes('reading') || !sectionOrder.includes('listening')) warnings.push('Both Reading and Listening sections were not confidently detected from the Form structure.');

  const candidateBlockCounts = { ...found.counts, 'data-params-recovery': recoveredCount };
  const diagnostics: AnalysisDiagnostics = {
    parserStrategy: `${found.selector}${recoveredCount ? ' + data-params recovery' : ''} + ordered section detector`,
    candidateBlockCounts,
    selectedBlockCount: questions.length,
    rawHtmlBytes: Buffer.byteLength(html, 'utf8'),
    optionHistogram,
    globalYoutube: youtubeUrls.length,
    globalImages: globalImages.size,
    answerEvidenceCount: questions.filter(q => !!q.answerEvidence).length,
    detectedSections: sectionGroups,
    sectionOrder,
    sectionSource,
    warnings
  };

  return {
    sourceUrl, sourceTitle, importedAt: new Date().toISOString(), sectionPlan,
    mediaPool: [...youtubeUrls.map(url => ({ kind: 'youtube' as const, url })), ...[...globalImages].map(url => ({ kind: 'image' as const, url }))],
    diagnostics,
    counts: {
      questions: questions.length,
      listening: questions.filter(q => q.section === 'listening').length,
      reading: questions.filter(q => q.section === 'reading').length,
      images: imageCount,
      youtube: Math.max(linkedYoutube.size, youtubeUrls.length),
      answersDetected: questions.filter(q => q.correctAnswerIndex !== null).length
    },
    questions
  };
}
