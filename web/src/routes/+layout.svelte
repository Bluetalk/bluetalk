<script>
	import '../app.css';
	import ThemeToggle from '$lib/ThemeToggle.svelte';
	let { children } = $props();
</script>

{@render children?.()}
<div class="theme-fab">
	<ThemeToggle />
</div>
