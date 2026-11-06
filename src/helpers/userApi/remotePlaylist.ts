import { fetch } from 'expo/fetch'
import CryptoJS from 'crypto-js'

export type RemotePlaylistPlatform = 'QQ' | 'Netease'

export type RemotePlaylistReference = {
	platform: RemotePlaylistPlatform
	remoteId: string
	sourceUrl: string
}

export type RemotePlaylistResult = IMusic.PlayList & {
	success: true
	remoteBinding: NonNullable<IMusic.PlayList['remoteBinding']>
	qqCompleteness?: { total: number; available: number; unavailableSongIds: string[] }
}

export function remotePlaylistId(reference: Pick<RemotePlaylistReference, 'platform' | 'remoteId'>) {
	return `remote:${reference.platform}:${reference.remoteId}`
}

export function parseRemotePlaylistReference(input: string, preferredPlatform?: RemotePlaylistPlatform) {
	const value = input.trim()
	if (/^\d+$/.test(value)) {
		return preferredPlatform ? { platform: preferredPlatform, remoteId: value, sourceUrl: value } : null
	}
	const link = playlistLink(value)
	if (!link || (preferredPlatform && link.platform !== preferredPlatform)) return null
	const { url, platform } = link
	// The import screen uses this synchronous parser as its input gate.
	if (link.short) return { platform, sourceUrl: url.href, remoteId: undefined }
	const path = url.hash.startsWith('#/') ? url.hash.slice(1) : `${url.pathname}${url.search}`
	const page = new URL(path, url.origin)
	const nonPlaylist = /\/(?:song|songdetail|album|albumdetail|singer|artist)(?:\/|\.|$)/i.test(page.pathname)
	const remoteId = page.pathname.match(/^\/(?:n\/(?:ryqq|yqq)\/)?playlist\/(\d+)(?:\.html)?\/?$/i)?.[1]
		?? (platform === 'QQ' ? page.pathname.match(/^\/n\/(?:ryqq|yqq)\/playsquare\/(\d+)(?:\.html)?\/?$/i)?.[1] : null)
		?? (platform === 'QQ' ? page.searchParams.get('disstid') : null)
		// Shipped QQ imports accepted an id parameter without depending on the share-page path.
		?? (platform === 'QQ' && !nonPlaylist ? page.searchParams.get('id') : null)
		?? (/^\/(?:m\/)?playlist\/?$/i.test(page.pathname)
			|| (platform === 'QQ' && /\/share\/details\/taoge\.html$/i.test(page.pathname)) ? page.searchParams.get('id') : null)
	if (!remoteId || !/^\d+$/.test(remoteId)) return null
	return { platform, remoteId, sourceUrl: url.href } satisfies RemotePlaylistReference
}

function playlistLink(input: string) {
	const value = input.match(/https?:\/\/[^\s<>"'`，。；！？（）【】《》“”‘’「」『』]+/i)?.[0].replace(/[)\].,;!]+$/, '')
	if (!value) return null
	try {
		const url = new URL(value.replace(/&amp;/g, '&'))
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
		url.protocol = 'https:'
		const host = url.hostname.toLowerCase()
		const platform: RemotePlaylistPlatform | undefined = host === 'music.163.com' || host.endsWith('.music.163.com') || host === '163cn.tv' ? 'Netease'
			: host === 'y.qq.com' || host.endsWith('.y.qq.com') ? 'QQ' : undefined
		const short = host === '163cn.tv' ? /^\/[a-z0-9]+\/?$/i.test(url.pathname)
			: platform === 'QQ' && url.pathname === '/base/fcgi-bin/u' && !!url.searchParams.get('__')
		return platform ? { url, platform, short } : null
	} catch {
		return null
	}
}

async function resolvePlaylistReference(input: string, preferredPlatform?: RemotePlaylistPlatform) {
	const direct = parseRemotePlaylistReference(input, preferredPlatform)
	if (direct?.remoteId) return { ...direct, remoteId: direct.remoteId }
	const link = playlistLink(input)
	if (!link?.short || (preferredPlatform && link.platform !== preferredPlatform)) {
		throw new Error('无法识别歌单链接，或链接与所选平台不符')
	}
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 20000)
	const sourceUrl = link.url.href
	let url = link.url
	try {
		// One deadline for the whole chain; validate every Location before requesting it.
		for (let redirects = 0; redirects <= 5; redirects++) {
			const response = await fetch(url.href, { redirect: 'manual', credentials: 'omit', signal: controller.signal })
			if (response.redirected) throw new Error('短链请求未能禁用自动跳转')
			if (![301, 302, 303, 307, 308].includes(response.status)) {
				throw new Error(`短链未返回歌单跳转 (HTTP ${response.status})`)
			}
			const location = response.headers.get('location')
			if (!location) throw new Error('短链跳转地址缺失')
			const next = playlistLink(new URL(location, url).href)
			if (!next || next.platform !== link.platform) throw new Error('短链只能跳转到同平台官方域名')
			if (redirects === 5) throw new Error('短链跳转超过 5 次')
			const reference = parseRemotePlaylistReference(next.url.href, link.platform)
			if (reference?.remoteId) return { ...reference, remoteId: reference.remoteId, sourceUrl }
			if (!next.short) {
				throw new Error('短链目标不是歌单链接')
			}
			url = next.url
		}
		throw new Error('无法解析歌单短链')
	} finally {
		clearTimeout(timer)
	}
}

async function requestJson(url: string, headers?: Record<string, string>) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 20000)
	try {
		const response = await fetch(url, { signal: controller.signal, headers, credentials: 'omit', redirect: 'error' })
		if (!response.ok) throw new Error(`歌单请求失败 (HTTP ${response.status})`)
		// Image IDs exceed JS integer precision. Match whole JSON strings so escaped
		// field names inside descriptions are never rewritten as object keys.
		const text = await response.text()
		const data = JSON.parse(text.replace(/("(?:\\.|[^"\\])*")(\s*:\s*)(\d+)(?=\s*[,}])|"(?:\\.|[^"\\])*"/g,
			(token, key, separator, id) => /^"(?:coverImgId|picId|pic)"$/.test(key) ? `${key}${separator}"${id}"` : token))
		if (data.code != null && data.code !== 0 && data.code !== 200) {
			throw new Error(`歌单接口错误 (${data.code})`)
		}
		return data
	} finally {
		clearTimeout(timer)
	}
}

function count(value: unknown): number {
	if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value)))
		|| !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
		throw new Error('缺少有效的歌单总数，未更新本地数据')
	}
	return Number(value)
}

function remoteArtwork(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value !== 'string' || !value.trim()) continue
		try {
			const url = new URL(value.trim().replace(/^\/\//, 'https://'))
			if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue
			url.protocol = 'https:'
			return url.href
		} catch { /* Try the next cover source. */ }
	}
	return ''
}

function neteaseImage(...ids: unknown[]): string {
	const id = ids.find(value => (typeof value === 'string' && /^[0-9]+$/.test(value) && /[1-9]/.test(value))
		|| (typeof value === 'number' && Number.isSafeInteger(value) && value > 0))
	if (id == null) return ''
	// https://github.com/nondanee/UnblockNeteaseMusic/blob/master/src/browser/crypto.js
	const key = '3go8&$8*3*3h0k(2)2'
	const input = String(id)
	const bytes = Array.from(input, (digit, index) => String.fromCharCode(digit.charCodeAt(0) ^ key.charCodeAt(index % key.length))).join('')
	const encrypted = CryptoJS.MD5(bytes).toString(CryptoJS.enc.Base64).replace(/\//g, '_').replace(/\+/g, '-')
	return `https://p1.music.126.net/${encrypted}/${input}.jpg`
}

export function normalizeNeteaseSong(song: any): IMusic.IMusicItem {
	const artists = song.ar ?? song.artists
	const album = song.al ?? song.album
	return {
		id: String(song.id), platform: 'Netease', title: song.name || '未知歌曲',
		artist: Array.isArray(artists) ? artists.map((item: any) => item.name).filter(Boolean).join('、') : '未知歌手',
		album: album?.name || '未知专辑', artwork: remoteArtwork(album?.picUrl, song.album?.picUrl)
			|| neteaseImage(album?.pic_str, album?.picId_str, album?.picId, album?.pic,
				song.album?.pic_str, song.album?.picId_str, song.album?.picId, song.album?.pic),
		duration: Math.round((song.dt ?? song.duration ?? 0) / 1000), url: 'Unknown',
	}
}

async function fetchNeteasePlaylist(reference: RemotePlaylistReference) {
	const data = await requestJson(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(reference.remoteId)}&n=100000&s=0`)
	const playlist = data?.playlist ?? data?.result
	if (!playlist) throw new Error('网易云歌单不存在或不可访问')
	// Use the ordered ID inventory, not tracks.length; an explicit count still detects server caps.
	const total = count(playlist.trackCount === undefined && Array.isArray(playlist.trackIds) ? playlist.trackIds.length : playlist.trackCount)
	if (!Array.isArray(playlist.tracks) && !Array.isArray(playlist.trackIds)) throw new Error('网易云歌曲列表缺失')
	const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : []
	let ordered = tracks
	if (Array.isArray(playlist.trackIds)) {
		const ids = playlist.trackIds.map((item: any) => String(item?.id ?? ''))
		if (ids.length !== total || ids.some((id: string) => !/^\d+$/.test(id)) || new Set(ids).size !== total) {
			throw new Error('网易云歌曲 ID 列表不完整，未更新本地数据')
		}
		const byId = new Map<string, any>(tracks.filter((song: any) => song?.id != null).map((song: any) => [String(song.id), song]))
		const missing = ids.filter((id: string) => !byId.has(id))
		for (let offset = 0; offset < missing.length; offset += 200) {
			const batch = missing.slice(offset, offset + 200)
			const detail = await requestJson(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(JSON.stringify(batch.map(Number)))}`)
			if (!Array.isArray(detail?.songs)) throw new Error('网易云歌曲详情缺失')
			for (const song of detail.songs) if (song?.id != null) byId.set(String(song.id), song)
			if (batch.some((id: string) => !byId.has(id))) throw new Error('网易云歌曲详情不完整，未更新本地数据')
		}
		ordered = ids.map((id: string) => byId.get(id))
	}
	if (ordered.length !== total || ordered.some((song: any) => !song?.id || !song.name)
		|| new Set(ordered.map((song: any) => String(song.id))).size !== total) {
		throw new Error('网易云歌曲列表不完整，未更新本地数据')
	}
	const songs = ordered.map(normalizeNeteaseSong)
	return {
		artist: playlist.creator?.nickname || '网易云音乐', name: playlist.name || '未命名歌单',
		artwork: remoteArtwork(playlist.coverImgUrl, playlist.coverImg?.url, playlist.picUrl)
			|| neteaseImage(playlist.coverImgId_str, playlist.coverImgId) || remoteArtwork(songs[0]?.artwork),
		description: playlist.description || '', songs,
	}
}

async function fetchQQPlaylist(reference: RemotePlaylistReference) {
	const songs: IMusic.IMusicItem[] = []
	const seen = new Set<string>()
	let metadata: any
	let total: number
	let offset = 0
	let inventory: string[] | undefined
	let legacy = false
	const unavailableSongIds: string[] = []
	do {
		const headers = {
			Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com',
		}
		const requestPage = () => requestJson(`https://c.y.qq.com/${legacy
			? `v8/fcg-bin/fcg_v8_playlist_cp.fcg?newsong=1&id=${encodeURIComponent(reference.remoteId)}&inCharset=GB2312&outCharset=utf-8`
			: `qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${encodeURIComponent(reference.remoteId)}`}&format=json&song_begin=${offset}&song_num=100`, headers)
		let data
		try {
			data = await requestPage()
		} catch (error) {
			if (offset !== 0 || legacy || !(error instanceof Error) || !/^歌单接口错误 \(/.test(error.message)) throw error
			legacy = true
			data = await requestPage()
		}
		const page = (data?.data?.cdlist ?? data?.cdlist)?.[0]
		if (!page || !Array.isArray(page.songlist)) throw new Error('QQ 歌单分页缺失')
		const pageTotal = count(page.total_song_num ?? page.songnum)
		if (metadata && total !== pageTotal) throw new Error('QQ 歌单在分页期间发生变化，请重试')
		if (page.disstid != null && String(page.disstid) !== reference.remoteId) throw new Error('QQ 歌单 ID 不一致')
		if (page.songnum != null && count(page.songnum) !== pageTotal) throw new Error('QQ 歌单总数不一致')
		if (page.songids != null) {
			const ids = typeof page.songids === 'string' && page.songids === '' ? [] : String(page.songids).split(',')
			if (ids.length !== pageTotal || ids.some(id => !/^\d+$/.test(id)) || new Set(ids).size !== pageTotal) {
				throw new Error('QQ 歌曲 ID 列表不完整，未更新本地数据')
			}
			if (metadata && ids.join(',') !== inventory?.join(',')) throw new Error('QQ 歌单在分页期间发生变化，请重试')
			inventory = ids
		} else if (inventory) throw new Error('QQ 歌曲 ID 列表缺失')
		const consumed = page.cur_song_num == null ? page.songlist.length : count(page.cur_song_num)
		if ((page.song_begin != null && count(page.song_begin) !== offset)
			|| consumed > 100 || offset + consumed > pageTotal || page.songlist.length > consumed
			|| (!inventory && consumed !== page.songlist.length)) {
			throw new Error('QQ 歌单分页位置或数量不一致，未更新本地数据')
		}
		metadata = metadata ?? page
		total = pageTotal
		if (!consumed && offset < total) throw new Error('QQ 歌单分页不完整')
		let ordered = page.songlist
		if (inventory) {
			// cur_song_num counts playlist slots, including IDs whose details QQ omits.
			const ids = inventory.slice(offset, offset + consumed)
			const byId = new Map<string, any>()
			for (const raw of page.songlist) {
				const item = raw.musicData ?? raw
				const id = String(item.id ?? item.songid ?? '')
				if (!ids.includes(id) || byId.has(id) || !(item.mid ?? item.songmid) || !(item.title ?? item.songname)) {
					throw new Error('QQ 歌曲详情 ID 或内容不一致')
				}
				byId.set(id, raw)
			}
			ordered = ids.map(id => byId.get(id) ?? { unavailableId: id })
		}
		for (const raw of ordered) {
			if (raw.unavailableId) {
				unavailableSongIds.push(raw.unavailableId)
				songs.push({ id: `unavailable:${raw.unavailableId}`, platform: 'QQ', title: `不可用歌曲 (QQ ID: ${raw.unavailableId})`,
					artist: '详情不可用', album: '', artwork: '', duration: 0, url: 'Unknown' })
				continue
			}
			const item = raw.musicData ?? raw
			const id = item.mid ?? item.songmid
			if (!id || seen.has(String(id))) throw new Error('QQ 歌单分页重复或歌曲 ID 缺失')
			seen.add(String(id))
			const albumMid = item.album?.mid ?? item.albummid
			songs.push({
				id: String(id), songmid: String(id), platform: 'QQ', title: item.title ?? item.songname ?? '未知歌曲',
				songId: item.id ?? item.songid,
				strMediaMid: item.file?.media_mid,
				artist: (item.singer ?? []).map((singer: any) => singer.name).filter(Boolean).join('、') || '未知歌手',
				album: item.album?.name ?? item.albumname ?? '未知专辑', albummid: albumMid,
				artwork: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : '',
				duration: item.interval ?? 0, url: 'Unknown',
			})
		}
		if (songs.length > total) throw new Error('QQ 歌单总数不一致')
		offset += consumed
	} while (offset < total)
	return {
		artist: metadata.nickname || 'QQ音乐', name: metadata.dissname || '未命名歌单',
		artwork: (metadata.logo || '').replace(/^http:/, 'https:'), description: metadata.desc || '', songs,
		qqCompleteness: { total, available: songs.length - unavailableSongIds.length, unavailableSongIds },
	}
}

export async function fetchRemotePlaylist(reference: RemotePlaylistReference): Promise<RemotePlaylistResult> {
	const result = reference.platform === 'Netease' ? await fetchNeteasePlaylist(reference) : await fetchQQPlaylist(reference)
	return {
		...result, coverImg: result.artwork, success: true, id: remotePlaylistId(reference), platform: reference.platform, title: result.name,
		remoteBinding: { ...reference, lastImportedAt: Date.now(), remoteSongKeys: result.songs.map(songKey) },
	}
}

export async function fetchRemotePlaylistFromInput(input: string, preferredPlatform?: RemotePlaylistPlatform) {
	const reference = await resolvePlaylistReference(input, preferredPlatform)
	return fetchRemotePlaylist(reference)
}

export function getPlaylistReference(playlist: IMusic.PlayList): RemotePlaylistReference | undefined {
	if (playlist.remoteBinding) return playlist.remoteBinding
	// Shipped QQ imports used the remote numeric ID directly, without a binding.
	if (playlist.platform === 'QQ' && /^\d+$/.test(playlist.id)) {
		return { platform: 'QQ', remoteId: playlist.id, sourceUrl: `https://y.qq.com/n/ryqq/playlist/${playlist.id}` }
	}
}

export function findBoundPlaylist(playlists: IMusic.PlayList[], reference: RemotePlaylistReference) {
	return playlists.find((playlist) => {
		const binding = getPlaylistReference(playlist)
		return binding?.platform === reference.platform && binding.remoteId === reference.remoteId
	})
}

export function songKey(song: IMusic.IMusicItem) {
	return `${song.platform}:${song.id}`
}

export function mergeRemotePlaylist(existing: IMusic.PlayList, latest: RemotePlaylistResult, merge = false): IMusic.PlayList {
	const artwork = remoteArtwork(latest.artwork, latest.coverImg, latest.songs[0]?.artwork)
		|| existing.coverImg || existing.artwork || ''
	const remoteKeys = new Set(latest.songs.map(songKey))
	const previousKeys = existing.remoteBinding?.remoteSongKeys
	// Without a QQ snapshot, missing old songs may be manual additions. Retain them once;
	// songs still present remotely stay unmarked so the new snapshot can track later deletions.
	const preserveUnknown = previousKeys == null && getPlaylistReference(existing)?.platform === 'QQ'
	const localKeys = new Set(existing.songs.filter((song) => song.localAdded).map(songKey))
	const retained = existing.songs.filter((song) => merge || song.localAdded || preserveUnknown
		|| (previousKeys && !previousKeys.includes(songKey(song))))
	return {
		...existing, ...latest, id: latest.id,
		name: existing.customName ? existing.name : latest.name,
		title: existing.customName ? existing.title : latest.title,
		artwork, coverImg: artwork,
		customName: existing.customName, customCover: undefined,
		songs: [...latest.songs.map((song) => localKeys.has(songKey(song)) ? { ...song, localAdded: true } : song),
			...retained.filter((song) => !remoteKeys.has(songKey(song))).map((song) => ({ ...song, localAdded: true }))],
	}
}
