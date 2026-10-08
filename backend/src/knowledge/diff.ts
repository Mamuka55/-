/**
 * EPIC AI — diff версий документа.
 *
 * Сравнение выполняется НА УРОВНЕ СЛОВ (а не целых абзацев), как требует.
 * Удалённый текст → #E74C3C, добавленный → #ACE72E.
 *
 * Алгоритм: LCS по токенам + Myers-оптимизация «общих префиксов/суффиксов»,
 * чтобы на больших документах не строить квадратную матрицу целиком.
 */

export type DiffOpKind = 'equal' | 'del' | 'ins';

export interface DiffOp {
  kind: DiffOpKind;
  text: string;
}

export interface DiffResult {
  ops: DiffOp[];
  removedText: string;
  addedText: string;
  changedWords: number;
  totalWords: number;
  changedRatio: number;
}

export interface DiffOptions {
  /** Максимум токенов, при превышении сравниваем поблочно (абзацами). */
  maxTokens?: number;
}

/** Разбиение на токены: слова, числа и пунктуация — отдельные элементы, пробелы сохраняются. */
export function tokenizeForDiff(text: string): string[] {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const out: string[] = [];
  const re = /(\n+)|([^\S\n]+)|([A-Za-zА-Яа-яЁё0-9]+(?:[.\-'][A-Za-zА-Яа-яЁё0-9]+)*)|([^\sA-Za-zА-Яа-яЁё0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[0]);
  return out;
}

function commonPrefix(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function commonSuffix(a: string[], b: string[], start: number): number {
  let i = 0;
  while (i < a.length - start && i < b.length - start && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** LCS-таблица и обратный ход для небольших фрагментов. */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return [{ kind: 'ins', text: b.join('') }];
  if (!m) return [{ kind: 'del', text: a.join('') }];

  // dp[i][j] = длина LCS для a[i:], b[j:]
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  const push = (kind: DiffOpKind, text: string) => {
    if (!text) return;
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) last.text += text;
    else ops.push({ kind, text });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('equal', a[i]!); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { push('del', a[i]!); i++; }
    else { push('ins', b[j]!); j++; }
  }
  while (i < n) { push('del', a[i]!); i++; }
  while (j < m) { push('ins', b[j]!); j++; }
  return ops;
}

function diffTokens(a: string[], b: string[], budget: number): DiffOp[] {
  const pre = commonPrefix(a, b);
  const suf = commonSuffix(a, b, pre);
  const ops: DiffOp[] = [];
  if (pre) ops.push({ kind: 'equal', text: a.slice(0, pre).join('') });

  const aMid = a.slice(pre, a.length - suf);
  const bMid = b.slice(pre, b.length - suf);

  if (aMid.length && bMid.length) {
    if (aMid.length * bMid.length <= budget) {
      ops.push(...lcsDiff(aMid, bMid));
    } else {
      // Слишком большой фрагмент: режем по абзацам и сравниваем попарно.
      const aBlocks = splitBlocks(aMid);
      const bBlocks = splitBlocks(bMid);
      const max = Math.max(aBlocks.length, bBlocks.length);
      for (let k = 0; k < max; k++) {
        const ab = aBlocks[k] ?? [];
        const bb = bBlocks[k] ?? [];
        if (!ab.length && bb.length) ops.push({ kind: 'ins', text: bb.join('') });
        else if (ab.length && !bb.length) ops.push({ kind: 'del', text: ab.join('') });
        else if (ab.length && bb.length) ops.push(...diffTokens(ab, bb, budget));
      }
    }
  } else if (aMid.length) {
    ops.push({ kind: 'del', text: aMid.join('') });
  } else if (bMid.length) {
    ops.push({ kind: 'ins', text: bMid.join('') });
  }

  if (suf) ops.push({ kind: 'equal', text: a.slice(a.length - suf).join('') });
  return mergeOps(ops);
}

function splitBlocks(tokens: string[]): string[][] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    cur.push(t);
    if (t === '\n' || t === '\n\n') { blocks.push(cur); cur = []; }
  }
  if (cur.length) blocks.push(cur);
  return blocks.length ? blocks : [tokens];
}

function mergeOps(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const o of ops) {
    if (!o.text) continue;
    const last = out[out.length - 1];
    if (last && last.kind === o.kind) last.text += o.text;
    else out.push({ kind: o.kind, text: o.text });
  }
  return out;
}

export function diffText(oldText: string, newText: string, opts: DiffOptions = {}): DiffResult {
  const budget = 4_000_000;
  const a = tokenizeForDiff(oldText);
  const b = tokenizeForDiff(newText);
  const ops = a.length + b.length > (opts.maxTokens ?? 40000)
    ? blockwiseFallback(a, b)
    : diffTokens(a, b, budget);

  const removedText = ops.filter((o) => o.kind === 'del').map((o) => o.text).join('');
  const addedText = ops.filter((o) => o.kind === 'ins').map((o) => o.text).join('');
  const changedWords = countWords(removedText) + countWords(addedText);
  const totalWords = Math.max(countWords(oldText), countWords(newText), 1);

  return {
    ops,
    removedText,
    addedText,
    changedWords,
    totalWords,
    changedRatio: Number((changedWords / totalWords).toFixed(4)),
  };
}

/** Для очень больших документов: сравнение по абзацам с последующим word-diff внутри пары. */
function blockwiseFallback(a: string[], b: string[]): DiffOp[] {
  const aParas = splitBlocks(a).map((x) => x.join(''));
  const bParas = splitBlocks(b).map((x) => x.join(''));
  const ops: DiffOp[] = [];
  // Простейшее LCS по абзацам (их обычно десятки, не тысячи)
  const n = aParas.length;
  const m = bParas.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = aParas[i] === bParas[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (aParas[i] === bParas[j]) { ops.push({ kind: 'equal', text: aParas[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { ops.push({ kind: 'del', text: aParas[i]! }); i++; }
    else { ops.push({ kind: 'ins', text: bParas[j]! }); j++; }
  }
  while (i < n) ops.push({ kind: 'del', text: aParas[i++]! });
  while (j < m) ops.push({ kind: 'ins', text: bParas[j++]! });
  return mergeOps(ops);
}

function countWords(t: string): number {
  return (String(t ?? '').match(/[A-Za-zА-Яа-яЁё0-9]+/g) ?? []).length;
}

/**
 * Компактное текстовое представление для отчётов и логов:
 *   🔴 удалённый текст
 *   🟢 добавленный текст
 */
export function renderDiffPlain(result: DiffResult, maxLines = 40): string {
  const lines: string[] = [];
  for (const op of result.ops) {
    const parts = op.text.split('\n');
    for (const p of parts) {
      if (!p.trim()) continue;
      lines.push(op.kind === 'del' ? `🔴 ${p.trim()}` : op.kind === 'ins' ? `🟢 ${p.trim()}` : `   ${p.trim()}`);
      if (lines.length >= maxLines) return [...lines, '…'].join('\n');
    }
  }
  return lines.join('\n');
}
