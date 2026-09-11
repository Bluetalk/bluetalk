<script>
	import { onMount } from 'svelte';
	import Logo from '$lib/Logo.svelte';
	import { fetchInstaller, formatBytes, RELEASES_URL } from '$lib/release';

	let status = $state('loading');
	/** @type {{ tag: string, name: string, url: string, size: number, sha256: string | null } | null} */
	let installer = $state(null);

	onMount(() => {
		fetchInstaller()
			.then((info) => {
				installer = info;
				status = info ? 'ready' : 'empty';
			})
			.catch(() => {
				status = 'error';
			});
	});
</script>

<svelte:head>
	<title>Download — BlueTalk</title>
	<meta name="description" content="BlueTalk für Windows laden." />
</svelte:head>

<main class="wrap">
	<div class="card">
		<a class="mark mark-sm" href="/" aria-label="Zur Startseite">
			<Logo size={80} />
		</a>
		<h1>Download</h1>
		<p class="meta">Windows x64 · NSIS-Installer</p>

		{#if status === 'loading'}
			<p class="meta">Release wird gelesen…</p>
		{:else if status === 'ready' && installer}
			<p class="meta">{installer.tag} · {formatBytes(installer.size)}</p>
			<div class="row">
				<a class="btn btn-primary" href={installer.url}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<path
							d="M12 3v12m0 0 4.5-4.5M12 15 7.5 10.5M5 21h14"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
					Installer laden
				</a>
			</div>
			<p class="file">{installer.name}</p>
			{#if installer.sha256}
				<p class="file">SHA-256 {installer.sha256}</p>
			{/if}
		{:else}
			<p class="meta">Release nicht erreichbar.</p>
			<div class="row">
				<a class="btn btn-primary" href={RELEASES_URL} rel="noreferrer" target="_blank">
					GitHub Releases
				</a>
			</div>
		{/if}

		<a class="back" href="/">← BlueTalk</a>
	</div>
</main>
