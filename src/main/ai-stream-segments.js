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

module.exports = {
  upsertStreamThinking,
  upsertStreamAnswer,
  consolidateSegments,
  groupConsecutiveToolSegments,
};
