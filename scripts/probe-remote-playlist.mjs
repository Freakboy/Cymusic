// Runs the production helper with real, unauthenticated requests. Never logs headers or song data.
import { loadModule } from './native-services-fixture.mjs'
import CryptoJS from 'crypto-js'

const remote = loadModule('src/helpers/userApi/remotePlaylist.ts', { 'expo/fetch': {
	async fetch(url, options) {
		try {
			const response = await fetch(url, options)
			const info = { host: new URL(url).host, path: new URL(url).pathname, status: response.status }
			const location = response.headers.get('location')
			if (location) {
				const target = new URL(location, url)
				info.redirect = { host: target.host, path: target.pathname }
			}
			if (response.ok && ![301, 302, 303, 307, 308].includes(response.status)) {
				try {
					const data = await response.clone().json()
					const list = data.playlist ?? data.result ?? (data.data?.cdlist ?? data.cdlist)?.[0]
					Object.assign(info, { code: data.code, keys: Object.keys(data), playlistKeys: list && Object.keys(list),
						trackCount: list?.trackCount, total_song_num: list?.total_song_num, songnum: list?.songnum,
						song_begin: list?.song_begin, cur_song_num: list?.cur_song_num, tracks: (list?.tracks ?? list?.songlist)?.length,
						trackIds: list?.trackIds?.length, songs: data.songs?.length,
						inventoryCount: typeof list?.songids === 'string' ? list.songids.split(',').filter(Boolean).length : undefined,
						uniqueDetails: list?.songlist && new Set(list.songlist.map(raw => (raw.musicData ?? raw).mid ?? (raw.musicData ?? raw).songmid)).size })
				} catch { info.body = 'non-JSON' }
			}
			console.log(JSON.stringify(info))
			return response
		} catch (error) {
			console.log(JSON.stringify({ host: new URL(url).host, error: error.name, cause: error.cause?.code }))
			throw error
		}
	},
}, 'crypto-js': CryptoJS }, { URL })
const inputs = process.argv.slice(2)
for (const input of inputs.length ? inputs : [
	'https://y.qq.com/n/ryqq/playlist/9791950324',
	'https://music.163.com/playlist?id=3778678',
	'分享歌单 https://i.y.qq.com/n2/m/share/details/taoge.html?id=7364061065',
	'分享歌单 https://music.163.com/#/playlist?id=3778678',
	'分享歌单 https://163cn.tv/zoIxm3',
]) {
	const parsed = remote.parseRemotePlaylistReference(input)
	const sample = { platform: parsed?.platform, remoteId: parsed?.remoteId }
	try {
		const result = await remote.fetchRemotePlaylistFromInput(input)
		console.log(JSON.stringify({ sample, success: true, id: result.id, songs: result.songs.length,
			uniqueSongs: new Set(result.songs.map(song => song.id)).size, qqCompleteness: result.qqCompleteness }))
	} catch (error) {
		console.log(JSON.stringify({ sample, success: false, error: error.message.replace(/https?:\/\/[^\s]+/g, '[URL omitted]') }))
		process.exitCode = 1
	}
}
