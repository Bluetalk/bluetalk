/**
 * Live Dokumente — „Zuletzt bearbeitet"-Speicher.
 *
 * Im persistenten Plugin-Speicher gehalten, damit die Dokumente-Seite die
 * Einträge auch nach dem Schließen einer Sitzung anzeigen kann.
 */

export function createRecentsStore({
  api,
  key = 'recentDocs',
  max = 12,
  htmlMax = 200000,
}) {
  function load() {
    const list = api.storage?.get(key, []);
    return Array.isArray(list) ? list : [];
  }

  function remove(id) {
    if (id) api.storage?.set(key, load().filter((e) => e && e.id !== id));
  }

  /** Legt/aktualisiert einen Eintrag (jüngster zuerst, auf `max` begrenzt). */
  function save(entry) {
    if (!entry || !entry.id) return;
    const html = String(entry.html ?? '').slice(0, htmlMax);
    const rest = load().filter((e) => e && e.id !== entry.id);
    rest.unshift({
      id: entry.id,
      fileName: entry.fileName,
      html,
      updatedAt: Date.now(),
    });
    api.storage?.set(key, rest.slice(0, max));
  }

  return { load, remove, save, htmlMax };
}
