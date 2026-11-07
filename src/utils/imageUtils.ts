/**
 * Rewrite QQ Music artwork URL to use a smaller resolution for list thumbnails.
 * Original URLs use T002R800x800M000 or T002R500x500M000 which are overkill for 50x50pt cells.
 */
export function getThumbnailArtwork(artworkUrl: string | undefined, size: 150 | 300 = 150): string | undefined {
	if (!artworkUrl) return artworkUrl
	return artworkUrl
		.replace(/T002R800x800M000/, `T002R${size}x${size}M000`)
		.replace(/T002R500x500M000/, `T002R${size}x${size}M000`)
}

export function getFullArtwork(artworkUrl: string | undefined): string | undefined {
	if (!artworkUrl) return artworkUrl
	return artworkUrl
		.replace(/T002R150x150M000/, 'T002R500x500M000')
		.replace(/T002R300x300M000/, 'T002R500x500M000')
}

/** Keep native local artwork, but never pass malformed HTTP URLs to Image. */
export function usableArtwork(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined
	const uri = value.trim()
	if (/^(file|content|asset|data):/i.test(uri)) return uri
	try {
		const url = new URL(uri.replace(/^\/\//, 'https://'))
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
		return url.href
	} catch { return undefined }
}

/** Canonical identity for artwork only; never infer a platform from a song ID. */
export function neteaseArtworkKey(track: { id?: string | number; platform?: string } | null | undefined): string | undefined {
	if (typeof track?.platform !== 'string' || !['netease', 'wy', '163'].includes(track.platform.toLowerCase())) return undefined
	const id = track.id
	if (typeof id === 'number' && (!Number.isSafeInteger(id) || id <= 0)) return undefined
	if ((typeof id !== 'number' && typeof id !== 'string') || !/^[1-9]\d*$/.test(String(id))) return undefined
	return `Netease:${id}`
}
