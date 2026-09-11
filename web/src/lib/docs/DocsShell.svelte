<script>
	import Logo from '$lib/Logo.svelte';
	import { DOCS_NAV, docsPath } from '$lib/docs/nav.js';
	import { GITHUB_URL } from '$lib/release';

	let { slug = '', current = null, toc = [], html = '', prev = null, next = null } = $props();
</script>

<div class="docs">
	<aside class="docs-side">
		<a class="docs-brand" href="/" aria-label="BlueTalk">
			<Logo size={28} />
			<span>BlueTalk</span>
		</a>
		<p class="docs-kicker">Plugin-API</p>
		<nav class="docs-nav" aria-label="Dokumentation">
			{#each DOCS_NAV as section}
				<div class="docs-nav-section">
					<div class="docs-nav-label">{section.title}</div>
					{#each section.items as item}
						<a
							href={docsPath(item.slug)}
							class="docs-nav-link"
							class:is-active={item.slug === slug}
						>
							{item.label}
						</a>
					{/each}
				</div>
			{/each}
		</nav>
		<div class="docs-side-foot">
			<a href="/download">Download</a>
			<a href={GITHUB_URL} rel="noreferrer" target="_blank">GitHub</a>
		</div>
	</aside>

	<div class="docs-main">
		<div class="docs-article">
			{#if current}
				<p class="docs-crumb">{current.section} / {current.label}</p>
			{/if}
			<article class="docs-prose">
				{@html html}
			</article>
			{#if prev || next}
				<div class="docs-pager">
					{#if prev}
						<a href={docsPath(prev.slug)}>
							<span>Zurück</span>
							{prev.label}
						</a>
					{:else}
						<span></span>
					{/if}
					{#if next}
						<a href={docsPath(next.slug)} class="docs-pager-next">
							<span>Weiter</span>
							{next.label}
						</a>
					{/if}
				</div>
			{/if}
		</div>
		{#if toc.length > 0}
			<aside class="docs-toc" aria-label="Auf dieser Seite">
				<div class="docs-toc-title">Inhalt</div>
				{#each toc as item}
					<a href="#{item.id}" class="docs-toc-link" class:is-sub={item.level > 2}>
						{item.text}
					</a>
				{/each}
			</aside>
		{/if}
	</div>
</div>
