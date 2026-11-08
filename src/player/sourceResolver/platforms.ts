import axios from 'axios'
import CryptoJS from 'crypto-js'
import { resolveQQInfo } from './qqMatch'
import { txSearchRequest } from './txSearch'
import type { SourceMusicApi } from '@/helpers/userApi/importMusicSource'

export const RESOLUTION_PLATFORMS = ['tx', 'wy', 'kg', 'kw', 'mg'] as const
export type ResolutionPlatform = (typeof RESOLUTION_PLATFORMS)[number]
export type PlatformMusicInfo = {
	source: ResolutionPlatform
	id: string | number
	songmid: string | number
	name: string
	singer: string
	albumName: string
	duration: number
	[key: string]: any
}
export type SourceRequestContext = {
	platform?: ResolutionPlatform
	musicInfo?: PlatformMusicInfo
	requestKey?: string
	requestType?: 'current' | 'preload'
	timeoutMs?: number
	signal?: AbortSignal
}

export function supportsPlatform(api: SourceMusicApi, platform: ResolutionPlatform): boolean {
	const capability = api.sources?.[platform]
	if (capability === undefined) return platform === 'tx' && api.scriptType !== 'lxmusic'
	return !!capability && capability.actions?.includes('musicUrl') === true
}

const text = (value: unknown) => String(value ?? '')
const decode = (value: unknown) =>
	text(value)
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
const normalize = (value: unknown) =>
	decode(value)
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]/gu, '')
const metadata = (value: unknown) => {
	const result = normalize(value)
	return /^(unknown(album|artist|title|song|singer)?|未知(专辑|歌手|艺术家|标题|歌曲))$/.test(
		result,
	)
		? ''
		: result
}
const artists = (value: unknown) =>
	text(value)
		.split(/[,、/&;，]/)
		.map(metadata)
		.filter(Boolean)
		.sort()
		.join('|')
const singers = (list: any[]) => (list || []).map((s) => s.name).join('、')
const validId = (source: ResolutionPlatform, info: PlatformMusicInfo) =>
	source === 'tx'
		? /^[a-z\d]{14}$/i.test(text(info.songmid))
		: source === 'kg'
			? /^[a-f\d]{32}$/i.test(info.hash || '')
			: /^\d+$/.test(text(info.songmid)) &&
				(source !== 'mg' || /^\d+$/.test(text(info.copyrightId)))

// Endpoints and schemas follow lyswhut/lx-music-mobile src/utils/musicSdk/{source}/musicSearch.js.
// Keep search private to URL resolution; it does not change the app's metadata provider.
export function platformSearchRequest(
	platform: ResolutionPlatform,
	keyword: string,
): { url: string; method: string; headers?: Record<string, string>; data?: any } {
	const query = encodeURIComponent(keyword)
	if (platform === 'tx') return txSearchRequest(keyword)
	if (platform === 'wy') {
		const path = '/api/search/song/list/page'
		const body = JSON.stringify({
			keyword,
			needCorrect: '1',
			channel: 'typing',
			offset: 0,
			scene: 'normal',
			total: true,
			limit: 20,
		})
		const digest = CryptoJS.MD5(`nobody${path}use${body}md5forencrypt`).toString()
		const params = CryptoJS.AES.encrypt(
			`${path}-36cd479b6b5-${body}-36cd479b6b5-${digest}`,
			CryptoJS.enc.Utf8.parse('e82ckenh8dichen8'),
			{ mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 },
		)
			.ciphertext.toString()
			.toUpperCase()
		return {
			url: 'https://interface.music.163.com/eapi/batch',
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				origin: 'https://music.163.com',
			},
			data: `params=${params}`,
		}
	}
	if (platform === 'kg')
		return {
			url: `https://songsearch.kugou.com/song_search_v2?keyword=${query}&page=1&pagesize=20&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`,
			method: 'GET',
		}
	if (platform === 'kw')
		return {
			url: `https://search.kuwo.cn/r.s?client=kt&all=${query}&pn=0&rn=20&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`,
			method: 'GET',
		}
	const timestamp = Date.now().toString()
	const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
	const sign = CryptoJS.MD5(
		`${keyword}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${timestamp}`,
	).toString()
	return {
		url: `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=20&text=${query}&pageNo=1&sort=0&sid=USS`,
		method: 'GET',
		headers: {
			uiVersion: 'A_music_3.6.1',
			deviceId,
			timestamp,
			sign,
			channel: '0146921',
			'User-Agent':
				'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
		},
	}
}

export function decodeCandidates(platform: ResolutionPlatform, response: any): PlatformMusicInfo[] {
	let rows: any[]
	if (platform === 'tx') {
		if (response?.code !== 0 || response.req_1?.code !== 0) throw new Error('TX_SEARCH_FAILED')
		rows = response.req_1.data?.body?.song?.list
	} else if (platform === 'wy') {
		if (response?.code !== 200) throw new Error('WY_SEARCH_FAILED')
		rows = response.data?.resources?.map((row: any) => row.baseInfo?.simpleSongData)
	} else if (platform === 'kg') {
		if (response?.error_code !== 0) throw new Error('KG_SEARCH_FAILED')
		rows = response.data?.lists?.flatMap((row: any) => [row, ...(row.Grp || [])])
	} else if (platform === 'kw') {
		if (response?.TOTAL == null || (response.TOTAL !== '0' && response.SHOW === '0'))
			throw new Error('KW_SEARCH_FAILED')
		rows = response.abslist ?? (String(response.TOTAL) === '0' ? [] : undefined)
	} else {
		if (response?.code !== '000000') throw new Error('MG_SEARCH_FAILED')
		rows = response.songResultData?.resultList?.flat()
	}
	if (!Array.isArray(rows)) throw new Error(`${platform.toUpperCase()}_INVALID_SEARCH_SCHEMA`)
	return rows
		.filter(Boolean)
		.map((row): PlatformMusicInfo => {
			let info: any
			switch (platform) {
				case 'tx':
					info = {
						songmid: row.mid,
						songId: row.id,
						strMediaMid: row.file?.media_mid,
						name: row.title,
						singer: singers(row.singer),
						albumName: row.album?.name || row.album?.title,
						albumId: row.album?.mid,
						duration: Number(row.interval),
					}
					break
				case 'wy':
					info = {
						songmid: row.id,
						name: row.name,
						singer: singers(row.ar),
						albumName: row.al?.name,
						albumId: row.al?.id,
						duration: Number(row.dt) / 1000,
					}
					break
				case 'kg': {
					const _types: Record<string, { hash: string }> = Object.fromEntries(
						[
							['128k', row.FileHash],
							['320k', row.HQFileHash],
							['flac', row.SQFileHash],
							['flac24bit', row.ResFileHash],
						]
							.filter(([, hash]) => /^[a-f\d]{32}$/i.test(hash || ''))
							.map(([type, hash]) => [type, { hash }]),
					)
					info = {
						songmid: row.Audioid,
						hash: row.FileHash,
						_types,
						types: Object.entries(_types).map(([type, value]) => ({ type, hash: value.hash })),
						name: `${row.OriSongName || ''}${row.Suffix ? ` ${row.Suffix}` : ''}`,
						singer: singers(row.Singers) || row.SingerName,
						albumName: row.AlbumName,
						albumId: row.AlbumID,
						duration: Number(row.Duration),
					}
					break
				}
				case 'kw':
					info = {
						songmid: text(row.MUSICRID).replace(/^MUSIC_/, ''),
						name: row.SONGNAME,
						singer: row.ARTIST,
						albumName: row.ALBUM,
						albumId: row.ALBUMID,
						duration: Number(row.DURATION),
					}
					break
				case 'mg':
					info = {
						songmid: row.songId,
						copyrightId: row.copyrightId,
						name: row.name,
						singer: singers(row.singerList),
						albumName: row.album,
						albumId: row.albumId,
						duration: Number(row.duration),
					}
					break
			}
			return {
				...info,
				source: platform,
				id: info.songmid,
				name: decode(info.name),
				singer: decode(info.singer),
				albumName: decode(info.albumName),
				interval: `${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration % 60)).padStart(2, '0')}`,
			}
		})
		.filter((info) => validId(platform, info))
}

export function selectPlatformMatch(
	item: IMusic.IMusicItem,
	candidates: PlatformMusicInfo[],
): PlatformMusicInfo | null {
	if (!metadata(item.title) || !artists(item.artist)) return null
	const valid = candidates.filter(
		(candidate) =>
			metadata(candidate.name) === metadata(item.title) &&
			artists(candidate.singer) === artists(item.artist) &&
			(!metadata(item.album) || metadata(candidate.albumName) === metadata(item.album)) &&
			(!(Number.isFinite(item.duration) && item.duration > 0) ||
				(candidate.duration > 0 && Math.abs(candidate.duration - item.duration) <= 3)),
	)
	const unique = new Map(
		valid.map((info) => [JSON.stringify([info.songmid, info.hash, info.copyrightId]), info]),
	)
	return unique.size === 1 ? [...unique.values()][0] : null
}

const matches = new Map<string, { expires: number; info: PlatformMusicInfo | null }>()
export async function resolvePlatformMusicInfo(
	item: IMusic.IMusicItem,
	platform: ResolutionPlatform,
	signal?: AbortSignal,
	fresh = false,
): Promise<PlatformMusicInfo> {
	if (signal?.aborted) throw new Error('SOURCE_CANCELLED')
	if (platform === 'tx') {
		const info = await resolveQQInfo(item, signal, fresh)
		return {
			source: 'tx',
			id: info.mid,
			songmid: info.mid,
			name: item.title,
			singer: item.artist,
			albumName: item.album,
			duration: item.duration,
			songId: info.songId,
			strMediaMid: info.strMediaMid,
			albumId: info.albumId,
		}
	}
	const key = JSON.stringify([
		platform,
		item.platform,
		item.id,
		item.title,
		item.artist,
		item.album,
		item.duration,
	])
	const cached = matches.get(key)
	if (cached && cached.expires > Date.now() && !(fresh && !cached.info)) {
		if (!cached.info) throw new Error(`${platform}_MATCH_NOT_FOUND`)
		return cached.info
	}
	const response = await axios.request({
		...platformSearchRequest(platform, `${item.title} ${item.artist}`),
		signal,
		timeout: 8000,
	})
	if (signal?.aborted) throw new Error('SOURCE_CANCELLED')
	const info = selectPlatformMatch(item, decodeCandidates(platform, response.data))
	matches.set(key, { info, expires: Date.now() + (info ? 3600000 : 60000) })
	if (matches.size > 300) matches.delete(matches.keys().next().value!)
	if (!info) throw new Error(`${platform}_MATCH_NOT_FOUND`)
	return info
}
