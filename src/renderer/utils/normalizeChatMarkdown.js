/**
 * Normalisiert Chat-Markdown für react-markdown:
 * Einzelne Zeilenumbrüche werden zu Markdown-Zeilenumbrüchen (zwei Leerzeichen + \n),
 * damit harte Umbrüche aus dem Modell sichtbar bleiben.
 * LaTeX-Formeln ($...$ und $$...$$) bleiben unverändert.
 */
export function normalizeChatMarkdown(text) {
  const raw = String(text || '');
  if (!raw) return '';

  const preserved = [];
  const placeholder = (value) => {
    const index = preserved.length;
    preserved.push(value);
    return `\x00MATHBLOCK${index}\x00`;
  };

  let protectedText = raw.replace(/\$\$[\s\S]*?\$\$/g, placeholder);
  protectedText = protectedText.replace(/(?<![\\$])\$(?!\$)(?:\\.|[^$\n])+?(?<![\\$])\$(?!\$)/g, placeholder);

  const normalized = protectedText.replace(/(?<!\n)\n(?!\n)/g, '  \n');

  return normalized.replace(/\x00MATHBLOCK(\d+)\x00/g, (_, index) => preserved[Number(index)] || '');
}
