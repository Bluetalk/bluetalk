import { error } from '@sveltejs/kit';
import { flattenDocsNav, DOCS_CONTENT } from '$lib/docs/nav.js';
import { extractToc, renderDocsMarkdown } from '$lib/docs/render.js';

export const prerender = true;

export function entries() {
	return flattenDocsNav().map((item) => ({ slug: item.slug }));
}

export function load({ params }) {
	const slug = String(params.slug || '').replace(/\/$/, '');
	const markdown = DOCS_CONTENT[slug];
	if (!markdown) {
		error(404, 'Seite nicht gefunden');
	}
	const flat = flattenDocsNav();
	const index = flat.findIndex((item) => item.slug === slug);
	return {
		slug,
		current: index >= 0 ? flat[index] : null,
		html: renderDocsMarkdown(markdown),
		toc: extractToc(markdown),
		prev: index > 0 ? flat[index - 1] : null,
		next: index >= 0 && index < flat.length - 1 ? flat[index + 1] : null,
	};
}
