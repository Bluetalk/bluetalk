export const THEME_KEY = 'bt-theme';

export function readTheme() {
	if (typeof document === 'undefined') return 'dark';
	return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function applyTheme(next) {
	const value = next === 'light' ? 'light' : 'dark';
	document.documentElement.setAttribute('data-theme', value);
	document.documentElement.style.colorScheme = value;
	const color = document.querySelector('meta[name="theme-color"]');
	if (color) color.setAttribute('content', value === 'light' ? '#f4f4f5' : '#0a0a0a');
	const scheme = document.querySelector('meta[name="color-scheme"]');
	if (scheme) scheme.setAttribute('content', value);
	try {
		localStorage.setItem(THEME_KEY, value);
	} catch {
		/* ignore */
	}
}

export function toggleTheme() {
	applyTheme(readTheme() === 'light' ? 'dark' : 'light');
}
