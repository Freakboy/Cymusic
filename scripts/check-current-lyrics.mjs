// Runs the real fetchCurrentLyrics through the player facade and real source helper.
import { createFixture, item } from './file-system-fixture.mjs'
import { assert, checks, deferred, loadModule } from './native-services-fixture.mjs'
import { fakeClock } from './request-fixture.mjs'

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
function runtime({ platformApi } = {}) {
	const sourceCalls = [],
		platformCalls = [],
		searches = [],
		writes = []
	let platform = platformApi || (async () => ({ lyric: '[00:01]Line', tlyric: '[00:01]Platform translation' }))
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
			withSourceRuntimeLock: (...args) => facadeLock(...args),
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
	h.player.replaceMediaItem = (index, track) => {
		h.calls.player.push(['replace', index, track])
		h.player.queue[index] = track
	}
	const lock = h.load('src/player/sourceResolver/runtime.ts').withSourceRuntimeLock
	let facadeLock = lock
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
		setRuntimeLock: (fn) => { facadeLock = fn },
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

// Keep both platform owners real; only HTTP/clock boundaries are controlled.
function officialPlatform(initialReply) {
	const calls = [], clock = fakeClock()
	let reply = initialReply
	class ClockDate extends Date { static now() { return clock.now } }
	const helper = loadModule('src/helpers/userApi/neteaseLyrics.ts', {}, {
		...clock, Date: ClockDate,
		fetch: async (url, init) => {
			calls.push({ url, init })
			return { ok: true, json: async () => typeof reply === 'function' ? reply(url) : reply }
		},
	})
	const { myGetLyric } = loadModule('src/helpers/userApi/getMusicSource.ts', {
		'./neteaseLyrics': helper,
		'@/components/utils': { b64DecodeUnicode: (text) => text, decodeName: (text) => text },
		'@/components/utils/musicSdk/options.js': {}, '@/components/utils/musicSdk/utils': {},
		'@/components/utils/request': { httpFetch() { throw new Error('Unexpected QQ lyric fallback') } },
		'@/constants/images': {}, '@/helpers/userApi/qq-music-api': {},
		'@/locales/commentsFeature': { t: () => '暂无歌词' }, axios: {}, 'react-native': {},
		'../logger': { logError() {}, logInfo() {} },
	})
	return { myGetLyric, calls, clock, setReply: (value) => { reply = value } }
}

await suite.check('real platform facade preserves original NetEase IDs and distinct terminal states across aliases', async () => {
	for (const platform of ['Netease', 'wy', 'netease', '163']) {
		for (const [reply, status, lyric] of [
			[{ code: 200, lrc: { lyric: '[00:01]Official' } }, 'available', '[00:01]Official'],
			[{ code: 200, pureMusic: true }, 'instrumental', null],
			[{ code: 200, uncollected: true }, 'unavailable', null],
			[{ code: 403 }, 'error', null],
		]) {
			const official = officialPlatform(reply), h = runtime({ platformApi: official.myGetLyric })
			h.stores.musicApiSelectedStore.setValue(null)
			await h.play(song('186016', { platform }))
			assert.equal(h.stores.lyricsStatusStore.getValue().status, status)
			assert.equal(h.stores.lyricsStatusStore.getValue().retryable, false)
			assert.equal(h.stores.nowLyricState.getValue(), lyric)
			assert.match(official.calls[0].url, /id=186016&/)
			assert.equal(h.searches.length, 0)
			const before = official.calls.length
			await h.facade.retryCurrentLyrics()
			assert.equal(official.calls.length, before, 'Only retryable errors can retry')
		}
	}
})

await suite.check('real facade retries both official endpoints after failure without audio, queue or progress writes', async () => {
	const official = officialPlatform({ code: 500 }), h = runtime({ platformApi: official.myGetLyric })
	h.stores.musicApiSelectedStore.setValue(null)
	await h.play(song('186016', { platform: 'wy' }))
	assert.deepEqual(h.stores.lyricsStatusStore.getValue(), { status: 'error', retryable: true })
	assert.equal(official.calls.length, 2)
	const response = deferred()
	official.setReply(() => response.promise)
	const queue = h.player.queue.slice(), audioCalls = h.calls.player.length, writes = h.calls.writes.length
	let settled = false
	const retry = h.facade.retryCurrentLyrics().then(() => { settled = true })
	await flush()
	assert.equal(settled, false, 'The public promise must wait for lyrics')
	assert.equal(h.stores.lyricsStatusStore.getValue().status, 'loading')
	assert.equal(official.calls.length, 3, 'Error must not be cached')
	await h.facade.retryCurrentLyrics()
	assert.equal(official.calls.length, 3, 'Repeated taps while loading must not start work')
	response.resolve({ code: 200, lrc: { lyric: '[00:02]Recovered' } })
	await retry
	assert.equal(h.stores.nowLyricState.getValue(), '[00:02]Recovered')
	assert.equal(h.stores.lyricsStatusStore.getValue().status, 'available')
	assert.deepEqual(h.player.queue, queue)
	assert.equal(h.calls.player.length, audioCalls)
	assert.equal(h.calls.writes.length, writes, 'Retry must not change persisted progress or audio metadata')
	assert.equal(official.clock.pending, 0)
})

await suite.check('source failure falls back through both real official endpoints using the original native ID', async () => {
	const official = officialPlatform((url) => url.includes('/v1?') ? { code: 500 } : {
		code: 200, lrc: { lyric: '[00:03]Official fallback' },
	})
	const h = runtime({ platformApi: official.myGetLyric })
	h.setSource(async () => { throw new Error('Source offline') })
	await h.play(song('186016', { platform: 'Netease' }))
	assert.equal(h.sourceCalls.length, 1)
	assert.equal(h.platformCalls.length, 1)
	assert.equal(official.calls.length, 2)
	for (const { url } of official.calls) assert.match(url, /music\.163\.com\/api\/song\/lyric(?:\/v1)?\?id=186016&/)
	assert.equal(h.stores.nowLyricState.getValue(), '[00:03]Official fallback')
	assert.deepEqual(h.stores.lyricsStatusStore.getValue(), { status: 'available', retryable: false })
})

await suite.check('real NetEase terminal states and errors never replace a successful partial source', async () => {
	for (const reply of [{ code: 500 }, { code: 200, pureMusic: true }, { code: 200, uncollected: true }]) {
		const official = officialPlatform(reply), h = runtime({ platformApi: official.myGetLyric })
		h.setSource(async () => ({ lyric: '[00:02]Source wins' }))
		await h.play(song('186016', { platform: 'wy' }))
		assert.equal(h.stores.nowLyricState.getValue(), '[00:02]Source wins')
		assert.deepEqual(h.stores.lyricsStatusStore.getValue(), { status: 'available', retryable: false })
		const calls = official.calls.length
		await h.facade.retryCurrentLyrics()
		assert.equal(official.calls.length, calls)
	}
})

await suite.check('real official late retry cannot overwrite a new song or reset state', async () => {
	for (const boundary of ['track', 'reset']) {
		const official = officialPlatform({ code: 500 }), h = runtime({ platformApi: official.myGetLyric })
		h.stores.musicApiSelectedStore.setValue(null)
		await h.play(song('186016', { platform: 'netease' }))
		const old = deferred()
		official.setReply((url) => url.includes('id=186016&') ? old.promise : { code: 200, pureMusic: true })
		const retry = h.facade.retryCurrentLyrics()
		await flush()
		if (boundary === 'track') await h.play(song('5308028', { platform: 'wy' }))
		else h.facade.reset()
		assert.equal(h.stores.lyricsStatusStore.getValue().status, boundary === 'track' ? 'instrumental' : 'idle', boundary)
		const before = h.writes.length
		old.resolve({ code: 200, lrc: { lyric: '[00:01]Late' } })
		await retry
		assert.equal(h.writes.length, before, JSON.stringify({ boundary, writes: h.writes.slice(before) }))
		assert.equal(h.stores.nowLyricState.getValue(), null)
		assert.equal(h.stores.lyricsStatusStore.getValue().status, boundary === 'track' ? 'instrumental' : 'idle')
	}
})

await suite.check('independent lyric sequence rejects late same-song work even with an identical native token', async () => {
	const h = runtime(), old = deferred(), now = Date.now, random = Math.random
	h.stores.musicApiSelectedStore.setValue(null)
	h.setPlatform(() => old.promise)
	try {
		Date.now = () => 123456789
		Math.random = () => 0.5
		await h.play()
		const token = h.player.queue[0].extras.cymusic.token
		h.setPlatform(async () => ({ lyric: '[00:01]Newest', status: 'available' }))
		await h.play()
		assert.equal(h.player.queue[0].extras.cymusic.token, token)
		const before = h.writes.length
		old.resolve({ lyric: '[00:01]Stale', status: 'available' })
		await flush()
		assert.equal(h.writes.length, before)
		assert.equal(h.stores.nowLyricState.getValue(), '[00:01]Newest')
	} finally {
		Date.now = now
		Math.random = random
	}
})

await suite.check('legacy fake no-lyrics LRC is never published to lyric consumers', async () => {
	for (const text of ['暂无歌词', 'No lyrics available']) {
		const h = runtime()
		h.stores.musicApiSelectedStore.setValue(null)
		h.setPlatform(async () => ({ lyric: `[00:00.00]${text}`, tlyric: '' }))
		await h.play()
		assert.equal(h.stores.nowLyricState.getValue(), null)
		assert.deepEqual(h.stores.lyricsStatusStore.getValue(), { status: 'error', retryable: true })
	}
})

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
		h.setPlatform(async () => ({ lyric: '[00:01]Line', tlyric: '[00:01]Current translation' }))
		await h.facade.setMusicApiAsSelectedById('other')
		await h.facade.setMusicApiAsSelectedById(h.api.id)
		await flush()
		assert.equal(h.stores.musicApiSelectedStore.getValue().id, h.api.id)
		assert.equal(h.stores.nowTranslationLyricState.getValue(), '[0:1.000]Current translation')
		assert.equal(h.stores.lyricsStatusStore.getValue().status, 'available')
		const before = h.writes.length
		pending.resolve({ lyric: '[00:01]Late platform', tlyric: '[00:01]Late translation' })
		await flush()
		assert.equal(h.writes.length, before)
	},
)

await suite.check('switch/delete converge pending source lyrics while paused without touching native playback', async () => {
	for (const change of ['switch', 'delete']) {
		const h = runtime(), old = deferred()
		h.setSource(() => old.promise)
		h.stores.musicApiStore.setValue([h.api, {
			id: 'replacement',
			script: `module.exports = {
				getMusicUrl: async () => 'https://example.test/unused',
				getLyric: async () => ({ lyric: '[00:02]Replacement', tlyric: '[00:02]Replacement translation' })
			}`,
		}])
		h.setPlatform(async () => ({ lyric: '[00:03]Platform after delete', status: 'available' }))
		await h.play()
		assert.equal(h.sourceCalls.length, 1)
		assert.equal(h.stores.lyricsStatusStore.getValue().status, 'loading')
		h.facade.pause()
		const queue = h.player.queue.slice(), audioCalls = h.calls.player.length, persistWrites = h.calls.writes.length
		const changing = change === 'switch'
			? h.facade.setMusicApiAsSelectedById('replacement')
			: h.facade.deleteMusicApiById(h.api.id)
		// Expire the helper's bounded lock ownership, leaving the actual old request pending.
		h.calls.timers.find(({ delay }) => delay === 5000).callback()
		await changing
		await flush()
		const expected = change === 'switch' ? '[00:02]Replacement' : '[00:03]Platform after delete'
		assert.equal(h.stores.lyricsStatusStore.getValue().status, 'available', change)
		assert.equal(h.stores.nowLyricState.getValue(), expected)
		assert.equal(h.platformCalls.length, change === 'switch' ? 0 : 1)
		assert.deepEqual(h.player.queue, queue)
		assert.equal(h.calls.player.length, audioCalls, 'No play, seek, clear or queue rebuild')
		assert(!h.calls.writes.slice(persistWrites).some(({ key }) => key === 'music.progress'))
		assert.equal(h.stores.playbackIntentStore.getValue(), 'pause')
		const before = h.writes.length
		old.resolve({ lyric: '[00:01]Old source', tlyric: '[00:01]Old translation' })
		await flush()
		assert.equal(h.writes.length, before)
		assert.equal(h.stores.nowLyricState.getValue(), expected)
	}
})

await suite.check('source selection and deletion cleanup failures still start platform lyrics and settle error status', async () => {
	for (const change of ['switch', 'delete']) {
		const h = runtime(), old = deferred()
		h.setSource(() => old.promise)
		h.stores.musicApiStore.setValue([h.api, { id: 'broken', script: 'invalid source' }])
		h.setPlatform(async () => ({ lyric: '', status: 'error', retryable: true }))
		await h.play()
		assert.equal(h.stores.lyricsStatusStore.getValue().status, 'loading')
		h.setRuntimeLock(async () => { throw new Error('Reload/cleanup failed') })
		if (change === 'switch') await h.facade.setMusicApiAsSelectedById('broken')
		else h.facade.deleteMusicApiById(h.api.id)
		await flush()
		assert.equal(h.platformCalls.length, 1)
		assert.deepEqual(h.stores.lyricsStatusStore.getValue(), { status: 'error', retryable: true })
		old.resolve({ lyric: '[00:01]Obsolete' })
		await flush()
		assert.equal(h.stores.nowLyricState.getValue(), null)
		h.setPlatform(async () => ({ lyric: '[00:04]Retry', status: 'available' }))
		await h.facade.retryCurrentLyrics()
		assert.equal(h.stores.nowLyricState.getValue(), '[00:04]Retry')
	}
})

await suite.check('explicit selected-source restoration restarts pending lyrics for an owned paused item', async () => {
	const h = runtime(), old = deferred()
	h.setSource(() => old.promise)
	await h.play()
	h.facade.pause()
	const api = { id: 'restored', script: `module.exports = {
		getMusicUrl: async () => 'https://example.test/unused',
		getLyric: async () => ({ lyric: '[00:05]Restored', tlyric: '[00:05]Restored translation' })
	}` }
	h.persistence.set('music.musicApi', [api])
	h.persistence.set('music.selectedMusicApi', api)
	const queue = h.player.queue.slice()
	const restoring = h.facade.setupTrackPlayer()
	h.calls.timers.find(({ delay }) => delay === 5000).callback()
	await restoring
	await flush()
	assert.equal(h.stores.nowLyricState.getValue(), '[00:05]Restored')
	assert.equal(h.stores.lyricsStatusStore.getValue().status, 'available')
	assert.deepEqual(h.player.queue, queue)
	assert.equal(h.stores.playbackIntentStore.getValue(), 'pause')
	const before = h.writes.length
	old.resolve({ lyric: '[00:01]Old restoration' })
	await flush()
	assert.equal(h.writes.length, before)
})

await suite.check('explicit selected-source reload failure still converges pending lyrics through platform fallback', async () => {
	const h = runtime(), old = deferred()
	h.setSource(() => old.promise)
	await h.play()
	h.persistence.set('music.musicApi', [h.api])
	h.persistence.set('music.selectedMusicApi', h.api)
	h.setRuntimeLock(async () => { throw new Error('Restore failed') })
	await assert.rejects(h.facade.setupTrackPlayer(), /Restore failed/)
	await flush()
	assert.equal(h.platformCalls.length, 1)
	assert.equal(h.stores.nowLyricState.getValue(), '[00:01]Line')
	assert.equal(h.stores.lyricsStatusStore.getValue().status, 'available')
	const before = h.writes.length
	old.resolve({ lyric: '[00:01]Old failed restoration' })
	await flush()
	assert.equal(h.writes.length, before)
})

await suite.check('obsolete switch/delete completion cannot refetch over a newer source selection', async () => {
	for (const change of ['switch', 'delete']) {
		const h = runtime(), cleanup = deferred()
		await h.play()
		h.stores.musicApiStore.setValue([h.api, ...['delayed', 'latest'].map((id) => ({
			id, script: `module.exports = {
				getMusicUrl: async () => 'unused',
				getLyric: async () => ({ lyric: '[00:01]${id}', tlyric: '[00:01]translation' })
			}`,
		}))])
		let operations = 0
		h.setRuntimeLock(async (action) => {
			if (++operations === 1) await cleanup.promise
			return action()
		})
		const obsolete = change === 'switch'
			? h.facade.setMusicApiAsSelectedById('delayed')
			: h.facade.deleteMusicApiById(h.api.id)
		await h.facade.setMusicApiAsSelectedById('latest')
		await flush()
		assert.equal(h.stores.nowLyricState.getValue(), '[00:01]latest')
		const before = h.writes.length
		cleanup.resolve()
		await obsolete
		await flush()
		assert.equal(h.writes.length, before, change)
		assert.equal(h.stores.lyricsStatusStore.getValue().status, 'available')
	}
})

await suite.check('ordinary runtime reload and unowned source changes do not refetch lyrics', async () => {
	const h = runtime()
	await h.play()
	await h.facade.reloadMusicApi({ ...h.api, isSelected: true })
	await flush()
	assert.equal(h.sourceCalls.length, 1)
	assert.equal(h.platformCalls.length, 0)
	h.stores.musicApiStore.setValue([h.api, { id: 'other', script: `module.exports.getMusicUrl = async () => 'unused'` }])
	h.player.activeIndex = 1
	await h.facade.setMusicApiAsSelectedById('other')
	h.facade.deleteMusicApiById('other')
	await flush()
	assert.equal(h.sourceCalls.length, 1)
	assert.equal(h.platformCalls.length, 0)
})

await fixture.dispose()
suite.finish()
