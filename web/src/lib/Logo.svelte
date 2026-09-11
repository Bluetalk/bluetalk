<script>
	let { size = 112 } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
	<defs>
		<linearGradient id="orb" x1="0%" x2="100%" y1="0%" y2="100%">
			<stop offset="0%" stop-color="#60a5fa" />
			<stop offset="100%" stop-color="#2563eb" />
		</linearGradient>
	</defs>
	<rect width="32" height="32" rx="10" fill="#08111f" />
	<circle cx="16" cy="16" r="8" fill="url(#orb)" />
	<circle cx="16" cy="16" r="3" fill="#f8fafc" />
</svg>
