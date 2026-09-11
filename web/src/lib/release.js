const GITHUB = 'https://github.com/Bluetalk/bluetalk';
export const GITHUB_URL = GITHUB;
export const RELEASES_URL = `${GITHUB}/releases/latest`;

/**
 * @returns {Promise<{tag: string, name: string, url: string, size: number, sha256: string | null} | null>}
 */
export async function fetchInstaller() {
	const res = await fetch(`https://api.github.com/repos/Bluetalk/bluetalk/releases/latest`, {
		headers: { Accept: 'application/vnd.github+json' }
	});
	if (!res.ok) throw new Error(`GitHub ${res.status}`);
	const data = await res.json();
	const asset = data?.assets?.find(
		(a) => /x64-setup\.exe$/i.test(a.name) && !/1\.1\.25/.test(a.name)
	);
	if (!asset) return null;
	const digest = typeof asset.digest === 'string' ? asset.digest : '';
	return {
		tag: data.tag_name || 'latest',
		name: asset.name,
		url: asset.browser_download_url,
		size: asset.size || 0,
		sha256: digest.startsWith('sha256:') ? digest.slice(7) : null
	};
}

/** @param {number} bytes */
export function formatBytes(bytes) {
	if (!bytes) return '—';
	const mb = bytes / (1024 * 1024);
	return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
