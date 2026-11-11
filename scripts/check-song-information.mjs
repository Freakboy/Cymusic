import { createFixture, item, write, uri } from './file-system-fixture.mjs'
import { assert, checks, deferred, loadModule } from './native-services-fixture.mjs'
import { readFileSync } from 'node:fs'
const fixture = createFixture(), suite = checks()
await suite.check('read-only metadata uses hash-matched script and actual tier; no URLs or headers escape', () => {
	const h = fixture.runtime(), helper = h.load('src/helpers/songInformation.ts'), identity = h.load('src/player/sourceIdentity.ts')
	const api = { id: 'a', name: 'Original script', script: 'original', version: '1' }
	const track = item('a', 'https://secret.test/audio.flac?token=secret', { platform: 'wy', cacheSourceId: identity.sourceId(api, 'tx'), cacheQuality: '128k', headers: { Authorization: 'secret' } })
	const info = helper.songInformation(track, [api])
	assert.equal(info.quality, '128k'); assert.equal(info.sourcePlatform, 'tx'); assert.equal(info.originalPlatform, 'wy')
	assert.equal(info.script, api.name); assert.equal(info.format, 'FLAC'); assert.equal(info.location, 'remote')
	assert(!JSON.stringify(info).includes('secret'))
	assert.equal(helper.songInformation(track, [{ ...api, script: 'replaced', name: 'Wrong' }]).script, undefined)
	assert.equal(helper.songInformation(item('unplayed'), [api]).quality, undefined)
	const route = helper.songInformationRoute(item('a', undefined, { platform: 'wy' }), track)
	assert.deepEqual(Object.keys(route.params), ['token']); assert(!JSON.stringify(route).includes('secret'))
	assert.equal(helper.getSongInformationTrack(route.params.token).url, track.url)
	assert.equal(h.calls.player.length, 0)
})
await suite.check('only valid resolver provenance confirms tier/platform, even when its API was deleted', () => {
	const h = fixture.runtime(), helper = h.load('src/helpers/songInformation.ts')
	const hash = 'a'.repeat(64)
	for (const identity of [
		'direct', 'junk', '',
		JSON.stringify(['id', '', 'junk', 'tx']),
		JSON.stringify(['id', '', hash, 'unsupported']),
		JSON.stringify([42, '', hash, 'tx']),
		JSON.stringify(['id', 42, hash, 'tx']),
		JSON.stringify(['id', '', hash, 'tx', 'extra']),
		JSON.stringify(['id', '', 'g'.repeat(64), 'tx']),
	]) {
		const info = helper.songInformation(item('a', 'file:///cache/a.mp3', { cacheSourceId: identity, cacheQuality: '320k' }), [])
		assert.equal(info.quality, undefined, identity)
		assert.equal(info.sourcePlatform, undefined, identity)
		assert.equal(info.script, undefined, identity)
	}
	for (const platform of ['tx', 'wy', 'kg', 'kw', 'mg']) {
		const info = helper.songInformation(item('a', 'file:///cache/a.mp3', { cacheSourceId: JSON.stringify(['deleted', '', hash, platform]), cacheQuality: '128k' }), [])
		assert.equal(info.quality, '128k'); assert.equal(info.sourcePlatform, platform)
		assert.equal(info.script, undefined); assert.equal(info.location, 'cache')
	}
})
await suite.check('real local filesystem size and remote unknown without player commands', async () => {
	const h = fixture.runtime(), helper = h.load('src/helpers/songInformation.ts')
	const path = `${fixture.documents}/info.mp3`
	await write(path, '123456789')
	assert.equal(await helper.songInformationSize(item('local', uri(path)), () => true), 9)
	assert.equal(await helper.songInformationSize(item('remote', 'https://audio.test/a.mp3'), () => true), undefined)
	assert.equal(h.calls.player.length, 0)
})
await suite.check('identity change during local stat discards late size', async () => {
	const gate = deferred(); let current = true, reads = 0
	const helper = loadModule('src/helpers/songInformation.ts', {
		'@/player/sourceIdentity': { sourceId: () => '' },
		'@/helpers/localFile': { resolveLocalFile: async () => ({ status: 'resolved', fileUri: 'file:///a.mp3' }) },
		'expo-file-system/legacy': { getInfoAsync: async () => { reads++; return gate.promise } },
	})
	const result = helper.songInformationSize(item('a', 'file:///a.mp3'), () => current)
	await new Promise(setImmediate); current = false; gate.resolve({ exists: true, isDirectory: false, size: 100 })
	assert.equal(await result, undefined); assert.equal(reads, 1)
})
await suite.check('both UI entries route to modal; modal contains no playback or remote requests', () => {
	for (const path of ['src/components/TrackShortcutsMenu.tsx', 'src/app/player.tsx']) {
		const code = readFileSync(path, 'utf8'); assert(code.includes("'song-information'")); assert(code.includes('router.push(songInformationRoute('))
	}
	const code = readFileSync('src/app/(modals)/songInformation.tsx', 'utf8')
	assert(!/fetch\(|resolveSource\(|\.play\(|download|HEAD/.test(code))
	assert(code.includes('groups.map')); assert(code.includes('text.unknown'))
})
await fixture.dispose(); suite.finish()
