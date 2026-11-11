import type { Track } from '@/player/types'
import { sourceId } from '@/player/sourceIdentity'
import { resolveLocalFile } from '@/helpers/localFile'
import * as FileSystem from 'expo-file-system/legacy'

export function songInformation(track: Track, apis: IMusic.MusicApi[]) {
	const identity = typeof track.cacheSourceId === 'string' ? track.cacheSourceId : ''
	let platform: string | undefined
	try {
		const parts = JSON.parse(identity)
		// Only resolver-shaped provenance confirms a returned tier; cache markers alone do not.
		if (Array.isArray(parts) && parts.length === 4 &&
			parts.every((part) => typeof part === 'string') &&
			/^[a-f0-9]{64}$/i.test(parts[2]) &&
			['tx', 'wy', 'kg', 'kw', 'mg'].includes(parts[3])) platform = parts[3]
	} catch { /* No script provenance. */ }
	const api = platform ? apis.find((candidate) => sourceId(candidate, platform) === identity) : undefined
	const url = typeof track.url === 'string' ? track.url : ''
	const local = /^file:\/\/|^\//i.test(url)
	return {
		title: track.title, artist: track.artist, album: track.album, id: track.id, originalPlatform: track.platform,
		quality: platform && ['128k', '320k', 'flac'].includes(track.cacheQuality) ? String(track.cacheQuality) : undefined,
		format: url.split(/[?#]/)[0].match(/\.(mp3|flac|m4a|aac|wav|ogg|opus)$/i)?.[1]?.toUpperCase(),
		script: api?.name, sourcePlatform: platform,
		location: local ? (identity ? 'cache' : 'local') : /^https?:\/\//i.test(url) ? 'remote' : undefined,
	}
}

export async function songInformationSize(track: Track, isCurrent: () => boolean): Promise<number | undefined> {
	if (!isCurrent() || typeof track.url !== 'string' || !/^file:\/\/|^\//i.test(track.url)) return undefined
	const local = await resolveLocalFile(track.url)
	if (!isCurrent() || local.status !== 'resolved') return undefined
	const info = await FileSystem.getInfoAsync(local.fileUri)
	if (!isCurrent() || !info.exists || info.isDirectory || !Number.isFinite(info.size)) return undefined
	return info.size
}

let serial = 0
const snapshots = new Map<string, Track>()
export function songInformationRoute(track: Track, current?: Track | null) {
	const token = String(++serial)
	const selected = current && current.id === track.id && current.platform === track.platform ? current : track
	snapshots.set(token, { ...selected })
	if (snapshots.size > 16) snapshots.delete(snapshots.keys().next().value!)
	return { pathname: '/(modals)/songInformation' as const, params: { token } }
}
export const getSongInformationTrack = (token: string) => snapshots.get(token)
