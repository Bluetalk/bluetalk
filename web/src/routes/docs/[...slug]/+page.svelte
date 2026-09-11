<script>
	import DocsShell from '$lib/docs/DocsShell.svelte';
	let { data } = $props();
</script>

<svelte:head>
	<title>{data.current?.label || 'Plugin-API'} — BlueTalk</title>
	<meta name="description" content="BlueTalk Plugin-API Dokumentation." />
</svelte:head>

<DocsShell {...data} />
