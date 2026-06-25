/** Aktualisiert das letzte Thinking-Segment der aktuellen Runde (seit letztem Tool). */
function upsertStreamThinking(segments, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !Array.isArray(segments)) return;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i];
    if (seg.type === 'tool') {
      segments.push({ type: 'thinking', text: trimmed });
      return;
    }
    if (seg.type === 'thinking' && !seg.toolAfter) {
      seg.text = trimmed;
      return;
    }
  }
  segments.push({ type: 'thinking', text: trimmed });
}

/** Aktualisiert das letzte Answer-Segment der aktuellen Runde (seit letztem Tool). */
function upsertStreamAnswer(segments, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !Array.isArray(segments)) return;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i];
    if (seg.type === 'tool') {
      segments.push({ type: 'answer', text: trimmed });
      return;
    }
    if (seg.type === 'answer') {
      seg.text = trimmed;
      return;
    }
  }
  segments.push({ type: 'answer', text: trimmed });
}

/** Fasst versehentlich duplizierte aufeinanderfolgende Segmente zusammen. */
function consolidateSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return segments;
  const out = [];
  for (const seg of segments) {
    if (!seg?.type) continue;
    const last = out[out.length - 1];
    if (seg.type === 'thinking' && last?.type === 'thinking' && !last.toolAfter && !seg.toolAfter) {
      last.text = seg.text;
      continue;
    }
    if (seg.type === 'answer' && last?.type === 'answer') {
      last.text = seg.text;
      continue;
    }
    out.push(seg.type === 'tool' ? { ...seg, event: seg.event ? { ...seg.event } : seg.event } : { ...seg });
  }
  return out;
}

module.exports = {
  upsertStreamThinking,
  upsertStreamAnswer,
  consolidateSegments,
};
