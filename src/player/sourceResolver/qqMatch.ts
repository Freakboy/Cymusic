import axios from 'axios'
import { songKey } from '../sourceIdentity'

type Candidate = { mid: string; title: string; artist: string; album: string; duration: number }
const matches = new Map<string, { value: string | null; expires: number }>()
const normalize = (value: string) =>
	(value || '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]/gu, '')
const placeholders = new Set([
	'unknown',
	'unknownalbum',
	'unknownartist',
	'unknowntitle',
	'unknownsong',
	'unknownsinger',
	'未知专辑',
	'未知歌手',
	'未知艺术家',
	'未知标题',
	'未知歌曲',
])
const metadata = (value: string) => {
	const normalized = normalize(value)
	return placeholders.has(normalized) ? '' : normalized
}
const artists = (value: string) =>
	(value || '')
		.split(/[,、/&;，]/)
		.map(metadata)
		.filter(Boolean)
		.sort()
		.join('|')

export function selectQQMatch(item: IMusic.IMusicItem, candidates: Candidate[]): string | null {
	const valid = candidates.filter((candidate) => {
		if (!/^[a-z\d]{14}$/i.test(candidate.mid)) return false
		if (!metadata(item.title) || !artists(item.artist)) return false
		if (
			metadata(candidate.title) !== metadata(item.title) ||
			artists(candidate.artist) !== artists(item.artist)
		)
			return false
		const hasAlbum = !!metadata(item.album)
		const hasDuration = Number.isFinite(item.duration) && item.duration > 0
		if (hasAlbum && metadata(candidate.album) !== metadata(item.album)) return false
		return (
			!hasDuration || (candidate.duration > 0 && Math.abs(candidate.duration - item.duration) <= 3)
		)
	})
	const mids = [...new Set(valid.map((item) => item.mid))]
	return mids.length === 1 ? mids[0] : null
}

export async function resolveQQMid(item: IMusic.IMusicItem, signal?: AbortSignal): Promise<string> {
	const platform = (item.platform || '').trim().toLowerCase()
	if (['', 'tx', 'qq', 'qqmusic'].includes(platform)) {
		const mid = [item.songmid, item.id].find(
			(value) => typeof value === 'string' && /^[a-z\d]{14}$/i.test(value),
		)
		if (mid) return mid
	}
	const key = JSON.stringify([songKey(item), item.title, item.artist, item.album, item.duration])
	const cached = matches.get(key)
	if (cached && cached.expires > Date.now()) {
		if (!cached.value) throw new Error('QQ_MATCH_NOT_FOUND')
		return cached.value
	}
	const response = await axios.post(
		'https://u.y.qq.com/cgi-bin/musicu.fcg',
		{
			req_1: {
				method: 'DoSearchForQQMusicDesktop',
				module: 'music.search.SearchCgiService',
				param: {
					num_per_page: 20,
					page_num: 1,
					query: `${item.title} ${item.artist}`,
					search_type: 0,
				},
			},
		},
		{ signal, timeout: 10000, headers: { referer: 'https://y.qq.com' } },
	)
	const result = response.data?.req_1
	const list = result?.data?.body?.song?.list
	if (
		(response.data?.code != null && response.data.code !== 0) ||
		result?.code !== 0 ||
		!Array.isArray(list)
	)
		throw new Error('QQ_SEARCH_FAILED')
	const mid = selectQQMatch(
		item,
		list.map((song) => ({
			mid: String(song.mid || song.songmid || ''),
			title: song.title || song.songname || '',
			artist: (song.singer || []).map((singer: { name: string }) => singer.name).join(', '),
			album: song.album?.title || song.albumname || '',
			duration: Number(song.interval || 0),
		})),
	)
	if (signal?.aborted) throw new Error('SOURCE_CANCELLED')
	matches.set(key, { value: mid, expires: Date.now() + (mid ? 86400000 : 60000) })
	if (matches.size > 300) matches.delete(matches.keys().next().value!)
	if (!mid) throw new Error('QQ_MATCH_NOT_FOUND')
	return mid
}
