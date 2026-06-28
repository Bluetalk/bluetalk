const path = require('path');
const {
  groupConsecutiveToolSegments,
  consolidateSegments,
} = require(path.join(__dirname, '..', 'shared', 'agent-segments.js'));

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

/** Entfernt das letzte Antwort-Segment der laufenden Runde (z. B. vor Tool-Ausführung). */
function clearLastStreamAnswer(segments) {
  if (!Array.isArray(segments)) return;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i];
    if (seg.type === 'answer') {
      segments.splice(i, 1);
      return;
    }
    if (seg.type === 'tool') return;
  }
}

module.exports = {
  upsertStreamThinking,
  upsertStreamAnswer,
  clearLastStreamAnswer,
  consolidateSegments,
  groupConsecutiveToolSegments,
};
