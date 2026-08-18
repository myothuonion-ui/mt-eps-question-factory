import { CHAPTERS } from '../src/shared/chapters.js';
import type { ChapterGuess, QuestionType } from '../src/shared/types.js';

const chapterHints: Record<number, string[]> = {
  1:['이름','국적','소개','고향'],2:['생활용품','비누','수건','휴지'],3:['위치','옆','앞','뒤','안','밖'],4:['동작','물건','사물'],5:['날짜','요일','월요일','화요일','수요일','목요일','금요일'],6:['일과','출근','퇴근','아침','점심'],7:['날씨','계절','비','눈','덥','춥'],8:['가족','친구','부모','형','누나','언니','오빠'],9:['주문','식당','메뉴','주세요'],10:['구입','가격','얼마','싸다','비싸다'],
  11:['청소','빨래','설거지','집안일'],12:['버스','지하철','택시','교통'],13:['주말','등산','쇼핑'],14:['길','직진','왼쪽','오른쪽'],15:['옷','입다','신다','쓰다'],16:['집','월세','보증금','부동산'],17:['휴가','여행'],18:['취미','운동','영화'],19:['요리','끓이다','볶다','썰다'],20:['인터넷','스마트폰','앱','문자'],
  21:['병원','의사','아프다','진료'],22:['약국','약','복용'],23:['우체국','소포','우편'],24:['은행','통장','송금','환전'],25:['지원 기관','센터','상담'],26:['주거 문화','음식 문화'],27:['기념일'],28:['명절','설날','추석'],29:['예절','인사','존댓말'],30:['대중문화','드라마','케이팝'],
  31:['복장','근무 태도','작업복'],32:['회사 시설','휴게실','구내식당'],33:['동료','직장 동료','관계'],34:['성희롱','성추행'],35:['작업장','정리','정돈'],36:['출하','포장','배송'],37:['기계 가공','선반','밀링'],38:['기계 조립','조립'],39:['금속','용접','절단'],40:['플라스틱','고무','성형'],
  41:['섬유','봉제','원단'],42:['가구','목재'],43:['건축','시공','벽돌'],44:['토목','도로','콘크리트'],45:['농작물','재배','농약'],46:['사육','가축','사료'],47:['어업','양식','그물'],48:['선체','조선'],49:['광물','채굴'],50:['산림','나무','벌목'],
  51:['숙박','호텔','객실'],52:['음식 조리','주방','조리'],53:['안전 표지','금지 표지','경고 표지'],54:['안전 수칙','안전','보건 수칙'],55:['안전 장비','보호구','안전모','안전 장갑','보안경'],56:['산업 재해','응급 처치','응급','사고'],57:['고용허가제','EPS'],58:['근로기준법','임금','근로시간','휴게'],59:['출입국','체류','비자','외국인등록'],60:['보험','산재보험','고용보험']
};

export function classifyType(stem: string, optionText: string, hasYoutube: boolean, hasImage: boolean): QuestionType {
  const text = `${stem} ${optionText}`;
  if (hasYoutube || /듣고|들은|대화를 듣/.test(text)) return 'listening';
  if (/\[\s*[_\-–—]+\s*\]|빈칸|빈 곳|알맞은 것을 고르/.test(text) && /[_\-–—]{2,}/.test(text)) return 'blank';
  if (/문법|어미|조사|표현/.test(text)) return 'grammar';
  if (/단어|어휘|뜻|의미/.test(text)) return 'vocabulary';
  if (hasImage && stem.length < 120) return 'image';
  if (stem.length > 120 || /다음 글|내용과 같은|글을 읽/.test(text)) return 'reading';
  return 'unknown';
}

export function classifyChapter(text: string): ChapterGuess {
  const normalized = text.replace(/\s+/g, ' ').toLowerCase();
  let best: { chapter: number; score: number; hits: string[] } | null = null;
  for (let chapter = 1; chapter <= 60; chapter += 1) {
    const hints = [CHAPTERS[chapter - 1], ...(chapterHints[chapter] ?? [])];
    const hits = hints.filter(h => normalized.includes(h.toLowerCase()));
    const score = hits.reduce((sum, hit) => sum + Math.max(1, Math.min(4, hit.length / 2)), 0);
    if (!best || score > best.score) best = { chapter, score, hits };
  }
  if (!best || best.score <= 0) return { chapter: null, title: null, confidence: 0.15, reason: 'No strong Chapter 1-60 keyword match yet; AI classifier will refine this later.' };
  const confidence = Math.min(0.95, 0.45 + best.score * 0.08);
  return {
    chapter: best.chapter,
    title: CHAPTERS[best.chapter - 1],
    confidence,
    reason: `Matched: ${best.hits.slice(0, 4).join(', ')}`
  };
}
