<script>
	import { afterNavigate } from '$app/navigation';
	import Logo from '$lib/Logo.svelte';
	import ThemeToggle from '$lib/ThemeToggle.svelte';
	import { DOCS_NAV, docsPath } from '$lib/docs/nav.js';
	import { GITHUB_URL } from '$lib/release';

	let { slug = '', current = null, toc = [], html = '', prev = null, next = null } = $props();

	let navOpen = $state(false);
	let query = $state('');
	let activeId = $state('');
	let articleEl = $state(/** @type {HTMLElement | null} */ (null));

	const filteredNav = $derived(
		DOCS_NAV.map((section) => ({
			...section,
			items: section.items.filter((item) => {
				const q = query.trim().toLowerCase();
				if (!q) return true;
				return (
					item.label.toLowerCase().includes(q) || section.title.toLowerCase().includes(q)
				);
			}),
		})).filter((section) => section.items.length > 0),
	);

	afterNavigate(() => {
		navOpen = false;
	});

	$effect(() => {
		void html;
		const root = articleEl;
		if (!root) return;
		let cancelled = false;
		const frame = requestAnimationFrame(() => {
			if (!cancelled) enhanceCodeBlocks(root);
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
		};
	});

	$effect(() => {
		void html;
		const ids = toc.map((item) => item.id);
		if (ids.length === 0) return;
		let obs;
		const frame = requestAnimationFrame(() => {
			const els = ids.map((id) => document.getElementById(id)).filter(Boolean);
			if (els.length === 0) return;
			obs = new IntersectionObserver(
				(entries) => {
					const visible = entries
						.filter((entry) => entry.isIntersecting)
						.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
					if (visible[0]) activeId = visible[0].target.id;
				},
				{ rootMargin: '0px 0px -68% 0px', threshold: [0, 1] },
			);
			for (const el of els) obs.observe(el);
		});
		return () => {
			cancelAnimationFrame(frame);
			obs?.disconnect();
		};
	});

	function closeNav() {
		navOpen = false;
	}

	/**
	 * @param {HTMLElement} root
	 */
	function enhanceCodeBlocks(root) {
		root.querySelectorAll('pre').forEach((pre) => {
			if (pre.parentElement?.classList.contains('docs-code')) return;
			const wrap = document.createElement('div');
			wrap.className = 'docs-code';
			pre.parentNode?.insertBefore(wrap, pre);
			const code = pre.querySelector('code');
			const langClass = [...(code?.classList || [])].find((name) =>
				name.startsWith('language-'),
			);
			const bar = document.createElement('div');
			bar.className = 'docs-code-bar';
			const label = document.createElement('span');
			label.textContent = langClass ? langClass.slice('language-'.length) : 'Code';
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'docs-copy';
			btn.textContent = 'Kopieren';
			btn.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(code?.textContent || pre.textContent || '');
					btn.textContent = 'Kopiert';
					setTimeout(() => {
						btn.textContent = 'Kopieren';
					}, 1200);
				} catch {
					btn.textContent = 'Fehler';
				}
			});
			bar.append(label, btn);
			wrap.append(bar, pre);
		});
	}
</script>

<div class="docs" class:nav-open={navOpen}>
	<header class="docs-top">
		<a class="docs-brand" href="/" aria-label="BlueTalk">
			<Logo size={28} />
			<span>BlueTalk</span>
		</a>
		<div class="docs-top-actions">
			<ThemeToggle />
			<button
				type="button"
				class="docs-menu-btn"
				onclick={() => (navOpen = !navOpen)}
				aria-expanded={navOpen}
				aria-controls="docs-nav"
			>
				{navOpen ? 'Schließen' : 'Menü'}
			</button>
		</div>
	</header>

	{#if navOpen}
		<button type="button" class="docs-backdrop" onclick={closeNav} aria-label="Menü schließen"></button>
	{/if}

	<aside class="docs-side">
		<a class="docs-brand" href="/" aria-label="BlueTalk">
			<Logo size={28} />
			<span>BlueTalk</span>
		</a>
		<p class="docs-kicker">Plugin-API</p>
		<label class="docs-search-wrap">
			<span class="visually-hidden">Dokumentation durchsuchen</span>
			<input
				class="docs-search"
				type="search"
				placeholder="Suchen…"
				bind:value={query}
			/>
		</label>
		<nav class="docs-nav" id="docs-nav" aria-label="Dokumentation">
			{#each filteredNav as section}
				<div class="docs-nav-section">
					<div class="docs-nav-label">{section.title}</div>
					{#each section.items as item}
						<a
							href={docsPath(item.slug)}
							class="docs-nav-link"
							class:is-active={item.slug === slug}
							onclick={closeNav}
						>
							{item.label}
						</a>
					{/each}
				</div>
			{/each}
			{#if filteredNav.length === 0}
				<p class="docs-empty">Keine Treffer.</p>
			{/if}
		</nav>
		<div class="docs-side-foot">
			<div class="docs-side-links">
				<a href="/download">Download</a>
				<a href={GITHUB_URL} rel="noreferrer" target="_blank">GitHub</a>
			</div>
			<ThemeToggle />
		</div>
	</aside>

	<div class="docs-main">
		<div class="docs-article">
			{#if current}
				<p class="docs-crumb">{current.section} / {current.label}</p>
			{/if}
			<article class="docs-prose" bind:this={articleEl}>
				{@html html}
			</article>
			{#if prev || next}
				<div class="docs-pager">
					{#if prev}
						<a href={docsPath(prev.slug)}>
							<span>Zurück</span>
							{prev.label}
						</a>
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
					<a
						href="#{item.id}"
						class="docs-toc-link"
						class:is-sub={item.level > 2}
						class:is-active={item.id === activeId}
					>
						{item.text}
					</a>
				{/each}
			</aside>
		{/if}
	</div>
</div>

<style>
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.docs-search-wrap {
		display: block;
	}
</style>

