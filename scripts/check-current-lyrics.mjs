// Runs the real fetchCurrentLyrics through the player facade and real source helper.
import { createFixture, item } from './file-system-fixture.mjs'
import { assert, checks, deferred } from './native-services-fixture.mjs'

const fixture = createFixture(),
	suite = checks()
const flush = () => new Promise((resolve) => setImmediate(resolve))
const song = (id = '00000000000001', extra = {}) =>
	item(id, 'https://example.test/audio', {
		platform: 'tx',
		songmid: id,
		title: 'Song',
		artist: 'Artist',
		...extra,
	})
function runtime() {
	const sourceCalls = [],
		platformCalls = [],
		searches = [],
		writes = []
	let platform = async () => ({ lyric: '[00:01]Line', tlyric: '[00:01]Platform translation' })
	let source = async () => ({ lyric: '[00:01]Line', tlyric: '[00:01]Source translation' })
	let match = async () => ({
		data: {
			code: 0,
			req_1: {
				code: 0,
				data: {
					body: {
						song: {
							list: [
								{
									mid: '00000000000002',
									title: 'Song',
									singer: [{ name: 'Artist' }],
									album: { title: 'Regression' },
									interval: 15,
								},
							],
						},
					},
				},
			},
		},
	})
	const overrides = {
		'@/player/MusicSourceResolver': {
			resolveSource: async (track) => ({ url: track.url, wasCached: false }),
			cancelPreparedNextTrack() {},
			setCurrentStreamPriority() {},
			isPreparedNextTrackValid: () => false,
			withSourceRuntimeLock: (...args) => lock(...args),
		},
		'@/helpers/userApi/getMusicSource': {
			myGetLyric: (track) => {
				platformCalls.push(track)
				return platform(track)
			},
		},
		axios: {
			post: (...args) => {
				searches.push(args)
				return match(...args)
			},
		},
	}
	const h = fixture.runtime({ moduleOverrides: overrides })
	const lock = h.load('src/player/sourceResolver/runtime.ts').withSourceRuntimeLock
	const api = {
		id: 'source',
		scriptType: 'lxmusic',
		script: 'fixture',
		sources: { tx: { actions: ['musicUrl', 'lyric'] } },
		getMusicUrl: async () => 'https://example.test/audio',
		getLyric: (...args) => {
			sourceCalls.push(args)
			return source(...args)
		},
	}
	h.stores.musicApiSelectedStore.setValue(api)
	for (const name of ['nowLyricState', 'nowTranslationLyricState']) {
		const original = h.stores[name].setValue
		h.stores[name].setValue = (value) => {
			writes.push([name, value])
			original(value)
		}
	}
	const facade = h.load('src/helpers/trackPlayerIndex.ts').default
	return {
		...h,
		facade,
		api,
		sourceCalls,
		platformCalls,
		searches,
		writes,
		setSource: (fn) => {
			source = fn
		},
		setPlatform: (fn) => {
			platform = fn
		},
		setMatcher: (fn) => {
			match = fn
		},
		async play(track = song()) {
			await facade.play(track, true)
			await flush()
		},
	}
}

await suite.check('current source complete lyrics win without platform fetch', async () => {
	const h = runtime()
	await h.play()
	assert.equal(h.sourceCalls.length, 1)
	assert.equal(h.platformCalls.length, 0)
	assert.equal(h.stores.nowTranslationLyricState.getValue(), '[00:01]Source translation')
})

await suite.check(
	'missing source translation fetches platform translation and keeps source original',
	async () => {
		const h = runtime()
		h.setSource(async () => ({ rawLrc: '[00:02]Line', translation: null }))
		await h.play()
		assert.equal(h.stores.nowLyricState.getValue(), '[00:02]Line')
		assert.match(h.stores.nowTranslationLyricState.getValue(), /Platform translation/)
		assert.equal(h.platformCalls.length, 1)
	},
)

await suite.check(
	'translation-only source is preserved while platform fills original',
	async () => {
		const h = runtime()
		h.setSource(async () => ({ translation: '[00:01]Source translation' }))
		await h.play()
		assert.equal(h.stores.nowLyricState.getValue(), '[00:01]Line')
		assert.match(h.stores.nowTranslationLyricState.getValue(), /Source translation/)
	},
)

await suite.check(
	'platform translation is retimed to matching source lines without changing original or shifting blank rows',
	async () => {
		const h = runtime()
		const original = '[00:02]Line one\n[00:03]Extra\n[00:04]Line two'
		h.setSource(async () => ({ lyric: original }))
		h.setPlatform(async () => ({
			lyric: '[00:01]Line one\n[00:02]Line two',
			tlyric: '[00:01]Uno\n[00:02]Dos',
		}))
		await h.play()
		assert.equal(h.stores.nowLyricState.getValue(), original)
		const Parser = h.load('src/utils/lrcParser.ts').default
		const translation = new Parser({
			rawLrc: h.stores.nowTranslationLyricState.getValue(),
		}).getLyric()
		assert.deepEqual(
			translation.map((line) => [line.time, line.lrc]),
			[
				[2, 'Uno'],
				[3, ''],
				[4, 'Dos'],
			],
		)
		const unrelated = runtime()
		unrelated.setSource(async () => ({ lyric: '[00:02]Different version' }))
		await unrelated.play()
		assert.equal(unrelated.stores.nowLyricState.getValue(), '[00:02]Different version')
		assert.equal(unrelated.stores.nowTranslationLyricState.getValue(), null)
	},
)

await suite.check('platform failure preserves partial source original or translation', async () => {
	for (const result of [
		{ lyric: '[00:01]Source only' },
		{ translation: '[00:01]Translation only' },
	]) {
		const h = runtime()
		h.setSource(async () => result)
		h.setPlatform(async () => {
			throw new Error('platform offline')
		})
		await h.play()
		assert.equal(h.stores.nowLyricState.getValue(), result.lyric || null)
		assert.equal(h.stores.nowTranslationLyricState.getValue(), result.translation || null)
	}
})

await suite.check('empty or failing source falls back and clears null translation', async () => {
	for (const response of [null, { lyric: '', tlyric: null }, new Error('source failed')]) {
		const h = runtime()
		h.stores.nowTranslationLyricState.setValue('old translation')
		h.setSource(async () => {
			if (response instanceof Error) throw response
			return response
		})
		h.setPlatform(async () => ({ lyric: '[00:01]Platform', tlyric: null }))
		await h.play()
		assert.equal(h.stores.nowLyricState.getValue(), '[00:01]Platform')
		assert.equal(h.stores.nowTranslationLyricState.getValue(), null)
	}
})

await suite.check(
	'Netease uses cached QQ matching only when source lyrics are callable',
	async () => {
	const h = runtime(),
		track = song('123', { platform: 'Netease', songmid: '123' })
	await h.load('src/player/sourceResolver/qqMatch.ts').resolveQQMid(track)
	assert.equal(h.searches.length, 1, 'Warm the same matching cache used by playback')
	await h.play(track)
	assert.equal(h.sourceCalls[0][2], '00000000000002')
	assert.equal(h.searches.length, 1, 'Lyrics must reuse the playback match')
		await h.play(track)
		assert.equal(h.searches.length, 1)
		assert.equal(h.sourceCalls.length, 2)
		const noLyric = runtime()
		noLyric.stores.musicApiSelectedStore.setValue({ ...noLyric.api, getLyric: undefined })
		await noLyric.play(track)
		assert.equal(noLyric.searches.length, 0)
		assert.equal(noLyric.platformCalls[0].platform, 'Netease')
		assert.equal(noLyric.platformCalls[0].id, '123')
	},
)

await suite.check(
	'matching failure falls back on the original platform and a late match cannot invoke a replaced source',
	async () => {
		const track = song('123', { platform: 'Netease', songmid: '123' })
		const failed = runtime()
		failed.setMatcher(async () => {
			throw new Error('no QQ match')
		})
		await failed.play(track)
		assert.equal(failed.sourceCalls.length, 0)
		assert.equal(failed.platformCalls[0].id, '123')
		const h = runtime(),
			pending = deferred()
		h.setMatcher(() => pending.promise)
		await h.play(track)
		assert.equal(h.searches.length, 1)
		h.stores.musicApiSelectedStore.setValue({ ...h.api, id: 'replaced' })
		const before = h.writes.length
		pending.resolve({
			data: { code: 0, req_1: { code: 0, data: { body: { song: { list: [] } } } } },
		})
		await flush()
		assert.equal(h.sourceCalls.length, 0)
		assert.equal(h.platformCalls.length, 0)
		assert.equal(h.writes.length, before)
	},
)

await suite.check(
	'same-song replay changes the native token and old source lyrics cannot overwrite the new request',
	async () => {
		const h = runtime(),
			pending = deferred()
		h.setSource(() => pending.promise)
		await h.play()
		const oldToken = h.player.queue[0].extras.cymusic.token
		h.setSource(async () => ({ lyric: '[00:01]New', tlyric: '[00:01]New translation' }))
		await h.play()
		assert.notEqual(h.player.queue[0].extras.cymusic.token, oldToken)
		const before = h.writes.length
		pending.resolve({ lyric: '[00:01]Old', tlyric: '[00:01]Old translation' })
		await flush()
		assert(!h.writes.slice(before).some(([, text]) => text?.includes('Old')))
		assert.equal(h.stores.nowLyricState.getValue(), '[00:01]New')
		assert.equal(h.stores.nowTranslationLyricState.getValue(), '[00:01]New translation')
	},
)

await suite.check(
	'CommonJS player reload retains optional methods and clears removed declarations',
	async () => {
		const h = runtime()
		const loaded = await h.facade.reloadMusicApi({
			id: 'commonjs',
			isSelected: true,
			script: `module.exports = {
			getMusicUrl: async () => 'https://example.test/audio',
			getLyric: async () => ({ rawLrc: '[00:01]CommonJS', translation: '[00:01]CommonJS translation' }),
			sources: { tx: { actions: ['musicUrl'] } }
		}`,
		})
		assert.equal(typeof loaded.getLyric, 'function')
		assert.deepEqual(loaded.sources.tx.actions, ['musicUrl'])
		h.stores.musicApiSelectedStore.setValue(loaded)
		await h.play()
		assert.equal(h.stores.nowLyricState.getValue(), '[00:01]CommonJS')
		assert.equal(h.platformCalls.length, 0)
		const removed = await h.facade.reloadMusicApi({
			...loaded,
			script: `module.exports.getMusicUrl = async () => 'https://example.test/audio'`,
		})
		assert.equal(removed.getLyric, undefined)
		assert.equal(removed.sources, undefined)
	},
)

await suite.check(
	'late source or platform requests never write after track or source changes',
	async () => {
		for (const boundary of ['source', 'platform'])
			for (const change of ['track', 'source', 'script']) {
				const h = runtime(),
					pending = deferred()
				if (boundary === 'source') h.setSource(() => pending.promise)
				else {
					h.setSource(async () => null)
					h.setPlatform(() => pending.promise)
				}
				await h.play()
				assert.equal(boundary === 'source' ? h.sourceCalls.length : h.platformCalls.length, 1)
				if (change === 'track') h.stores.currentMusicStore.setValue(song('00000000000003'))
				else if (change === 'source')
					h.stores.musicApiSelectedStore.setValue({ ...h.api, id: 'new' })
				else h.api.script = 'updated under the same ID'
				const before = h.writes.length
				pending.resolve({ lyric: '[00:01]Late', tlyric: '[00:01]Late translation' })
				await flush()
				assert.equal(h.writes.length, before, `${boundary}/${change} must not write`)
			}
	},
)

await suite.check(
	'real source selection away and back invalidates a pending platform supplement even with the same final identity',
	async () => {
		const h = runtime(),
			pending = deferred()
		h.setSource(async () => ({ lyric: '[00:01]Line' }))
		h.setPlatform(() => pending.promise)
		h.stores.musicApiStore.setValue([
			h.api,
			{
				id: 'other',
				script: `module.exports.getMusicUrl = async () => 'https://example.test/audio'`,
			},
		])
		await h.play()
		assert.equal(h.platformCalls.length, 1)
		assert.equal(
			h.stores.nowLyricState.getValue(),
			'[00:01]Line',
			'Source original must be visible while platform translation is pending',
		)
		assert.equal(h.stores.nowTranslationLyricState.getValue(), null)
		await h.facade.setMusicApiAsSelectedById('other')
		await h.facade.setMusicApiAsSelectedById(h.api.id)
		assert.equal(h.stores.musicApiSelectedStore.getValue().id, h.api.id)
		const before = h.writes.length
		pending.resolve({ lyric: '[00:01]Late platform', tlyric: '[00:01]Late translation' })
		await flush()
		assert.equal(h.writes.length, before)
	},
)

await fixture.dispose()
suite.finish()
