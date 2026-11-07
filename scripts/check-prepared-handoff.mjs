// Run the production facade with synchronous RNTP v5 queue and controlled timers.
import { createFixture, item } from './file-system-fixture.mjs'
import { assert, checks, deferred, flush, loadModule } from './native-services-fixture.mjs'

const fixture = createFixture()
const suite = checks()
const song = (id, extra = {}) => item(id, `https://audio.example/${id}.mp3`, { platform: 'tx', ...extra })
const state = (value) => ({ getValue: () => value, setValue: (next) => { value = next }, useValue: () => value })

function runtime() {
	const h = fixture.runtime()
	const { player, stores } = h
	const adapters = { disposeLxMusicScript() {}, isLxMusicScript: () => false, reloadLxMusicScript: async (api) => api }
	const sourceRuntime = loadModule('src/player/sourceResolver/runtime.ts', {
		'@/helpers/userApi/lxMusicSourceAdapter': adapters,
	})
	const { withSourceRuntimeLock } = sourceRuntime
	const sourceLyric = loadModule('src/helpers/sourceLyric.ts', {
		'@/player/PlayerStore': stores,
		'@/player/sourceResolver/runtime': sourceRuntime,
		'@/utils/lrcParser': h.load('src/utils/lrcParser.ts'),
	})
	Object.assign(player, h.load('node_modules/@rntp/player/src/events/index.ts'))
	stores.preloadNextTrackStore = state(true)
	stores.nowTranslationLyricState = state(null)
	const timers = new Map(), cancelled = [], priority = [], sourceCalls = [], preparations = [], downloads = []
	const invalidations = new Set(), runtimeProbe = []
	let clock = 0, generation = 0, valid = null, list = [], lockCalls = 0
	const invalidate = () => {
		// The resolver subscriber runs before the facade in production.
		generation++; valid = null
		for (const callback of invalidations) callback()
	}
	for (const name of ['qualityStore', 'preloadNextTrackStore', 'musicApiSelectedStore', 'musicApiStore']) {
		const store = stores[name], setValue = store.setValue
		store.setValue = (value) => {
			const previous = store.getValue()
			setValue(value)
			if (previous !== value) invalidate()
		}
	}
	let resolveSource = async (track) => ({ url: track.url, headers: track.headers, wasCached: false })
	let prepare = async (track, token, options) => {
		const identity = { sourceId: 'prepared-source-v1-sha', quality: 'flac' }
		const resolved = { ...track, url: `file:///cache/${track.id}.flac`, headers: { Authorization: 'prepared' },
			userAgent: 'prepared-agent', cacheSourceId: identity.sourceId, cacheQuality: identity.quality }
		return { track: resolved, mediaItem: media.toMediaItem(resolved, token, false, { ...options, preparedGeneration: generation }),
			cacheIdentity: identity, generation, key: track.id }
	}
	const media = h.load('src/player/mediaItem.ts')
	const same = (a, b) => !!a && !!b && a.id === b.id && a.platform === b.platform
	const mutations = []
	player.replaceMediaItem = (index, track) => {
		mutations.push(['replace', index, track])
		assert.notEqual(index, player.activeIndex, 'Preparation must never replace active audio')
		player.queue[index] = track
	}
	player.removeMediaItem = (index) => {
		mutations.push(['remove', index])
		player.queue.splice(index, 1)
		if (player.activeIndex > index) player.activeIndex--
	}
	player.addMediaItem = (track) => { mutations.push(['append', track]); player.queue.push(track) }
	const facade = loadModule('src/helpers/trackPlayerIndex.ts', {
		'@/constants/commonConst': { sortIndexSymbol: Symbol('sort'), timeStampSymbol: Symbol('time') },
		'@/constants/constant': { SoundAsset: { fakeAudio: 1 } },
		'@/store/config': { set() {} },
		'@/utils/delay': async () => {},
		'@/utils/mediaItem': { isSameMediaItem: same, mergeProps: (a, b) => ({ ...a, ...b }), sortByTimestampAndIndex: (tracks) => tracks },
		'expo-file-system/legacy': {},
		immer: { produce: (value, action) => { const copy = [...value]; action(copy); return copy } },
		'lodash.shuffle': (value) => [...value].reverse(),
		'../../modules/cymusic-native': h.nativeFs,
		'@rntp/player': player,
		'@/player/mediaItem': media,
		'@/utils/imageUtils': h.load('src/utils/imageUtils.ts'),
		'@/helpers/types': { MusicRepeatMode: { QUEUE: 'queue', SINGLE: 'single', SHUFFLE: 'shuffle' } },
		'@/store/PersistStatus': h.persistence,
		'@/store/playList': {
			getPlayList: () => list, usePlayList: () => list,
			getPlayListMusicAt: (index) => list.length ? list[(index + list.length) % list.length] : null,
			getMusicIndex: (track) => list.findIndex((entry) => same(entry, track)),
			isInPlayList: (track) => list.some((entry) => same(entry, track)), isPlayListEmpty: () => !list.length,
			setPlayList: (tracks) => { list = tracks },
		},
		'@/utils/mediaIndexMap': { createMediaIndexMap: (tracks) => ({ has: (track) => tracks.some((entry) => same(entry, track)) }) },
		'react-native': { Alert: { alert: (...args) => h.calls.alerts.push(args) }, AppState: { currentState: 'active' },
			Image: { resolveAssetSource: () => ({ uri: 'file:///app/silence.mp3' }) } },
		'@/helpers/userApi/getMusicSource': { myGetLyric: async (track) => ({ lyric: `lyric:${track.id}` }) },
		'./sourceLyric': sourceLyric,
		'@/player/sourceResolver/qqMatch': h.load('src/player/sourceResolver/qqMatch.ts'),
		'@/player/sourceIdentity': h.load('src/player/sourceIdentity.ts'),
		'@/constants/images': { fakeAudioMp3Uri: 'file:///app/silence.mp3' },
		'@/utils/i18n': { nowLanguage: state('zh') },
		'@/utils/utils': { showToast() {} },
		'./localFile': { resolveLocalFile: async (url) => ({ status: 'nonlocal', fileUri: url }) },
		'./logger': { logError: (...args) => h.calls.errors.push(args), logInfo() {} },
		'./userApi/lxMusicSourceAdapter': adapters,
		'@/player/PlayerStore': stores,
		'@/player/CacheManager': { ...h.cache, clearCache: async () => invalidate(),
			downloadToCache: async (track) => { downloads.push(track); return `file:///cache/${track.id}.mp3` } },
		'@/player/preparationInvalidation': { onPreparationInvalidated: (callback) => {
			invalidations.add(callback); return () => invalidations.delete(callback)
		} },
		'@/player/MusicSourceResolver': {
			resolveSource: (track) => { sourceCalls.push(track); return resolveSource(track) },
			prepareNextTrack: async (track, token, options) => {
				preparations.push({ track, token, options })
				const result = await prepare(track, token, options)
				valid = result
				return result
			},
			cancelPreparedNextTrack: () => { generation++; valid = null },
			isPreparedNextTrackValid: (value) => value === valid && value.generation === generation,
			setCurrentStreamPriority: (value) => priority.push(value),
			withSourceRuntimeLock: (action) => { lockCalls++; return withSourceRuntimeLock(action) },
		},
	}, {
		runtimeProbe,
		setTimeout: (callback, delay) => { const id = ++clock; timers.set(id, { callback, delay }); return id },
		clearTimeout: (id) => { cancelled.push(id); timers.delete(id) },
	}, { dispose: (callback) => h.calls.disposers.push(callback) }).default
	return { ...h, facade, timers, cancelled, priority, sourceCalls, preparations, mutations, downloads, invalidations,
		withSourceRuntimeLock, runtimeProbe,
		makePrepared: prepare,
		get lockCalls() { return lockCalls },
		setResolver: (action) => { resolveSource = action }, setPrepare: (action) => { prepare = action },
		invalidate,
		emit: (event, payload) => player.emit(player.Event[event], payload),
		count: (name) => h.calls.player.filter((call) => call[0] === name).length,
		async start() { await facade.setupTrackPlayer(); facade.addAll([song('a'), song('b'), song('c')]); await facade.play(song('a')) },
		async tick(delay = 8000) {
			const entry = [...timers].find(([, timer]) => timer.delay === delay)
			assert(entry, `Expected ${delay}ms timer`)
			timers.delete(entry[0]); await entry[1].callback(); await flush()
		},
		transition() { player.activeIndex = 1; player.progress.position = 2.75; player.emit(player.Event.MediaItemTransition, { index: 1, item: player.getActiveMediaItem() }) },
	}
}

await suite.check('real prepared transition adopts full source without resolve/reload/play/seek and keeps two items', async () => {
	const h = runtime(); await h.start(); await h.tick()
	assert.equal(h.player.queue[1].extras.cymusic.placeholder, false)
	assert(h.mutations.some(([op, index, track]) => op === 'replace' && index === 1 && !track.extras.cymusic.placeholder))
	const old = h.player.queue[0], prepared = h.player.queue[1]
	const calls = h.calls.player.length, sources = h.sourceCalls.length
	h.transition()
	assert.equal(h.facade.getCurrentMusic().id, 'b')
	assert.equal(h.player.queue.length, 2); assert.equal(h.player.activeIndex, 0)
	assert.equal(h.player.queue[0], prepared); assert.equal(h.player.progress.position, 2.75)
	assert.equal(h.player.queue[1].extras.cymusic.placeholder, true)
	assert.equal(h.calls.player.length, calls); assert.equal(h.sourceCalls.length, sources)
	assert.equal(h.facade.getCurrentMusic().headers.Authorization, 'prepared')
	assert.equal(h.facade.getCurrentMusic().cacheSourceId, 'prepared-source-v1-sha')
	assert.equal(h.persistence.get('music.progress'), 2.75)
	h.emit('MediaItemTransition', { index: 1, item: prepared })
	h.emit('MediaItemTransition', { index: 0, item: old })
	assert.equal(h.facade.getCurrentMusic().id, 'b')
	assert.equal(h.facade.isCurrentNativeItem(old), false)
	assert.equal(h.facade.isCurrentProgressEvent({ mediaId: old.mediaId, timestamp: 0 }), false)
	await flush(); assert.equal(h.stores.nowLyricState.getValue(), 'lyric:b')
})

await suite.check('Pause before JS transition adopts prepared audio without changing pause intent, including resume reconciliation', async () => {
	for (const resume of [false, true]) {
		const h = runtime(); await h.start(); await h.tick()
		h.player.activeIndex = 1; h.facade.pause()
		const plays = h.count('play')
		if (resume) h.facade.observeNativeTransport('play')
		else h.emit('MediaItemTransition', { index: 1, item: h.player.getActiveMediaItem() })
		assert.equal(h.facade.getCurrentMusic().id, 'b'); assert.equal(h.count('play'), plays)
		assert.equal(h.stores.playbackIntentStore.getValue(), resume ? 'play' : 'pause')
		assert.equal(h.player.isPlaying(), false)
	}
})

await suite.check('late preparation loses to active placeholder and original fallback resolves the next item once', async () => {
	const h = runtime(); await h.start()
	const pending = deferred(); h.setPrepare(async (...args) => { await pending.promise; return h.makePrepared(...args) })
	const task = h.tick(); await flush()
	const placeholder = h.player.queue[1]
	h.transition(); await flush()
	pending.resolve(); await task
	assert.equal(h.facade.getCurrentMusic().id, 'b'); assert.equal(h.sourceCalls.length, 2)
	assert.equal(h.count('items'), 2)
	h.emit('MediaItemTransition', { index: 1, item: placeholder })
	assert.equal(h.sourceCalls.length, 2)
})

await suite.check('late non-null result cannot replace an active paused placeholder', async () => {
	const h = runtime(); await h.start()
	const pending = deferred(); h.setPrepare(async (...args) => { await pending.promise; return h.makePrepared(...args) })
	const task = h.tick(); await flush(); h.player.activeIndex = 1; h.facade.pause()
	const previous = h.player.queue[1]; pending.resolve(); await task
	assert.equal(h.player.queue[1], previous); assert.equal(h.facade.getCurrentMusic().id, 'a')
})

await suite.check('pending results are fenced by revision after invalidation, edits, disable and Stop', async () => {
	for (const action of [(h) => h.invalidate(), (h) => h.facade.add(song('d')),
		(h) => h.facade.togglePreloadNextTrack(false), (h) => h.facade.stop(),
		(h) => h.facade.skipToNext(), (h) => h.facade.setRepeatMode('single')]) {
		const h = runtime(); await h.start()
		const pending = deferred(); h.setPrepare(async (...args) => { await pending.promise; return h.makePrepared(...args) })
		const task = h.tick(); await flush(); await action(h)
		const mutations = h.mutations.length
		pending.resolve(); await task
		assert.equal(h.mutations.length, mutations)
		assert.equal(h.player.queue[1].extras.cymusic.placeholder, true)
	}
})

await suite.check('null/rejected preparation and failed native installation retain the placeholder fallback', async () => {
	for (const failure of ['null', 'reject', 'native']) {
		const h = runtime(); await h.start()
		if (failure === 'null') h.setPrepare(async () => null)
		if (failure === 'reject') h.setPrepare(async () => { throw new Error('offline') })
		if (failure === 'native') {
			const replace = h.player.replaceMediaItem
			h.player.replaceMediaItem = (index, track) => {
				if (!track.extras.cymusic.placeholder) throw new Error('native write failed')
				replace(index, track)
			}
		}
		await h.tick(); assert.equal(h.player.queue[1].extras.cymusic.placeholder, true)
		h.transition(); await flush(); assert.equal(h.facade.getCurrentMusic().id, 'b')
		assert.equal(h.sourceCalls.length, 2)
	}
})

await suite.check('app Play reconciles a real prepared transition before resuming the adopted item', async () => {
	const h = runtime(); await h.start(); await h.tick()
	h.player.activeIndex = 1; h.facade.pause(); await h.facade.play()
	assert.equal(h.facade.getCurrentMusic().id, 'b'); assert.equal(h.player.activeIndex, 0)
	assert.equal(h.sourceCalls.length, 1); assert.equal(h.count('items'), 1)
	assert.equal(h.player.isPlaying(), true)
})

await suite.check('disable, Stop, seek, repeat, navigation, queue edits and invalidation retire prepared audio', async () => {
	for (const action of [
		(h) => h.facade.togglePreloadNextTrack(false), (h) => h.facade.stop(),
		(h) => h.facade.observeNativeTransport('stop'), (h) => h.facade.seekTo(4),
		(h) => h.facade.setRepeatMode('single'), (h) => h.facade.add(song('d')),
		(h) => h.facade.skipToNext(), (h) => h.facade.skipToPrevious(),
		(h) => h.facade.clearToBePlayed(), (h) => h.facade.remove(song('b')),
		(h) => h.facade.playWithReplacePlayList(song('c'), [song('c')]),
		(h) => h.invalidate(), (h) => h.facade.reset(), (h) => h.facade.clear(),
	]) {
		const h = runtime(); await h.start(); await h.tick()
		const stale = h.player.queue[1]
		await action(h); await flush()
		assert.notEqual(h.player.queue[1], stale)
		const current = h.facade.getCurrentMusic()?.id
		h.emit('MediaItemTransition', { index: 1, item: stale })
		assert.equal(h.facade.getCurrentMusic()?.id, current)
	}
})

await suite.check('cancelled timers cannot start preparation after stop, disable, reset or hot disposal', async () => {
	for (const action of [(h) => h.facade.stop(), (h) => h.facade.togglePreloadNextTrack(false),
		(h) => h.facade.reset(), (h) => h.calls.disposers.forEach((dispose) => dispose())]) {
		const h = runtime(); await h.start()
		const [id, timer] = [...h.timers].find(([, value]) => value.delay === 8000)
		action(h)
		assert(h.cancelled.includes(id)); assert(!h.timers.has(id))
		await timer.callback(); assert.equal(h.preparations.length, 0)
	}
})

await suite.check('Stop retires an already active prepared item before its queued JS event', async () => {
	const h = runtime(); await h.start(); await h.tick()
	h.player.activeIndex = 1; const stale = h.player.getActiveMediaItem()
	h.facade.stop(); h.emit('MediaItemTransition', { index: 1, item: stale })
	assert.equal(h.facade.getCurrentMusic().id, 'a')
	assert.equal(h.stores.playbackIntentStore.getValue(), 'stop')
	assert.equal(h.player.isPlaying(), false)
})

await suite.check('quality/preload/source/cache invalidation adopts already active audio before its delayed transition', async () => {
	for (const paused of [false, true]) {
		for (const change of ['quality', 'preload', 'source', 'cache']) {
			const h = runtime()
			h.persistence.set('music.musicApi', [{ id: 'new', name: 'new', script: 'module.exports.getMusicUrl = () => "url"' }])
			await h.start()
			await h.tick()
			const prepared = h.player.queue[1], previous = h.player.queue[0]
			h.player.activeIndex = 1; h.player.progress.position = 3.25
			if (paused) h.facade.pause()
			const calls = h.calls.player.length, sources = h.sourceCalls.length
			if (change === 'quality') h.facade.setQuality('320k')
			if (change === 'preload') h.facade.togglePreloadNextTrack(false)
			if (change === 'source') await h.facade.setMusicApiAsSelectedById('new')
			if (change === 'cache') await h.facade.clearCache()
			assert.equal(h.facade.getCurrentMusic().id, 'b', `${change}, paused=${paused}`)
			assert.equal(h.player.queue[0], prepared); assert.equal(h.player.activeIndex, 0)
			assert.equal(h.player.queue.length, 2); assert.equal(h.player.queue[1].extras.cymusic.id, 'c')
			assert.equal(h.player.queue[1].extras.cymusic.placeholder, true)
			assert.equal(h.player.progress.position, 3.25); assert.equal(h.persistence.get('music.progress'), 3.25)
			assert.equal(h.stores.playbackIntentStore.getValue(), paused ? 'pause' : 'play')
			assert.equal(h.player.isPlaying(), !paused)
			assert.equal(h.calls.player.length, calls); assert.equal(h.sourceCalls.length, sources)
			assert.equal(h.facade.getCurrentMusic().headers.Authorization, 'prepared')
			assert.equal(h.facade.getCurrentMusic().cacheSourceId, 'prepared-source-v1-sha')
			const mutations = h.mutations.length
			h.emit('MediaItemTransition', { index: 1, item: prepared })
			h.emit('MediaItemTransition', { index: 0, item: previous })
			h.invalidate()
			assert.equal(h.mutations.length, mutations); assert.equal(h.facade.getCurrentMusic().id, 'b')
			assert(![...h.timers.values()].some((timer) => timer.delay === 8000))
			await flush(); assert.equal(h.stores.nowLyricState.getValue(), 'lyric:b')
		}
	}
})

await suite.check('explicit Stop/navigation retire active prepared identity before any subsequent invalidation or late event', async () => {
	for (const action of [(h) => h.facade.stop(), (h) => h.facade.observeNativeTransport('stop'),
		(h) => h.facade.skipToPrevious(), (h) => h.facade.skipToNext(), (h) => h.facade.play(song('c'), true)]) {
		const h = runtime(); await h.start(); await h.tick()
		h.player.activeIndex = 1; const stale = h.player.getActiveMediaItem()
		await action(h)
		const selected = h.facade.getCurrentMusic().id
		h.invalidate(); h.emit('MediaItemTransition', { index: 1, item: stale })
		assert.equal(h.facade.getCurrentMusic().id, selected)
		assert(!h.mutations.some(([operation]) => operation === 'remove' || operation === 'append'))
	}
})

await suite.check('Buffering owns stream priority, retires installed slot, and Ready schedules fresh preparation', async () => {
	const h = runtime(); await h.start(); await h.tick()
	h.player.state = 'buffering'; h.emit('PlaybackStateChanged', { state: 'buffering' })
	assert.equal(h.priority.at(-1), true); assert.equal(h.player.queue[1].extras.cymusic.placeholder, true)
	assert(![...h.timers.values()].some((timer) => timer.delay === 8000))
	h.player.state = 'ready'; h.emit('IsPlayingChanged', { isPlaying: true }); await h.tick()
	assert.equal(h.priority.at(-1), false); assert.equal(h.player.queue[1].extras.cymusic.placeholder, false)
})

await suite.check('URL completion alone does not clear priority during Buffering; local current also prepares next', async () => {
	const h = runtime(); await h.facade.setupTrackPlayer(); h.facade.addAll([song('a'), song('b')])
	const setItems = h.player.setMediaItems
	h.player.setMediaItems = (tracks) => { setItems(tracks); h.player.state = 'buffering' }
	h.player.play = () => { h.player.playing = false }
	await h.facade.play(song('a')); assert.equal(h.priority.at(-1), true)
	assert(![...h.timers.values()].some((timer) => timer.delay === 8000))
	const local = runtime(); await local.facade.setupTrackPlayer()
	local.facade.addAll([song('a', { url: 'file:///cache/a.mp3' }), song('b')])
	await local.facade.play(song('a', { url: 'file:///cache/a.mp3' })); await local.tick()
	assert.equal(local.preparations.length, 1)
})

await suite.check('SINGLE preparation has a new token/generation and stale same-media transition is rejected', async () => {
	const h = runtime(); await h.start(); h.facade.setRepeatMode('single'); await h.tick()
	const old = h.player.queue[0], next = h.player.queue[1]
	assert.equal(next.mediaId, old.mediaId); assert.notEqual(next.extras.cymusic.token, old.extras.cymusic.token)
	h.player.activeIndex = 1
	h.emit('MediaItemTransition', { index: 1, item: old }); assert.equal(h.player.activeIndex, 1)
	h.emit('MediaItemTransition', { index: 1, item: { ...next, extras: { cymusic: { ...next.extras.cymusic, preparedGeneration: -1 } } } })
	assert.equal(h.player.activeIndex, 1)
	h.emit('MediaItemTransition', { index: 1, item: next }); assert.equal(h.player.activeIndex, 0)
	assert.equal(h.player.queue[0], next); assert.equal(h.count('items'), 1)
})

await suite.check('resolve headers and actual provenance survive current, delayed auto-cache and manual cache', async () => {
	const h = runtime(); await h.facade.setupTrackPlayer()
	h.setResolver(async () => ({ url: 'https://audio.example/resolved', headers: { Authorization: 'resolved' },
		userAgent: 'source-agent', wasCached: false, cacheIdentity: { sourceId: 'actual-script-hash', quality: '320k' } }))
	await h.facade.play(song('a')); h.facade.setQuality('flac')
	await h.tick(5000); await h.facade.cacheAndImportMusic(song('a'))
	assert.equal(h.downloads.length, 2)
	for (const track of h.downloads) {
		assert.equal(track.headers.Authorization, 'resolved'); assert.equal(track.userAgent, 'source-agent')
		assert.equal(track.cacheSourceId, 'actual-script-hash'); assert.equal(track.cacheQuality, '320k')
	}
})

await suite.check('selected source state/persistence updates, overwrite uses latest list, deletion cannot resurrect on restart', async () => {
	const h = runtime(); await h.facade.setupTrackPlayer()
	const api = (id, script = 'module.exports.getMusicUrl = () => "url"') => ({ id, name: id, script, isSelected: false })
	h.stores.musicApiStore.setValue([api('one'), api('two')])
	await h.facade.setMusicApiAsSelectedById('one')
	assert.equal(h.stores.musicApiStore.getValue()[0].isSelected, true)
	assert.equal(h.persistence.get('music.musicApi')[1].isSelected, false); assert(h.lockCalls > 0)
	h.facade.addMusicApi(api('one', 'module.exports.getMusicUrl = () => "updated"'))
	const confirmation = h.calls.alerts.at(-1)
	h.stores.musicApiStore.setValue([...h.stores.musicApiStore.getValue(), api('three')])
	confirmation[2][0].onPress(); await flush()
	assert.equal(h.stores.musicApiSelectedStore.getValue().getMusicUrl(), 'updated')
	assert.equal(h.stores.musicApiStore.getValue().length, 3)
	const selecting = h.facade.setMusicApiAsSelectedById('two')
	h.facade.deleteMusicApiById('two'); await selecting
	assert.equal(h.stores.musicApiSelectedStore.getValue(), null)
	assert.equal(h.persistence.get('music.selectedMusicApi'), null)
	await h.facade.setupTrackPlayer(); assert.equal(h.stores.musicApiSelectedStore.getValue(), null)
})

await suite.check('reloadMusicApi executes its entire script under the resolver shared runtime lock', async () => {
	const h = runtime(), pending = deferred()
	const occupied = h.withSourceRuntimeLock(() => pending.promise)
	const reload = h.facade.reloadMusicApi({ id: 'test', name: 'test',
		script: 'runtimeProbe.push("executed"); module.exports.getMusicUrl = () => "locked"' }, true)
	await flush(); assert.equal(h.runtimeProbe.length, 0)
	pending.resolve(); await occupied
	assert.equal((await reload).getMusicUrl(), 'locked')
	assert.equal(h.runtimeProbe.length, 1)
})

await suite.check('bound-playlist local additions and removals compare platform plus id with safe legacy signature', () => {
	const h = runtime(), a = song('same'), b = song('same', { platform: 'wy' })
	const playlist = { id: 'bound', remoteBinding: { provider: 'qq', remoteId: '123' }, songs: [a] }
	h.stores.playListsStore.setValue([playlist])
	h.facade.addSongToStoredPlayList(playlist, b); h.facade.addSongToStoredPlayList(playlist, b)
	assert.equal(h.stores.playListsStore.getValue()[0].songs.length, 2)
	assert.equal(h.stores.playListsStore.getValue()[0].songs[1].localAdded, true)
	h.facade.deleteSongFromStoredPlayList(playlist, 'same')
	assert.equal(h.stores.playListsStore.getValue()[0].songs.length, 2)
	h.facade.deleteSongFromStoredPlayList(playlist, b)
	assert.equal(h.stores.playListsStore.getValue()[0].songs.length, 1)
})

await suite.check('SINGLE adopts only latest artwork from queue or current metadata, retaining prepared source and ownership', async () => {
	for (const fromQueue of [true, false]) {
		const h = runtime()
		await h.facade.setupTrackPlayer()
		const original = song('2010', { platform: 'wy', artwork: 'https://example.com/old.jpg' })
		h.facade.addAll([original])
		h.facade.setRepeatMode('single')
		await h.facade.play(original)
		await h.tick()
		const prepared = h.player.queue[1]
		const nextToken = prepared.extras.cymusic.token
		const artwork = 'https://example.com/confirmed.jpg'
		if (fromQueue) {
			h.facade.getPlayList()[0] = { ...original, artwork, url: 'https://example.com/stale.mp3',
				headers: { Authorization: 'wrong' }, cacheSourceId: 'wrong-cache' }
		} else assert.equal(h.facade.updateCurrentArtwork({ id: 2010, platform: '163' }, artwork), true)
		const items = h.count('items'), plays = h.count('play'), sources = h.sourceCalls.length
		h.transition()
		const adopted = h.facade.getCurrentMusic()
		assert.equal(adopted.artwork, artwork)
		assert.equal(adopted.url, 'file:///cache/2010.flac')
		assert.equal(adopted.headers.Authorization, 'prepared')
		assert.equal(adopted.cacheSourceId, 'prepared-source-v1-sha')
		assert.equal(adopted.cacheQuality, 'flac')
		assert.equal(h.player.queue[0].artworkUrl, artwork)
		assert.equal(h.player.queue[0].extras.cymusic.token, nextToken)
		assert.equal(h.player.progress.position, 2.75)
		assert.equal(h.count('items'), items)
		assert.equal(h.count('play'), plays)
		assert.equal(h.sourceCalls.length, sources)
		assert.equal(h.persistence.get('music.musicItem').artwork, artwork)
	}
})

await fixture.dispose()
suite.finish()
console.log('Mocks validate JS ownership and native queue commands; audible iOS/Android handoff requires device checks.')
