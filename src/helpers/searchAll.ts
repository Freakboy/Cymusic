import axios from 'axios'
import type { Track } from '@/player/types'
import { txSearchRequest } from '@/player/sourceResolver/txSearch'
import CryptoJS from 'crypto-js'

export type SearchType = 'songs' | 'artists' | 'albums' | 'playlists'
export const SEARCH_PAGE_SIZE = 20
const categories = {
	songs: [0, 'song'],
	artists: [1, 'singer'],
	albums: [2, 'album'],
	playlists: [3, 'songlist'],
} as const

// Reuse qqMatch's desktop envelope; re-sign after changing pagination/category.
export function searchRequest(query: string, page: number, searchType: number) {
	const request = txSearchRequest(query)
	Object.assign(request.data.req_1.param, { page_num: page, search_type: searchType })
	const hash = CryptoJS.SHA1(JSON.stringify(request.data)).toString()
	const pick = (indexes: number[]) => indexes.map((index) => hash[index]).join('')
	const scramble = [
		89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
	]
	const bytes = scramble
		.map((value, index) =>
			(value ^ parseInt(hash.slice(index * 2, index * 2 + 2), 16)).toString(16).padStart(2, '0'),
		)
		.join('')
	const base64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Hex.parse(bytes)).replace(/[/+=]/g, '')
	const sign =
		`zzc${pick([23, 14, 6, 36, 16, 40, 7, 19])}${base64}${pick([16, 1, 32, 12, 19, 27, 8, 5])}`.toLowerCase()
	return { ...request, url: `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}` }
}

function checkAbort(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error('SEARCH_CANCELLED')
}

class SearchResponseError extends Error {
	constructor(
		public apiCode: unknown,
		public searchCode: unknown,
	) {
		super(`Invalid search response (api=${String(apiCode)}, search=${String(searchCode)})`)
	}
}

async function requestSearch(
	query: string,
	page: number,
	searchType: number,
	signal?: AbortSignal,
) {
	const request = searchRequest(query, page, searchType)
	for (let attempt = 0; attempt < 2; attempt++) {
		checkAbort(signal)
		try {
			const response = await axios.post(
				attempt === 0 ? request.url : 'https://u.y.qq.com/cgi-bin/musicu.fcg',
				request.data,
				{ signal, timeout: 8000, headers: { ...request.headers, referer: 'https://y.qq.com/' } },
			)
			checkAbort(signal)
			if (
				(response.data?.code != null && response.data.code !== 0) ||
				response.data?.req_1?.code !== 0
			)
				throw new SearchResponseError(response.data?.code, response.data?.req_1?.code)
			return response
		} catch (cause) {
			checkAbort(signal)
			const error = cause as { code?: string; response?: { status: number } }
			// Only transport failures/5xx or explicit gateway/signature rejection may fall back.
			// Do not repeat unknown business failures, 4xx/rate limits, cancellation or malformed data.
			const fallback =
				cause instanceof SearchResponseError
					? cause.apiCode === 2000 || cause.searchCode === 2000
					: ['ERR_NETWORK', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'].includes(error.code || '') ||
						(error.response?.status >= 500 && error.response?.status <= 599)
			if (attempt === 1 || !fallback) throw cause
		}
	}
	throw new Error('SEARCH_FAILED')
}

export default async function searchAll(
	query: string,
	page = 1,
	type: SearchType = 'songs',
	signal?: AbortSignal,
): Promise<{ data: Track[]; hasMore: boolean }> {
	if (!query.trim()) return { data: [], hasMore: false }
	const [searchType, key] = categories[type]
	const response = await requestSearch(query.trim(), page, searchType, signal)
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
