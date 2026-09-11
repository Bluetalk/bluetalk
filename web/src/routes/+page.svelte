<script>
	import Logo from '$lib/Logo.svelte';
	import { GITHUB_URL } from '$lib/release';
</script>

<svelte:head>
	<title>BlueTalk</title>
	<meta name="description" content="BlueTalk — Peer-to-Peer Messenger." />
</svelte:head>

<main class="wrap">
	<div class="card">
		<div class="mark">
			<Logo size={112} />
		</div>
		<h1>BlueTalk</h1>
		<div class="row">
			<a class="btn btn-primary" href="/download">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
					<path
						d="M12 3v12m0 0 4.5-4.5M12 15 7.5 10.5M5 21h14"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				Download
			</a>
			<a class="btn btn-ghost" href="/docs">Plugin-API</a>
			<a class="btn btn-ghost" href={GITHUB_URL} rel="noreferrer" target="_blank">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path
						d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.95 0-1.1.39-1.99 1.03-2.7-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0 1 12 6.8c.85 0 1.71.11 2.51.33 1.9-1.29 2.74-1.02 2.74-1.02.55 1.37.2 2.39.1 2.64.64.71 1.03 1.6 1.03 2.7 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
					/>
				</svg>
				GitHub
			</a>
		</div>
	</div>
</main>
