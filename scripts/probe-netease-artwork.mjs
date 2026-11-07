// Public exact-song-ID probe. HEAD verifies the candidate, never writes application stores.
import CryptoJS from 'crypto-js'
import { assert, loadModule } from './native-services-fixture.mjs'

const remote = loadModule('src/helpers/userApi/remotePlaylist.ts', {
	'expo/fetch': { fetch }, 'crypto-js': CryptoJS,
}, { URL })
for (const id of process.argv.length > 2 ? process.argv.slice(2) : ['347230', '186016']) {
	assert.match(id, /^[1-9]\d*$/)
	const data = await remote.requestJson(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(`[${id}]`)}`)
	const song = data.songs?.find(item => String(item.id) === id)
	assert.ok(song, `No exact song ${id}`)
	const normalized = remote.normalizeNeteaseSong(song)
	assert.ok(normalized.artwork)
	const response = await fetch(normalized.artwork, { method: 'HEAD', signal: AbortSignal.timeout(15000) })
	const type = response.headers.get('content-type')
	console.log(JSON.stringify({ id, artwork: normalized.artwork, status: response.status, contentType: type }))
	assert.equal(response.status, 200)
	assert.match(type ?? '', /^image\//i)
}
