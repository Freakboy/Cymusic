import { currentMusicStore, importedLocalMusicStore, playListsStore } from '@/player/PlayerStore'
import PersistStatus from '@/store/PersistStatus'
import { getPlayList, setPlayList } from '@/store/playList'
import { neteaseArtworkKey, usableArtwork } from '@/utils/imageUtils'
import { neteaseImage, normalizeNeteaseSong, requestJson } from './userApi/remotePlaylist'

export type ArtworkTrack = { id?: string | number; platform?: string; artwork?: string }
/** A candidate is not proof of an image download. Confirm with Image.onLoad. */
export type ArtworkRepairResult = { artwork: string; candidates?: string[] }

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

const inFlight = new Map<string, Promise<string[]>>()
const cache = new Map<string, { expires: number; urls: string[] }>()
const waiting: (() => void)[] = []
let running = 0

function detailArtwork(id: string): Promise<string[]> {
	const cached = cache.get(id)
	if (cached && cached.expires > Date.now()) return Promise.resolve(cached.urls)
	const pending = inFlight.get(id)
	if (pending) return pending
	if (waiting.length >= 32) return Promise.resolve([])
	const task = new Promise<string[]>((resolve) => {
		const run = async () => {
			running++
			let urls: string[] = []
			try {
				const data = await requestJson(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(`[${id}]`)}`)
				const song = data?.songs?.find((item: any) => String(item?.id) === id)
				if (song) {
					// A syntactically valid picUrl can still contain an obsolete ID/hash.
					const albums = [song.al, song.album]
					urls = [...new Set([
						normalizeNeteaseSong(song).artwork,
						...albums.flatMap(album => [album?.picUrl,
							neteaseImage(album?.pic_str, album?.picId_str, album?.picId, album?.pic)]),
					].flatMap(neteaseArtworkCandidates))].slice(0, 16)
				}
			} catch { /* Negative cache prevents repeated visible-row retries. */ }
			cache.delete(id)
			cache.set(id, { expires: Date.now() + (urls.length ? 300000 : 60000), urls })
			if (cache.size > 128) cache.delete(cache.keys().next().value!)
			inFlight.delete(id)
			running--
			resolve(urls)
			waiting.shift()?.()
		}
		if (running < 2) void run()
		else waiting.push(() => { void run() })
	})
	inFlight.set(id, task)
	return task
}

/** Call only for a visible/current track. Exhaust local candidates before detail I/O. */
export async function repairNeteaseArtwork(
	track: ArtworkTrack,
	failed: readonly string[] = [],
): Promise<ArtworkRepairResult> {
	if (!neteaseArtworkKey(track)) return { artwork: '' }
	let candidates = neteaseArtworkCandidates(track.artwork).filter(url => !failed.includes(url))
	if (!candidates.length) candidates = (await detailArtwork(String(track.id))).filter(url => !failed.includes(url))
	return { artwork: candidates[0] || '', candidates }
}

const updates = new Map<string, string>()
let persistTimer: ReturnType<typeof setTimeout> | undefined

/** Enqueue only artwork confirmed by Image.onLoad (or a verified image response). */
export function updateTrackArtwork(track: ArtworkTrack, artwork: string): void {
	const key = neteaseArtworkKey(track)
	if (!key || !usableArtwork(artwork)) return
	updates.set(key, artwork)
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
		const artwork = key ? batch.get(key) : undefined
		return artwork && artwork !== track.artwork ? { ...track, artwork } : track
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
