import SHA256 from 'crypto-js/sha256'

export type CacheIdentity = { sourceId: string; quality: IMusic.IQualityKey }

// Include script contents: replacing a source under the same ID invalidates its files.
export function sourceId(api: IMusic.MusicApi | null, platform = 'tx'): string {
	if (!api) return 'direct'
	return JSON.stringify([api.id, api.version || '', SHA256(api.script || '').toString(), platform])
}

export const songKey = (item: IMusic.IMusicItem) =>
	JSON.stringify([item.platform || '', String(item.id)])
