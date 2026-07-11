/**
 * BlueTalk Poker — Hand-Bewertung (5-/7-Karten-Scoring).
 * Reine Logik; Karten sind 0..51 (rank = c % 13, suit = (c / 13) | 0).
 */

/** 5-Karten-Score: höher = besser; vergleichbar als Tuple */
export function scoreFive(cards5) {
  const r = cards5.map((c) => c % 13).sort((a, b) => b - a);
  const suits = cards5.map((c) => (c / 13) | 0);
  const flush = suits.every((x) => x === suits[0]);
  const cnt = {};
  for (const x of r) cnt[x] = (cnt[x] || 0) + 1;
  const byFreq = Object.keys(cnt)
    .map((k) => ({ k: Number(k), n: cnt[k] }))
    .sort((a, b) => b.n - a.n || b.k - a.k);
  const uniq = [...new Set(r)].sort((a, b) => b - a);
  let straightHigh = -1;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    if (uniq[0] === 12 && uniq[1] === 3 && uniq[2] === 2 && uniq[3] === 1 && uniq[4] === 0) straightHigh = 3;
  }
  const sf = flush && straightHigh >= 0;
  if (sf) {
    return [8, straightHigh];
  }
  if (byFreq[0].n === 4) {
    const quad = byFreq[0].k;
    const k = r.find((x) => x !== quad);
    return [7, quad, k];
  }
  if (byFreq[0].n === 3 && byFreq[1].n === 2) return [6, byFreq[0].k, byFreq[1].k];
  if (flush) return [5].concat(r);
  if (straightHigh >= 0) {
    return [4, straightHigh];
  }
  if (byFreq[0].n === 3) {
    const t = byFreq[0].k;
    const kick = r.filter((x) => x !== t).sort((a, b) => b - a);
    return [3, t].concat(kick.slice(0, 2));
  }
  if (byFreq[0].n === 2 && byFreq[1].n === 2) {
    const p1 = Math.max(byFreq[0].k, byFreq[1].k);
    const p2 = Math.min(byFreq[0].k, byFreq[1].k);
    const k = r.find((x) => x !== p1 && x !== p2);
    return [2, p1, p2, k];
  }
  if (byFreq[0].n === 2) {
    const p = byFreq[0].k;
    const kick = r.filter((x) => x !== p).sort((a, b) => b - a);
    return [1, p].concat(kick.slice(0, 3));
  }
  return [0].concat(r);
}

export function cmpScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export function best7(cards7) {
  let best = null;
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) {
            const five = [cards7[a], cards7[b], cards7[c], cards7[d], cards7[e]];
            const s = scoreFive(five);
            if (!best || cmpScore(s, best) > 0) best = s;
          }
  return best;
}

export function handLabel(score) {
  const cat = score[0];
  const map = {
    8: 'Straight Flush',
    7: 'Vierling',
    6: 'Full House',
    5: 'Flush',
    4: 'Straight',
    3: 'Drilling',
    2: 'Zwei Paare',
    1: 'Paar',
    0: 'High Card',
  };
  return map[cat] || 'Hand';
}
