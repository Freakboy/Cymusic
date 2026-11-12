import axios from 'axios'
import type { Track } from '@/player/types'

export type HotKind = 'songs' | 'playlists'
export const HOT_SONGS_URL =
	'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=26&format=json'
export const HOT_PLAYLISTS_URL =
	'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?categoryId=10000000&sortId=5&sin=0&ein=9&format=json&inCharset=utf8&outCharset=utf-8'

// QQ hot-song chart and playlist catalogue sorted by popularity, never keyword search.
export async function fetchSearchHot(kind: HotKind, signal?: AbortSignal, page = 0): Promise<Track[]> {
	if (!Number.isSafeInteger(page) || page < 0 || page > 99) throw new Error('Invalid hot page')
	if (signal?.aborted) throw new Error('HOT_CANCELLED')
	const playlistUrl = HOT_PLAYLISTS_URL.replace('sin=0&ein=9', `sin=${page * 10}&ein=${page * 10 + 9}`)
	const response = await axios.get(kind === 'songs' ? HOT_SONGS_URL : playlistUrl, {
		signal,
		timeout: 10000,
		headers: { referer: 'https://y.qq.com/' },
	})
	if (signal?.aborted) throw new Error('HOT_CANCELLED')
	const body = response.data
	const list = kind === 'songs' ? body?.songlist : body?.data?.list
	if (body?.code !== 0 || (body.subcode != null && body.subcode !== 0) || !Array.isArray(list))
		throw new Error(
			`Invalid hot ${kind} response (code=${String(body?.code)}, subcode=${String(body?.subcode)})`,
		)
	const tracks: Track[] = list.slice(0, kind === 'songs' ? 20 : 10).map((entry) => {
		if (kind === 'playlists')
			return {
				id: String(entry.dissid || ''),
				title: entry.dissname,
				artist: entry.creator?.name || '',
				artwork: entry.imgurl?.replace(/^http:/, 'https:'),
				searchKind: 'playlists',
			}
		const song = entry.data
		return {
			id: String(song?.songmid || ''),
			songmid: song?.songmid,
			platform: 'tx',
			title: song?.songname,
			artist: (song?.singer || []).map((artist: { name: string }) => artist.name).join(', '),
			album: song?.albumname,
			duration: song?.interval,
			artwork: song?.albummid
				? `https://y.gtimg.cn/music/photo_new/T002R800x800M000${song.albummid}.jpg`
				: undefined,
		}
	})
	if ((!tracks.length && (kind === 'songs' || page === 0)) || tracks.some((track) => !track.id || !track.title))
		throw new Error(`Incomplete hot ${kind} response`)
	const seen = new Set<string>()
	return tracks.filter((track) => {
		if (seen.has(track.id)) return false
		seen.add(track.id)
		return true
	})
}
