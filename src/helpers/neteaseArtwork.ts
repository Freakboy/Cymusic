import { currentMusicStore, importedLocalMusicStore, playListsStore } from '@/player/PlayerStore'
import PersistStatus from '@/store/PersistStatus'
import { getPlayList, setPlayList } from '@/store/playList'
import { neteaseArtworkKey, usableArtwork } from '@/utils/imageUtils'
import { neteaseImage, normalizeNeteaseSong, requestJson } from './userApi/remotePlaylist'

export type ArtworkTrack = { id?: string | number; platform?: string; artwork?: string; verifiedArtwork?: string }
/** A candidate is not proof of an image download. Confirm with Image.onLoad. */
export type ArtworkRepairResult = { artwork: string; candidates?: string[]; retryable?: boolean; retryAt?: number }

export function neteaseArtworkCandidates(artwork?: string): string[] {
	const uri = usableArtwork(artwork)
	if (!uri || !/^https?:/.test(uri)) return []
	const urls = [uri]
	const url = new URL(uri)
	if (/^p\d+c?\.music\.126\.net$/.test(url.hostname)) {
		const id = url.pathname.match(/\/(\d+)\.(?:jpg|png|webp)$/i)?.[1]
		if (id) urls.push(neteaseImage(id))
		for (const source of [...urls]) {
			for (const host of ['p1.music.126.net', 'p2.music.126.net', 'p3.music.126.net']) {
				const next = new URL(source)
				next.protocol = 'https:'
				next.hostname = host
				urls.push(next.href)
			}
		}
	}
	return [...new Set(urls.filter(Boolean))].slice(0, 8)
}

type DetailResult = { expires: number; urls: string[] }
const inFlight = new Map<string, Promise<DetailResult>>()
const demand = new Map<string, (() => boolean)[]>()
const cache = new Map<string, { expires: number; urls: string[] }>()
const waiting: (() => void)[] = []
let running = 0

function detailArtwork(id: string, isActive: () => boolean = () => true): Promise<DetailResult> {
	const cached = cache.get(id)
	if (cached && cached.expires > Date.now()) return Promise.resolve(cached)
	const pending = inFlight.get(id)
	if (pending) { demand.get(id)?.push(isActive); return pending }
	if (!isActive()) return Promise.resolve({ urls: [], expires: Date.now() + 1000 })
	if (waiting.length >= 32) return Promise.resolve({ urls: [], expires: Date.now() + 1000 })
	const consumers = [isActive]
	demand.set(id, consumers)
	const task = new Promise<DetailResult>((resolve) => {
		const run = async () => {
			if (!consumers.some(active => active())) {
				inFlight.delete(id)
				demand.delete(id)
				resolve({ urls: [], expires: Date.now() + 1000 })
				waiting.shift()?.()
				return
			}
			running++
			let urls: string[] = []
			let transient = false
			try {
				const data = await requestJson(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(`[${id}]`)}`)
				const song = data?.songs?.find((item: any) => String(item?.id) === id)
				if (song) {
					// A syntactically valid picUrl can still contain an obsolete ID/hash.
					const albums = [song.al, song.album]
					urls = [...new Set([
						...albums.map(album => neteaseImage(album?.pic_str, album?.picId_str, album?.picId, album?.pic)),
						normalizeNeteaseSong(song).artwork,
						...albums.map(album => album?.picUrl),
					].flatMap(neteaseArtworkCandidates))].slice(0, 16)
				}
			} catch { transient = true }
			cache.delete(id)
			const result = { expires: Date.now() + (urls.length ? 300000 : transient ? 5000 : 60000), urls }
			cache.set(id, result)
			if (cache.size > 128) cache.delete(cache.keys().next().value!)
			inFlight.delete(id)
			demand.delete(id)
			running--
			resolve(result)
			waiting.shift()?.()
		}
		if (running < 2) void run()
		else waiting.push(() => { void run() })
	})
	inFlight.set(id, task)
	return task
}

/** Call only for a visible/current track. Detail can race local CDN recovery after first failure. */
export async function repairNeteaseArtwork(
	track: ArtworkTrack,
	failed: readonly string[] = [],
	options: { detailOnly?: boolean; isActive?: () => boolean } = {},
): Promise<ArtworkRepairResult> {
	if (!neteaseArtworkKey(track)) return { artwork: '' }
	let candidates = options.detailOnly ? [] : neteaseArtworkCandidates(track.artwork).filter(url => !failed.includes(url))
	if (!candidates.length) {
		const detail = await detailArtwork(String(track.id), options.isActive)
		candidates = detail.urls.filter(url => !failed.includes(url))
		if (!candidates.length) {
			// Download failures invalidate positive candidate cache, not persisted verified artwork.
			if (detail.urls.length) {
				const rejected = { urls: [], expires: Date.now() + 5000 }
				cache.set(String(track.id), rejected)
				return { artwork: '', candidates, retryable: true, retryAt: rejected.expires }
			}
			return { artwork: '', candidates, retryable: true, retryAt: detail.expires }
		}
	}
	return { artwork: candidates[0] || '', candidates }
}

const updates = new Map<string, { artwork: string; previousVerified?: string; previousArtwork?: string }>()
let persistTimer: ReturnType<typeof setTimeout> | undefined

/** Enqueue only artwork confirmed by Image.onLoad (or a verified image response). */
export function updateTrackArtwork(track: ArtworkTrack, artwork: string): void {
	const key = neteaseArtworkKey(track)
	if (!key || !usableArtwork(artwork) || (track.artwork === artwork && track.verifiedArtwork === artwork)) return
	updates.set(key, { artwork, previousVerified: track.verifiedArtwork, previousArtwork: track.artwork })
	if (persistTimer === undefined) persistTimer = setTimeout(flushTrackArtworkUpdates, 250)
}

/** One traversal/write per collection per batch; read latest stores at flush time. */
export function flushTrackArtworkUpdates(): void {
	if (persistTimer !== undefined) clearTimeout(persistTimer)
	persistTimer = undefined
	if (!updates.size) return
	const batch = new Map(updates)
	updates.clear()
	const patch = <T extends ArtworkTrack>(track: T): T => {
		const key = neteaseArtworkKey(track)
		const update = key ? batch.get(key) : undefined
		if (track.verifiedArtwork && track.verifiedArtwork !== update?.previousVerified &&
			track.verifiedArtwork !== update?.previousArtwork && track.verifiedArtwork !== update?.artwork) return track
		const artwork = update?.artwork
		return artwork && (artwork !== track.artwork || artwork !== track.verifiedArtwork)
			? { ...track, artwork, verifiedArtwork: artwork } : track
	}
	const patchList = <T extends ArtworkTrack>(tracks: T[]): T[] => {
		const next = tracks.map(patch)
		return next.some((track, index) => track !== tracks[index]) ? next : tracks
	}
	const lists = playListsStore.getValue() ?? PersistStatus.get('music.playLists') ?? []
	const next = lists.map(list => {
		const songs = patchList(list.songs)
		return songs === list.songs ? list : { ...list, songs }
	})
	if (next.some((list, index) => list !== lists[index])) {
		playListsStore.setValue(next)
		PersistStatus.set('music.playLists', next)
	}
	const local = importedLocalMusicStore.getValue() ?? PersistStatus.get('music.importedLocalMusic') ?? []
	const nextLocal = patchList(local)
	if (nextLocal !== local) {
		importedLocalMusicStore.setValue(nextLocal)
		PersistStatus.set('music.importedLocalMusic', nextLocal)
	}
	const queue = getPlayList()
	const nextQueue = patchList(queue)
	if (nextQueue !== queue) setPlayList(nextQueue)
	const current = currentMusicStore.getValue()
	if (current && patch(current) !== current) {
		currentMusicStore.setValue(patch(current))
		PersistStatus.set('music.musicItem', patch(current))
	}
}
