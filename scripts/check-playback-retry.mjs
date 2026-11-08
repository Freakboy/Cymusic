import { createFixture, item, write, uri } from './file-system-fixture.mjs'
import { assert, checks, deferred, flush, loadModule } from './native-services-fixture.mjs'
import { fileURLToPath } from 'node:url'

const fixture = createFixture(), suite = checks()
const song = (id = '003testmid0001', extra = {}) => item(id, undefined, { platform: 'tx', ...extra })
function runtime() {
	const h = fixture.runtime()
	Object.assign(h.player, h.load('node_modules/@rntp/player/src/events/index.ts'))
	h.stores.autoCacheLocalStore.setValue(false)
	const source = { id: 'test', name: 'test', getMusicUrl: async () => { throw new Error('offline') } }
	h.stores.musicApiSelectedStore.setValue(source)
	h.stores.musicApiStore.setValue([source])
	const resolver = h.load('src/player/MusicSourceResolver.ts')
	const facade = h.load('src/helpers/trackPlayerIndex.ts').default
	return { ...h, resolver, facade, source, async setup() {
		await facade.setupTrackPlayer()
		h.stores.musicApiSelectedStore.setValue(source); h.stores.musicApiStore.setValue([source])
		h.stores.autoCacheLocalStore.setValue(false)
	} }
}

function tracksList(h, id, queueId = 'owned') {
	const navigation = [], queueChanges = []
	const react = {
		memo: (component) => component, useCallback: (callback) => callback, useMemo: (compute) => compute(),
		createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
	}
	const { TracksList } = loadModule('src/components/TracksList.tsx', {
		react,
		'@/components/TracksListItem': 'TracksListItem',
		'@/constants/images': { unknownTrackImageUri: 'unknown' },
		'@/helpers/trackPlayerIndex': { __esModule: true, default: h.facade },
		'@/store/queue': { useQueue: () => ({ activeQueueId: queueId, setActiveQueueId: (id) => queueChanges.push(id) }) },
		'@/styles': { useUtilsStyles: () => ({}) },
		'@/utils/mediaItem': { isSameMediaItem: (a, b) => !!a && !!b && a.id === b.id && a.platform === b.platform },
		'@shopify/flash-list': { FlashList: 'FlashList' },
		'expo-router': { router: { navigate: (path) => navigation.push(path) } },
		'react-native': { Text: 'Text', View: 'View' },
		'expo-image': { Image: 'Image' },
		'@rntp/player': { useIsPlaying: () => h.player.isPlaying() },
		'./QueueControls': { QueueControls: 'QueueControls' },
	})
	const current = h.facade.getCurrentMusic()
	const tree = TracksList({ id, tracks: [current, song('other-list-item')], numsToPlay: 1 })
	const row = tree.props.renderItem({ item: current })
	return { click: () => row.props.onTrackSelect(current), navigation, queueChanges }
}

await suite.check('actual TracksList retries failed/error/timeout current before navigation without replacing either queue', async () => {
	for (const id of ['owned', 'other-list']) {
		for (const failure of ['resolve', 'native', 'timeout']) {
			const h = runtime(); await h.setup()
			const a = song(), b = song('003testmid0002')
			h.facade.addAll([a, b])
			if (failure !== 'resolve') h.source.getMusicUrl = async () => 'https://audio.test/original.mp3'
			await h.facade.play(a)
			if (failure === 'native') h.player.state = 'error'
			if (failure === 'timeout') {
				h.player.state = 'buffering'
				h.player.emit(h.player.Event.PlaybackStateChanged, { state: 'buffering' })
				await h.calls.timers.findLast((timer) => timer.delay === 45000).callback()
			}
			const queue = h.facade.getPlayList(), snapshot = JSON.stringify(queue), pending = deferred()
			let requests = 0
			h.source.getMusicUrl = async () => { requests++; return pending.promise }
			const ui = tracksList(h, id), click = ui.click()
			await new Promise(setImmediate)
			assert.equal(requests, 1, `${id}/${failure}: current click must resolve again`)
			assert.deepEqual(ui.navigation, [], 'Navigation follows the retry')
			assert.equal(h.facade.isCurrentTrackRetryable(), false, 'An active retry is pending')
			pending.resolve('https://audio.test/recovered.mp3'); await click
			assert.equal(h.facade.getCurrentMusic().url, 'https://audio.test/recovered.mp3')
			assert.deepEqual(ui.navigation, ['/player']); assert.deepEqual(ui.queueChanges, [])
			assert.equal(h.facade.getPlayList(), queue); assert.equal(JSON.stringify(queue), snapshot)
		}
	}
})

await suite.check('actual TracksList healthy/paused/pending current only navigates and never resumes or duplicates resolution', async () => {
	for (const id of ['owned', 'other-list']) {
		for (const status of ['healthy', 'paused', 'pending']) {
			const h = runtime(), pending = deferred(); let requests = 0
			assert.equal(h.facade.isCurrentTrackRetryable(), false, 'No current track cannot retry')
			h.source.getMusicUrl = async () => {
				requests++
				return status === 'pending' ? pending.promise : 'https://audio.test/healthy.mp3'
			}
			const playing = h.facade.play(song(undefined, { duration: 0 }))
			if (status === 'pending') await new Promise(setImmediate)
			else await playing
			if (status === 'paused') h.facade.pause()
			const queue = h.facade.getPlayList(), commands = h.calls.player.length
			assert.equal(h.facade.isCurrentTrackRetryable(), false)
			const ui = tracksList(h, id); await ui.click(); await ui.click()
			assert.deepEqual(ui.navigation, ['/player', '/player']); assert.deepEqual(ui.queueChanges, [])
			assert.equal(requests, 1); assert.equal(h.calls.player.length, commands)
			assert.equal(h.facade.getPlayList(), queue)
			pending.resolve('https://audio.test/pending.mp3'); await playing
		}
	}
})

await suite.check('failed production resolution never installs or persists fake audio; explicit current click resolves again', async () => {
	const h = runtime(), a = song()
	await h.facade.play(a)
	assert.equal(h.player.queue.length, 0)
	assert.equal(h.persistence.get('music.musicItem')?.url, undefined)
	h.source.getMusicUrl = async () => 'https://audio.test/recovered.mp3'
	await h.facade.play(h.facade.getCurrentMusic(), true)
	assert.equal(h.facade.getCurrentMusic().url, 'https://audio.test/recovered.mp3')
})

await suite.check('native Error current forcePlay resolves fresh instead of reinstalling retained URL', async () => {
	const h = runtime()
	h.source.getMusicUrl = async () => 'https://audio.test/old.mp3'
	await h.facade.play(song())
	h.player.state = 'error'
	h.source.getMusicUrl = async () => 'https://audio.test/new.mp3'
	await h.facade.play(h.facade.getCurrentMusic(), true)
	assert.equal(h.facade.getCurrentMusic().url, 'https://audio.test/new.mp3')
})

await suite.check('expired direct track.url is discarded on native failure with old headers and provenance', async () => {
	const h = runtime(); let calls = 0
	h.source.getMusicUrl = async () => { calls++; return { url: 'https://audio.test/fresh.mp3', headers: { Fresh: 'yes' } } }
	await h.facade.play(song(undefined, { url: 'https://audio.test/expired.mp3', headers: { Old: 'bad' },
		cacheSourceId: 'old-source', cacheQuality: 'flac' }))
	assert.equal(calls, 0)
	h.player.state = 'error'
	await h.facade.play(h.facade.getCurrentMusic())
	const current = h.facade.getCurrentMusic()
	assert.equal(current.url, 'https://audio.test/fresh.mp3')
	assert.deepEqual(current.headers, { Fresh: 'yes' })
	assert.notEqual(current.cacheSourceId, 'old-source'); assert.equal(current.cacheQuality, '128k')
})

await suite.check('confirmed rejection survives A B A and excludes repeated provider URL', async () => {
	const h = runtime(), a = song()
	h.source.getMusicUrl = async () => 'https://audio.test/rejected.mp3'
	await h.facade.play(a)
	const old = h.facade.getCurrentMusic()
	h.player.state = 'error'
	await h.facade.play(old, true)
	assert.equal(h.player.queue.length, 0)
	await h.facade.play(song('003testmid0002', { url: 'https://audio.test/b.mp3' }))
	await h.facade.play(old)
	assert.equal(h.player.queue.length, 0)
})

await suite.check('explicit retry calls provider and reinstalls its same stable URL after native failure', async () => {
	const h = runtime(); await h.setup()
	let requests = 0
	const url = 'https://audio.test/stable.mp3'
	h.source.getMusicUrl = async () => { requests++; return { url, headers: { Attempt: String(requests) } } }
	await h.facade.play(song())
	h.player.state = 'error'
	h.player.emit(h.player.Event.PlaybackError, { code: 'network' })
	await new Promise(setImmediate)
	assert.equal(requests, 2, 'Automatic retry must make one fresh provider request')
	assert.equal(h.player.queue.length, 0, 'Automatic retry still rejects the repeated bad URL')
	assert.equal(h.stores.trackSourceLoadingStore.getValue(), null)
	const installs = h.calls.player.filter(([op]) => op === 'items').length
	await h.facade.retryCurrentTrack()
	assert.equal(requests, 3, 'Explicit retry must call provider, never directly reuse track.url')
	assert.equal(h.player.queue.length, 2)
	assert.equal(h.player.queue[0].url.uri, url)
	assert.equal(h.player.queue[0].url.headers.Attempt, '3')
	assert.equal(h.calls.player.filter(([op]) => op === 'items').length, installs + 1)
	assert.equal(h.persistence.get('music.musicItem').url, url)
	h.player.state = 'error'
	h.player.emit(h.player.Event.PlaybackError, { code: 'network' })
	await new Promise(setImmediate)
	assert.equal(requests, 4, 'A later automatic retry does not inherit the explicit exemption')
	assert.equal(h.player.queue.length, 0)
})

await suite.check('A B A freshly resolves and isolates same URL during TTL, then can recover without restart', async () => {
	const h = runtime(), a = song(), url = 'https://audio.test/stable-return.mp3'
	let requests = 0, time = Date.now()
	const originalNow = Date.now
	Date.now = () => time
	try {
		h.source.getMusicUrl = async () => { requests++; return url }
		h.facade.addAll([a, song('b', { url: 'https://audio.test/b.mp3' })])
		h.resolver.invalidateSource(a, url)
		await h.facade.play(song('b', { url: 'https://audio.test/b.mp3' }))
		await h.facade.play({ ...a, url })
		assert.equal(requests, 1); assert.equal(h.player.queue.length, 0)
		time += 60001
		await h.facade.play({ ...a, url })
		assert.equal(requests, 2, 'TTL expiry permits provider result, but still does not reuse item.url')
		assert.equal(h.facade.getCurrentMusic().url, url); assert.equal(h.player.queue.length, 2)
	} finally { Date.now = originalNow }
})

await suite.check('failure LRU evicts old songs and old URLs while preserving a recently accessed rejection', async () => {
	const h = runtime(), url = 'https://audio.test/lru.mp3'
	const oldest = song('003testmid0003', { url }), recent = song('003testmid0002'), newest = song('003testmid0004')
	h.resolver.invalidateSource(oldest, url)
	h.resolver.invalidateSource(recent, url)
	for (let i = 0; i < 126; i++) h.resolver.invalidateSource(song(`filler-${i}`), url)
	h.source.getMusicUrl = async () => url
	await assert.rejects(h.resolver.resolveSource(recent), /无法获取可播放音源/)
	h.resolver.invalidateSource(newest, url)
	assert.equal((await h.resolver.resolveSource(oldest)).url, url, 'Least recently used song is evicted')
	await assert.rejects(h.resolver.resolveSource(recent), /无法获取可播放音源/)
	for (let i = 0; i < 2000; i++) h.resolver.invalidateSource(song(`bulk-${i}`), url)
	assert.equal((await h.resolver.resolveSource({ ...newest, url })).url, url)
	const many = song()
	for (let i = 0; i < 2000; i++) h.resolver.invalidateSource(many, `https://audio.test/rejected-${i}.mp3`)
	h.source.getMusicUrl = async () => 'https://audio.test/rejected-0.mp3'
	assert.equal((await h.resolver.resolveSource(many)).url, 'https://audio.test/rejected-0.mp3')
	h.source.getMusicUrl = async () => 'https://audio.test/rejected-1999.mp3'
	await assert.rejects(h.resolver.resolveSource(many), /无法获取可播放音源/)
})

await suite.check('remote download quarantine is bounded and expires, while confirmed corrupt local files stay quarantined', async () => {
	const h = fixture.runtime({ realCache: true }), cache = h.load('src/player/CacheManager.ts')
	const first = song('download-first'), recent = song('download-recent'), next = song('download-next')
	const address = (a) => cache.getCacheFileUri(cache.getLocalFilePath(a))
	let time = Date.now()
	const originalNow = Date.now
	Date.now = () => time
	try {
		await write(fileURLToPath(address(first)), 'complete download')
		cache.rejectCacheFile('https://audio.test/temporary-network-failure', first)
		cache.rejectCacheFile('https://audio.test/temporary-network-failure', recent)
		for (let i = 0; i < 126; i++) cache.rejectCacheFile('https://audio.test/bad', song(`download-filler-${i}`))
		assert.equal(await cache.isUsableCacheFile(address(recent)), false)
		cache.rejectCacheFile('https://audio.test/bad', next)
		assert.equal(await cache.isUsableCacheFile(address(first)), true, 'Remote quarantine evicts least recently used')
		assert.equal(await cache.isUsableCacheFile(address(recent)), false)
		for (let i = 0; i < 2000; i++) cache.rejectCacheFile('https://audio.test/bad', song(`download-bulk-${i}`))
		await write(fileURLToPath(address(recent)), 'complete download')
		assert.equal(await cache.isUsableCacheFile(address(recent)), true)
		cache.rejectCacheFile('https://audio.test/bad', recent)
		assert.equal(await cache.isUsableCacheFile(address(recent)), false)
		time += 60001
		assert.equal(await cache.isUsableCacheFile(address(recent)), true, 'Transient remote rejection expires')
		cache.rejectCacheFile(address(recent))
		time += 60001
		assert.equal(await cache.isUsableCacheFile(address(recent)), false, 'Native-confirmed local corruption never inherits remote TTL')
	} finally { Date.now = originalNow }
})

await suite.check('negative QQ match is retried after failed resolution without waiting TTL', async () => {
	let searches = 0
	const h = fixture.runtime({ moduleOverrides: { axios: { post: async () => {
		searches++
		return { data: { code: 0, req_1: { code: 0, data: { body: { song: { list: [] } } } } } }
	} } } })
	const source = { id: 'test', getMusicUrl: async () => 'https://audio.test/a.mp3' }
	h.stores.musicApiSelectedStore.setValue(source); h.stores.musicApiStore.setValue([source])
	const resolver = h.load('src/player/MusicSourceResolver.ts'), a = song('external', { platform: 'wy' })
	await resolver.resolveSource(a).catch(() => {})
	await resolver.resolveSource(a).catch(() => {})
	assert.equal(searches, 2)
})

await suite.check('native errors retry once with fresh URL, stop without skipping, and explicit retry resets budget', async () => {
	const h = runtime(); await h.setup()
	let calls = 0
	h.source.getMusicUrl = async () => `https://audio.test/attempt-${++calls}.mp3`
	await h.facade.play(song())
	const error = () => { h.player.state = 'error'; h.player.emit(h.player.Event.PlaybackError, { code: 'network' }) }
	error(); error(); await new Promise(setImmediate)
	assert.equal(calls, 2)
	assert.equal(h.facade.getCurrentMusic().url, 'https://audio.test/attempt-2.mp3')
	error(); await flush()
	assert.equal(calls, 2); assert.equal(h.player.queue.length, 0)
	assert.equal(h.persistence.get('music.musicItem'), null)
	assert.equal(h.stores.trackSourceLoadingStore.getValue(), null)
	await h.facade.retryCurrentTrack()
	assert.equal(calls, 3)
})

await suite.check('zero duration Ready/live and paused resume preserve source; healthy forcePlay stays bounded', async () => {
	const h = runtime(); await h.setup()
	let calls = 0
	h.source.getMusicUrl = async () => { calls++; return 'https://audio.test/live' }
	await h.facade.play(song(undefined, { isLiveStream: true, duration: 0 }))
	const items = () => h.calls.player.filter(([name]) => name === 'items').length
	const before = items()
	h.facade.pause(); await h.facade.play()
	assert.equal(items(), before); assert.equal(calls, 1)
	await h.facade.play(null, true)
	assert.equal(calls, 1); assert.equal(h.player.progress.duration, 0)
	h.player.emit(h.player.Event.PlaybackStateChanged, { state: 'ready' })
	assert.equal(h.player.queue.length, 2)
})

await suite.check('buffering deadline releases failed load without condemning URL; explicit retry can use it again', async () => {
	const h = runtime(); await h.setup()
	h.source.getMusicUrl = async () => 'https://audio.test/slow.mp3'
	await h.facade.play(song())
	h.player.state = 'buffering'
	h.player.emit(h.player.Event.PlaybackStateChanged, { state: 'buffering' })
	const timer = h.calls.timers.findLast((timer) => timer.delay === 45000)
	assert(timer); await timer.callback(); await flush()
	assert.equal(h.player.queue.length, 0)
	assert.equal(h.stores.trackSourceLoadingStore.getValue(), null)
	await h.facade.retryCurrentTrack()
	assert.equal(h.facade.getCurrentMusic().url, 'https://audio.test/slow.mp3')
})

await suite.check('retired buffering and completed source timers cannot cancel B after Pause or Stop', async () => {
	for (const action of ['pause', 'stop']) {
		const h = runtime(); await h.setup()
		h.facade.addAll([song(), song('b', { url: 'https://audio.test/b.mp3' })])
		h.source.getMusicUrl = async () => 'https://audio.test/a.mp3'
		await h.facade.play(song())
		const sourceTimer = h.calls.timers.find((timer) => timer.delay === 30000)
		h.player.state = 'buffering'
		h.player.emit(h.player.Event.PlaybackStateChanged, { state: 'buffering' })
		const bufferingTimer = h.calls.timers.findLast((timer) => timer.delay === 45000)
		h.facade[action]()
		await bufferingTimer.callback(); await flush()
		assert.equal(h.facade.isCurrentTrackRetryable(), false, 'Pause/Stop retains a resolved source')
		await h.facade.play(song('b', { url: 'https://audio.test/b.mp3' }))
		const queue = h.player.queue, current = h.facade.getCurrentMusic()
		const commands = h.calls.player.length, persisted = h.persistence.get('music.musicItem')
		assert.equal(current.id, 'b'); assert.equal(h.player.isPlaying(), true)
		// Invoke even cleared callbacks to simulate a timer already queued by the runtime.
		await bufferingTimer.callback(); await sourceTimer.callback(); await flush()
		assert.equal(h.player.queue, queue); assert.equal(h.facade.getCurrentMusic(), current)
		assert.equal(h.calls.player.length, commands); assert.equal(h.player.isPlaying(), true)
		assert.deepEqual(h.persistence.get('music.musicItem'), persisted)
	}
})

await suite.check('an old pending source timeout cannot clear B or its loading token after Pause or Stop', async () => {
	for (const action of ['pause', 'stop']) {
		const h = runtime(), pending = deferred()
		h.source.getMusicUrl = async () => pending.promise
		const old = h.facade.play(song())
		await new Promise(setImmediate)
		const timer = h.calls.timers.find((timer) => timer.delay === 30000)
		h.facade[action]()
		await h.facade.play(song('b', { url: 'https://audio.test/b.mp3' }))
		const queue = h.player.queue, current = h.facade.getCurrentMusic(), commands = h.calls.player.length
		assert.equal(current.id, 'b'); assert.equal(h.player.isPlaying(), true)
		await timer.callback(); await old
		assert.equal(h.player.queue, queue); assert.equal(h.facade.getCurrentMusic(), current)
		assert.equal(h.calls.player.length, commands); assert.equal(h.player.isPlaying(), true)
		assert.equal(h.stores.trackSourceLoadingStore.getValue(), null)
		pending.resolve('https://audio.test/late-a.mp3'); await new Promise(setImmediate)
		assert.equal(h.facade.getCurrentMusic(), current)
	}
})

await suite.check('whole source deadline includes stuck local/cache probes and permits later user retry', async () => {
	const gate = deferred()
	const h = fixture.runtime({ moduleOverrides: { '@/helpers/localFile': {
		resolveLocalFile: () => gate.promise,
	} } })
	const resolver = h.load('src/player/MusicSourceResolver.ts')
	const result = resolver.resolveSource(song()).catch((error) => error)
	await flush()
	await h.calls.timers.find((timer) => timer.delay === 30000).callback()
	assert.match((await result).message, /超时/)
	gate.resolve({ status: 'nonlocal' }); await flush()
	assert.equal(h.player.queue.length, 0)
})

await suite.check('pending fresh resolution respects Pause, Stop and later selection ownership', async () => {
	for (const action of ['pause', 'stop', 'select']) {
		const h = runtime(), pending = deferred()
		h.source.getMusicUrl = async () => pending.promise
		const playing = h.facade.play(song())
		await flush()
		if (action === 'select') await h.facade.play(song('b', { url: 'https://audio.test/b.mp3' }))
		else h.facade[action]()
		pending.resolve('https://audio.test/late.mp3'); await playing
		assert.equal(h.stores.trackSourceLoadingStore.getValue(), null)
		if (action === 'select') assert.equal(h.facade.getCurrentMusic().id, 'b')
		else {
			assert.equal(h.player.isPlaying(), false)
			assert.equal(h.stores.playbackIntentStore.getValue(), action)
		}
	}
})

await suite.check('explicit retry keeps a valid local file and does not call provider', async () => {
	const path = `${fixture.documents}/importedLocalMusic/retry.mp3`
	await write(path, 'local audio fixture')
	const h = runtime(); let calls = 0
	h.source.getMusicUrl = async () => { calls++; throw new Error('must stay local') }
	await h.facade.play(song('local', { url: uri(path), platform: 'local' }))
	await h.facade.retryCurrentTrack()
	assert.equal(h.facade.getCurrentMusic().url, uri(path)); assert.equal(calls, 0)
})

await suite.check('confirmed nonempty corrupt cache is quarantined; valid local cache still works', async () => {
	const h = fixture.runtime({ realCache: true })
	const cache = h.load('src/player/CacheManager.ts')
	const resolver = h.load('src/player/MusicSourceResolver.ts')
	const a = song(), source = { id: 'cache-test', getMusicUrl: async () => 'https://audio.test/new.mp3' }
	h.stores.musicApiSelectedStore.setValue(source); h.stores.musicApiStore.setValue([source])
	const path = cache.getLocalFilePath(a), url = cache.getCacheFileUri(path)
	await write(fileURLToPath(url), 'not actually playable audio')
	assert.equal((await resolver.resolveSource(a)).wasCached, true)
	resolver.invalidateSource({ ...a, url }, url)
	assert.equal(await cache.findCachedPath(a), undefined)
	assert.equal((await resolver.resolveSource({ ...a, url })).url, 'https://audio.test/new.mp3')
	assert.equal((await resolver.resolveSource({ ...a, url }, { fresh: true })).url, 'https://audio.test/new.mp3')
	assert.equal(await cache.isUsableCacheFile(url), false)
})

await suite.check('confirmed remote failure cancels an in-flight cache writer even if native download completes late', async () => {
	const h = fixture.runtime({ realCache: true }), started = deferred(), finish = deferred()
	const cache = h.load('src/player/CacheManager.ts')
	const resolver = h.load('src/player/MusicSourceResolver.ts')
	const a = song('cache-race', { url: 'https://audio.test/rejected-download.mp3' })
	h.hooks.download = async ({ fileUri }) => {
		started.resolve(); await finish.promise
		await write(fileURLToPath(fileUri), 'late download bytes')
		return { status: 200, uri: fileUri }
	}
	const result = cache.downloadToCache(a).catch((error) => error)
	await started.promise
	resolver.invalidateSource(a, a.url)
	finish.resolve()
	assert.match((await result).message, /CACHE_CANCELLED/)
	assert.equal(await cache.findCachedPath(a), undefined)
})

await fixture.dispose()
suite.finish()
