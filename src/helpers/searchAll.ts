import axios from 'axios'
import type { Track } from '@/player/types'

export type SearchType = 'songs' | 'artists' | 'albums' | 'playlists'
export const SEARCH_PAGE_SIZE = 20
const categories = {
	songs: [0, 'song'],
	artists: [1, 'singer'],
	albums: [2, 'album'],
	playlists: [3, 'songlist'],
} as const

export default async function searchAll(
	query: string,
	page = 1,
	type: SearchType = 'songs',
	signal?: AbortSignal,
): Promise<{ data: Track[]; hasMore: boolean }> {
	if (!query.trim()) return { data: [], hasMore: false }
	const [searchType, key] = categories[type]
	const response = await axios.post(
		'https://u.y.qq.com/cgi-bin/musicu.fcg',
		{
			req_1: {
				method: 'DoSearchForQQMusicDesktop',
				module: 'music.search.SearchCgiService',
				param: {
					num_per_page: SEARCH_PAGE_SIZE,
					page_num: page,
					query: query.trim(),
					search_type: searchType,
				},
			},
		},
		{ signal, timeout: 15000, headers: { referer: 'https://y.qq.com' } },
	)
	const result = response.data?.req_1
	const list = result?.data?.body?.[key]?.list
	if (
		(response.data?.code != null && response.data.code !== 0) ||
		result?.code !== 0 ||
		!Array.isArray(list)
	) {
		throw new Error('Invalid search response')
	}
	const data: Track[] = list.map((item) => {
		if (type === 'artists')
			return {
				id: String(item.singerMID || item.singerID),
				title: item.singerName,
				artist: item.singerName,
				artwork: item.singerPic,
				isArtist: true,
				singerMID: item.singerMID,
			}
		if (type === 'albums')
			return {
				id: String(item.albumMID || item.album_mid || item.albumID),
				title: item.albumName || item.album_name,
				artist: item.singerName || item.singer_name,
				artwork:
					item.albumPic ||
					`https://y.gtimg.cn/music/photo_new/T002R800x800M000${item.albumMID || item.album_mid}.jpg`,
				searchKind: 'albums',
				albumMID: item.albumMID || item.album_mid,
			}
		if (type === 'playlists')
			return {
				id: String(item.dissid),
				title: item.dissname,
				artist: item.creator?.name || '',
				artwork: item.imgurl,
				searchKind: 'playlists',
			}
		return {
			id: String(item.mid || item.songmid || item.songid),
			songmid: item.mid || item.songmid,
			platform: 'tx',
			title: item.title || item.songname,
			artist: (item.singer || []).map((s: { name: string }) => s.name).join(', '),
			album: item.album?.title || item.albumname,
			artwork: `https://y.gtimg.cn/music/photo_new/T002R800x800M000${item.album?.mid || item.albummid}.jpg`,
		}
	})
	if (data.some((item) => !item.id || item.id === 'undefined' || !item.title)) {
		throw new Error('Incomplete search results')
	}
	const total = result.data.meta?.sum
	const count = Number(total)
	if (total != null && (!Number.isSafeInteger(count) || count < 0)) {
		throw new Error('Invalid search total')
	}
	return {
		data,
		hasMore:
			list.length > 0 &&
			(total != null ? page * SEARCH_PAGE_SIZE < count : list.length === SEARCH_PAGE_SIZE),
	}
}
