// Run: node scripts/check-source-lyric.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createSourceFixture, deferred, flush } from './source-runtime-fixture.mjs'

const checks = []
const test = async (name, run) => {
	try { await run(); checks.push({ name, passed: true }) }
	catch (error) { checks.push({ name, passed: false, error: error.stack }) }
}
const commonjs = `module.exports = {
	id: 'lyrics', name: 'Lyrics',
	sources: { tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
	getMusicUrl: async () => 'https://example.test/audio',
	getLyric: async (title, artist, id) => ({ rawLrc: title + artist + id, translation: 'translated' })
}`

await test('CommonJS import preserves optional lyrics and declared channels', async () => {
	const f = createSourceFixture()
	const api = await f.load('src/helpers/userApi/importMusicSource').createMusicApiFromScript(commonjs)
	assert.equal(typeof api.getLyric, 'function')
	assert.deepEqual(await api.getLyric('T', 'A', 'id'), { rawLrc: 'TAid', translation: 'translated' })
	assert.deepEqual(api.sources.tx.actions, ['musicUrl'])
})

await test('CommonJS resolver reconstruction preserves lyrics and capabilities after persistence', async () => {
	const f = createSourceFixture()
	const runtime = f.load('src/player/sourceResolver/runtime')
	const api = await runtime.loadResolverSource({ id: 'lyrics', script: commonjs })
	assert.equal(typeof api.getLyric, 'function')
	assert.deepEqual(api.sources.tx.qualitys, ['128k'])
	const reloaded = await runtime.loadResolverSource({ ...api,
		script: `module.exports.getMusicUrl = async () => 'https://example.test/new'`,
	}, true)
	assert.equal(reloaded.getLyric, undefined, 'Reload must clear removed optional methods')
	assert.equal(reloaded.sources, undefined, 'Reload must clear removed declarations')
})

await test('LX publicly initialized sources survive adaptation and reload', async () => {
	const f = createSourceFixture()
	const sources = { tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
		wy: { type: 'music', actions: [], qualitys: [] } }
	const ready = f.adapter.adaptLxMusicScript('/** @name fixture */\nlx.on(lx.EVENT_NAMES.request, () => {})')
	f.native.init(undefined, { info: { sources } })
	const api = await ready
	assert.deepEqual(api.sources, sources)
	const reloading = f.adapter.reloadLxMusicScript(api)
	f.native.init(undefined, { info: { sources: { kg: sources.tx } } })
	const reloaded = await reloading
	assert.deepEqual(reloaded.sources, { kg: sources.tx })
	assert.equal(reloaded.getLyric, undefined, 'No TX lyric action was publicly accepted')
	f.facade.destroy()
})

await test('real SDK initialization filters online lyric declarations before the adapter sees them', async () => {
	const events = []
	const context = vm.createContext({ __lx_native_call__: (key, action, data) => {
		events.push({ action, data: JSON.parse(data) })
	} })
	vm.runInContext(readFileSync(new URL('../ios/CyMusic/user-api-preload.js', import.meta.url), 'utf8'), context)
	vm.runInContext(`lx_setup('key', 'id', 'fixture', '', '', '', '', '');
		lx.send(lx.EVENT_NAMES.inited, { sources: {
			tx: { type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k'] },
			local: { type: 'music', actions: ['lyric'], qualitys: [] }
		} });`, context)
	const data = events.find(event => event.action === 'init').data
	assert.deepEqual(data.info.sources.tx.actions, ['musicUrl'])
	assert.deepEqual(data.info.sources.local.actions, ['lyric'])
	const f = createSourceFixture()
	const ready = f.adapter.adaptLxMusicScript('/** @name fixture */\nlx.on(lx.EVENT_NAMES.request, () => {})')
	f.native.init(undefined, data)
	const api = await ready
	assert.equal(api.getLyric, undefined)
	assert.equal(f.native.sent.length, 0)
	f.facade.destroy()
})

await test('LX lyric event is exposed only for publicly accepted TX lyric capability', async () => {
	const f = createSourceFixture()
	const ready = f.adapter.adaptLxMusicScript('/** @name fixture */\nlx.on(lx.EVENT_NAMES.request, () => {})')
	f.native.init(undefined, { info: { sources: {
		tx: { type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k'] },
	} } })
	const api = await ready
	const response = api.getLyric('Title', 'Artist', 'mid')
	const sent = f.native.sent.at(-1).data
	assert.equal(sent.data.action, 'lyric')
	assert.equal(sent.data.source, 'tx')
	assert.equal(sent.data.info.musicInfo.songmid, 'mid')
	assert.equal('type' in sent.data.info, false)
	f.native.emit('response', { requestKey: sent.requestKey, status: true,
		result: { action: 'lyric', data: { lyric: 'original', tlyric: 'translated' } } })
	assert.deepEqual(await response, { lyric: 'original', tlyric: 'translated' })
	const wrongAction = api.getLyric('Title', 'Artist', 'mid')
	f.native.emit('response', { requestKey: f.native.sent.at(-1).data.requestKey, status: true,
		result: { action: 'musicUrl', data: { url: 'https://example.test/not-lyrics' } } })
	await assert.rejects(wrongAction, /unexpected response action/)
	f.facade.destroy()
	await assert.rejects(api.getLyric('', '', 'mid'), /已销毁/)
})

function lyricFixture() {
	let selected = null
	const imports = { '@/player/PlayerStore': { musicApiSelectedStore: { getValue: () => selected } } }
	const f = createSourceFixture({ imports })
	const runtime = f.load('src/player/sourceResolver/runtime')
	let reloads = 0
	imports['@/player/sourceResolver/runtime'] = { ...runtime, loadResolverSource: async (api, reload) => {
		assert.equal(reload, true)
		reloads++
		return api
	} }
	return { ...f, runtime, helper: f.load('src/helpers/sourceLyric'),
		select: api => { selected = api }, reloads: () => reloads }
}

await test('normalize lyrics without inventing translations or accepting invalid fields', async () => {
	const { helper: { normalizeSourceLyric: normalize } } = lyricFixture()
	assert.deepEqual(normalize({ rawLrc: 'original', translation: 'translated' }),
		{ lyric: 'original', tlyric: 'translated' })
	assert.deepEqual(normalize({ lyric: 'preferred', rawLrc: 'other', tlyric: 'preferred translation', translation: 'other' }),
		{ lyric: 'preferred', tlyric: 'preferred translation' })
	assert.deepEqual(normalize('original'), { lyric: 'original', tlyric: '' })
	assert.deepEqual(normalize({ lyric: '', rawLrc: 'original', translation: {} }), { lyric: 'original', tlyric: '' })
	assert.deepEqual(normalize({ translation: 'translation only' }), { lyric: '', tlyric: 'translation only' })
	for (const invalid of [null, {}, '', '  ', { lyric: 42 }])
		assert.equal(normalize(invalid), null)
})

const item = { title: 'Title', artist: 'Artist', songmid: 'mid' }
await test('lyric helper executes the current persisted CommonJS script through the real loader', async () => {
	const selected = { id: 'lyrics', script: commonjs,
		getMusicUrl: async () => 'https://example.test/stored',
		getLyric: async () => ({ lyric: 'stale closure' }) }
	const f = createSourceFixture({ imports: { '@/player/PlayerStore': {
		musicApiSelectedStore: { getValue: () => selected },
	} } })
	const helper = f.load('src/helpers/sourceLyric')
	assert.deepEqual(await helper.fetchSourceLyric(item, () => true),
		{ lyric: 'TitleArtistmid', tlyric: 'translated' })
})

await test('source lyrics use the current source under the playback lock; failure requests platform fallback', async () => {
	const f = lyricFixture()
	const held = deferred()
	const holding = f.runtime.withSourceRuntimeLock(() => held.promise)
	let calls = 0
	f.select({ id: 'source', getLyric: async (...args) => {
		assert.deepEqual(args, ['Title', 'Artist', 'mid'])
		calls++
		return { rawLrc: 'original', translation: 'translated' }
	} })
	const lyrics = f.helper.fetchSourceLyric(item, () => true)
	await flush()
	assert.equal(calls, 0)
	held.resolve()
	await holding
	assert.deepEqual(await lyrics, { lyric: 'original', tlyric: 'translated' })
	assert.equal(f.reloads(), 1)
	for (const getLyric of [undefined, async () => null, async () => { throw new Error('failure') }]) {
		f.select({ id: 'source', getLyric })
		assert.equal(await f.helper.fetchSourceLyric(item, () => true), null)
	}
	assert.equal(await f.helper.fetchSourceLyric(item, () => false), null)
	assert.equal(await f.helper.fetchSourceLyric({ ...item, songmid: '' }, () => true), null)
})

await test('queued lyrics reject stale request tokens and changed source before calling plugins', async () => {
	for (const change of ['token', 'source']) {
		const f = lyricFixture(), held = deferred()
		let current = true, calls = 0
		f.select({ id: 'source', getLyric: async () => { calls++; return 'original' } })
		const holding = f.runtime.withSourceRuntimeLock(() => held.promise)
		const result = f.helper.fetchSourceLyric(item, () => current)
		if (change === 'token') current = false
		else f.select({ id: 'replacement' })
		held.resolve()
		await holding
		assert.equal(await result, null)
		assert.equal(calls, 0)
	}
})

await test('in-flight lyrics discard old source/token results and retain lock after timeout', async () => {
	for (const change of ['token', 'source', 'timeout']) {
		const f = lyricFixture(), work = deferred()
		let current = true, called = false, nextRan = false
		f.select({ id: 'source', getLyric: () => { called = true; return work.promise } })
		const result = f.helper.fetchSourceLyric(item, () => current, 100)
		await flush()
		assert.equal(called, true)
		const queued = f.runtime.withSourceRuntimeLock(async () => { nextRan = true })
		if (change === 'token') current = false
		else if (change === 'source') f.select({ id: 'replacement' })
		else {
			f.clock.advance(100)
			assert.equal(await result, null)
			assert.equal(nextRan, false, 'Timeout must not release the source runtime')
		}
		work.resolve({ lyric: 'late', tlyric: 'late translation' })
		assert.equal(await result, null)
		await queued
		assert.equal(nextRan, true)
		assert.equal(f.clock.timers.size, 0)
	}
})

console.log(JSON.stringify({ suite: 'source-lyric', checks }, null, 2))
if (checks.some(check => !check.passed)) process.exitCode = 1
