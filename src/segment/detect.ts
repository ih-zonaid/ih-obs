import type { Segment, SegmentRule, Span } from "../store/schema";
import {
  lineBands,
  mergeCloseBands,
  otsuThreshold,
  type Band,
  type Bitmap
} from "./layout";

export interface PageBitmap {
  page: number;
  bitmap: Bitmap;
}

export interface TextLine {
  page: number;
  text: string;
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

interface LineInfo {
  band: Band;
  prevGap: number;
  leadWidth: number;
  startsAtLeft: boolean;
}

function uid(): string {
  return `s_${Math.random().toString(36).slice(2, 9)}`;
}

function analyzeColumns(
  bmp: Bitmap,
  threshold: number,
  band: Band
): { leadWidth: number; x0: number } {
  const density = new Uint32Array(bmp.width);
  for (let y = band.y0; y < band.y1; y++) {
    const row = y * bmp.width;
    for (let x = 0; x < bmp.width; x++) {
      if (bmp.gray[row + x] < threshold) density[x]++;
    }
  }
  let firstInk = -1;
  for (let x = 0; x < bmp.width; x++) {
    if (density[x] >= 1) {
      firstInk = x;
      break;
    }
  }
  if (firstInk === -1) return { leadWidth: 0, x0: 0 };
  const fontSize = Math.max(4, band.y1 - band.y0);
  const gapNeeded = Math.max(3, Math.round(fontSize * 0.6));
  let gap = 0;
  let x = firstInk;
  for (; x < bmp.width; x++) {
    if (density[x] === 0) {
      gap++;
      if (gap >= gapNeeded) break;
    } else {
      gap = 0;
    }
  }
  return { leadWidth: x - firstInk, x0: firstInk };
}

function contentLeft(bmp: Bitmap, threshold: number, bands: Band[]): number {
  const lefts: number[] = [];
  for (const b of bands) {
    const { x0 } = analyzeColumns(bmp, threshold, b);
    if (x0 > 0) lefts.push(x0);
  }
  if (!lefts.length) return 0;
  lefts.sort((a, b) => a - b);
  return lefts[Math.floor(lefts.length * 0.1)];
}

function toSpan(page: number, bmp: Bitmap, band: Band): Span {
  return {
    page,
    x: band.x0 / bmp.width,
    y: band.y0 / bmp.height,
    w: Math.max(0.01, (band.x1 - band.x0) / bmp.width),
    h: Math.max(0.005, (band.y1 - band.y0) / bmp.height)
  };
}

export function detectLayout(page: PageBitmap, rule: SegmentRule): Span[] {
  const bmp = page.bitmap;
  const threshold = otsuThreshold(bmp);
  const rawLines = lineBands(bmp, threshold);
  const lines = mergeCloseBands(rawLines, Math.round(bmp.height * 0.002));
  if (!lines.length) return [];

  const left = contentLeft(bmp, threshold, lines);
  const maxGap = bmp.height * rule.mergeGapFraction;
  const maxLead = bmp.width * rule.marginFraction;
  const minHeight = bmp.height * rule.minHeightFraction;

  const infos: LineInfo[] = [];
  let prevY1: number | null = null;
  for (const band of lines) {
    const h = band.y1 - band.y0;
    if (h < minHeight * 0.4) {
      prevY1 = band.y1;
      continue;
    }
    const { leadWidth, x0 } = analyzeColumns(bmp, threshold, band);
    infos.push({
      band,
      prevGap: prevY1 === null ? bmp.height : band.y0 - prevY1,
      leadWidth,
      startsAtLeft: x0 <= left + bmp.width * 0.02
    });
    prevY1 = band.y1;
  }
  if (!infos.length) return [];

  const isAnchor = (info: LineInfo, i: number): boolean => {
    if (i === 0) return true;
    const narrowLead = info.startsAtLeft && info.leadWidth > 0 && info.leadWidth <= maxLead;
    return narrowLead || info.prevGap >= maxGap;
  };

  const spans: Span[] = [];
  let startBand: Band | null = null;
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (isAnchor(info, i)) {
      if (startBand) spans.push(toSpan(page.page, bmp, startBand));
      startBand = { ...info.band };
    } else if (startBand) {
      startBand.y1 = info.band.y1;
      startBand.x0 = Math.min(startBand.x0, info.band.x0);
      startBand.x1 = Math.max(startBand.x1, info.band.x1);
    }
  }
  if (startBand) spans.push(toSpan(page.page, bmp, startBand));
  return spans.filter((s) => s.h * bmp.height >= minHeight);
}

export function detectText(lines: TextLine[], rule: SegmentRule): Span[] {
  const re = new RegExp(rule.anchorPattern);
  const byPage = new Map<number, TextLine[]>();
  for (const l of lines) {
    const arr = byPage.get(l.page) ?? [];
    arr.push(l);
    byPage.set(l.page, arr);
  }

  const out: Span[] = [];
  for (const [page, ls] of byPage) {
    ls.sort((a, b) => a.y0 - b.y0);
    let cur: { y0: number; y1: number; x0: number; x1: number } | null = null;

    const flush = (): void => {
      if (!cur) return;
      out.push({
        page,
        x: cur.x0,
        y: cur.y0,
        w: Math.max(0.01, cur.x1 - cur.x0),
        h: Math.max(0.005, cur.y1 - cur.y0)
      });
      cur = null;
    };

    for (const l of ls) {
      if (re.test(l.text)) {
        flush();
        cur = { y0: l.y0, y1: l.y1, x0: l.x0, x1: l.x1 };
      } else if (cur) {
        cur.y1 = Math.max(cur.y1, l.y1);
        cur.x1 = Math.max(cur.x1, l.x1);
        cur.x0 = Math.min(cur.x0, l.x0);
      }
    }
    flush();
  }
  return out;
}

export interface SegmentedPage {
  page: number;
  spans: Span[];
}

export function buildSegments(pages: SegmentedPage[], prefix: string): Segment[] {
  const segments: Segment[] = [];
  let order = 0;
  for (const pg of pages) {
    for (const span of pg.spans) {
      segments.push({
        id: uid(),
        type: "question",
        title: `${prefix}${order + 1}`,
        order,
        spans: [span]
      });
      order++;
    }
  }
  return segments;
}
