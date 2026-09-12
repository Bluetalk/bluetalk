<script>
	import { toggleTheme } from './theme.js';
</script>

<button
	type="button"
	class="theme-btn"
	onclick={toggleTheme}
	aria-label="Design wechseln"
	title="Design wechseln"
>
	<svg class="theme-icon theme-icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
		<path
			d="M21 14.3A8.5 8.5 0 1 1 9.7 3 7 7 0 0 0 21 14.3Z"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
	<svg class="theme-icon theme-icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
		<circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.8" />
		<path
			d="M12 3v1.6M12 19.4V21M4.93 4.93l1.13 1.13M17.94 17.94l1.13 1.13M3 12h1.6M19.4 12H21M4.93 19.07l1.13-1.13M17.94 6.06l1.13-1.13"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
		/>
	</svg>
</button>
