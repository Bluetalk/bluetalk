/** Fasst aufeinanderfolgende Tool-Segmente zu einem Block zusammen. */
function groupConsecutiveToolSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return [];

  const out = [];
  let toolBatch = [];

  const flushTools = () => {
    if (!toolBatch.length) return;
    out.push({ type: 'tool', events: toolBatch.map((event) => ({ ...event })) });
    toolBatch = [];
  };

  for (const seg of segments) {
    if (!seg?.type) continue;
    if (seg.type === 'tool') {
      if (seg.event) toolBatch.push(seg.event);
      else if (Array.isArray(seg.events)) toolBatch.push(...seg.events);
      continue;
    }
    flushTools();
    if (seg.type === 'subagent') {
      out.push({ ...seg });
      continue;
    }
    const last = out[out.length - 1];
    if (seg.type === 'thinking' && last?.type === 'thinking' && !last.toolAfter && !seg.toolAfter) {
      last.text = seg.text;
      continue;
    }
    if (seg.type === 'answer' && last?.type === 'answer') {
      last.text = seg.text;
      continue;
    }
    out.push({ ...seg });
  }
  flushTools();
  return out;
}

/** Normalisiert Segment-Listen für Anzeige und Persistenz. */
function consolidateSegments(segments) {
  return groupConsecutiveToolSegments(segments);
}

module.exports = {
  groupConsecutiveToolSegments,
  consolidateSegments,
};
