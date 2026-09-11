import { flattenDocsNav, DOCS_CONTENT } from '$lib/docs/nav.js';
import { extractToc, renderDocsMarkdown } from '$lib/docs/render.js';

export const prerender = true;

export function load() {
	const slug = 'getting-started';
	const markdown = DOCS_CONTENT[slug] || '';
	const flat = flattenDocsNav();
	const index = flat.findIndex((item) => item.slug === slug);
	return {
		slug,
		current: flat[index] || null,
		html: renderDocsMarkdown(markdown),
		toc: extractToc(markdown),
		prev: null,
		next: index >= 0 ? flat[index + 1] : null,
	};
}
