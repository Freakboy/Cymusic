// Run with node scripts/check-carplay.mjs. Executes production TS with controlled native I/O.
import fs from 'node:fs'
import { assert, checks, deferred, flush, loadModule, root } from './native-services-fixture.mjs'

const suite = checks()
const song = (id) => ({ id, platform: 'tx', title: `Song ${id}`, artist: 'Artist', album: `Album ${id}` })
const state = (value) => ({ getValue: () => value, setValue: (next) => { value = next } })
const plain = (value) => JSON.parse(JSON.stringify(value))

function runtime({ ios = true, nativeAvailable = true } = {}) {
	const listeners = new Set(), storage = new Set(), appState = new Set(), timers = new Set()
	const snapshots = [], plays = [], completions = [], metadata = [], errors = []
	const values = new Map(), current = state(song('a')), lyrics = state(null), lists = state(null)
	let queue = [current.getValue()], active = current.getValue(), position = 0, pending = null, requires = 0
	let write = async () => {}, read = async () => pending, play = async (track) => { current.setValue(track); active = track }
	const subscribe = (set, callback) => { set.add(callback); return { remove: () => set.delete(callback) } }
	const persist = {
		get: (key) => values.get(key) ?? null,
		set: (key, value) => { values.set(key, value); for (const callback of storage) callback(key) },
	}
	const native = {
		setCarPlaySnapshot: async (json) => { snapshots.push(JSON.parse(json)); await write(json) },
		getPendingCarPlaySelection: () => read(),
		completeCarPlaySelection: async (id, playing) => {
			completions.push([id, playing]); if (pending?.id === id) pending = null
		},
		addListener: (name, callback) => { assert.equal(name, 'onCarPlaySelect'); return subscribe(listeners, callback) },
	}
	const api = loadModule('src/helpers/carPlay.ts', {
		expo: { requireOptionalNativeModule: (name) => {
			requires++; assert.equal(name, 'CyMusicNowPlaying'); return nativeAvailable ? native : null
		} },
		'react-native': { Platform: { OS: ios ? 'ios' : 'android' }, AppState: {
			addEventListener: (name, callback) => { assert.equal(name, 'change'); return subscribe(appState, callback) },
		} },
		'@rntp/player': {
			getActiveMediaItem: () => active,
			updateMetadata: (...args) => { metadata.push(plain(args)); assert.equal(args[0], 0) },
		},
		'@/helpers/trackPlayerIndex': {
			getPlayList: () => queue, getCurrentMusic: current.getValue,
			isCurrentNativeItem: (item) => !!item && item === current.getValue(),
			getProgress: () => ({ position }),
			playWithReplacePlayList: async (track, tracks) => { plays.push(plain([track, tracks])); await play(track, tracks) },
		},
		'@/player/PlayerStore': { currentMusicStore: current, nowLyricState: lyrics, playListsStore: lists },
		'@/store/PersistStatus': persist,
		'@/store/getOrCreateMMKV': (id) => {
			assert.equal(id, 'appPersistStatus'); return { addOnValueChangedListener: (callback) => subscribe(storage, callback) }
		},
		'@/helpers/logger': { logError: (...args) => errors.push(args) },
		'@/utils/lrcParser': loadModule('src/utils/lrcParser.ts', {}).default,
	}, {
		setInterval: (callback, delay) => { assert.equal(delay, 500); timers.add(callback); return callback },
		clearInterval: (callback) => timers.delete(callback),
	})
	return {
		...api, persist, current, lyrics, lists, snapshots, plays, completions, metadata, errors,
		listeners, storage, appState, timers,
		get requires() { return requires }, get pending() { return pending },
		setWrite: (action) => { write = action }, setRead: (action) => { read = action },
		setPlay: (action) => { play = action }, setQueue: (tracks) => { queue = tracks },
		setActive: (track) => { active = track }, setPosition: (next) => { position = next },
		request(id, extra = {}) {
			pending = { id, queueJSON: JSON.stringify([song(id)]), index: 0, createdAt: Date.now() / 1000, ...extra }
			return pending
		},
		emit: () => { for (const callback of listeners) callback() },
		foreground: () => { for (const callback of appState) callback('active') },
		tick: () => { for (const callback of timers) callback() },
	}
}

await suite.check('library snapshot: persisted fallback, live stores, storage microtask and deduplication', async () => {
	const h = runtime()
	h.persist.set('music.favorites', [song('fav')])
	h.persist.set('music.playLists', [{ id: 'saved', title: 'Saved', songs: [song('s')] }])
	const bridge = await h.startCarPlayBridge(); await flush()
	assert.deepEqual(h.snapshots[0], [
		{ id: 'favorites', title: '\u6536\u85cf', tracks: [song('fav')] },
		{ id: 'queue', title: '\u5f53\u524d\u961f\u5217', tracks: [song('a')] },
		{ id: 'playlist:saved', title: 'Saved', tracks: [song('s')] },
	])
	await bridge.sync(); assert.equal(h.snapshots.length, 1)
	h.persist.set('music.playLists', [{ id: 'live', title: 'Live', songs: [] }])
	h.lists.setValue([{ id: 'live', title: 'Live', songs: [song('live')] }])
	await flush(); assert.equal(h.snapshots.at(-1)[2].tracks[0].id, 'live')
	h.persist.set('music.play-list', [song('q')]); h.setQueue([song('q')]); await flush()
	assert.equal(h.snapshots.at(-1)[1].tracks[0].id, 'q')
	h.persist.set('music.favorites', []); await flush(); assert.deepEqual(h.snapshots.at(-1)[0].tracks, [])
	const count = h.snapshots.length; h.persist.set('other', true); h.foreground(); await flush()
	assert.equal(h.snapshots.length, count); bridge.dispose()
})

await suite.check('repeated start shares readiness and rejection; retry creates exactly one new bridge', async () => {
	const h = runtime(), gate = deferred()
	h.setWrite(() => gate.promise)
	const first = h.startCarPlayBridge(), second = h.startCarPlayBridge()
	let settled = false; void second.then(() => { settled = true }, () => { settled = true })
	await flush(); assert.equal(settled, false, 'Second start must wait for the same initialization')
	const results = Promise.allSettled([first, second]); gate.reject(new Error('snapshot failure'))
	assert.deepEqual((await results).map((entry) => entry.status), ['rejected', 'rejected'])
	assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0)
	h.setWrite(async () => {})
	const [a, b] = await Promise.all([h.startCarPlayBridge(), h.startCarPlayBridge()])
	assert.equal(a, b); assert.equal(h.requires, 2); a.dispose()
})

await suite.check('start does not await pending playback or block splash readiness', async () => {
	const h = runtime(), gate = deferred(); h.request('cold'); h.setPlay(() => gate.promise)
	const bridge = await h.startCarPlayBridge(); await flush()
	assert.equal(h.plays.length, 1); assert.equal(h.completions.length, 0)
	gate.resolve(); await flush(); bridge.dispose()
})

await suite.check('latest pending survives older completion; duplicate wakeups do not replay', async () => {
	const h = runtime(), gate = deferred(); const bridge = await h.startCarPlayBridge(); await flush()
	h.setPlay(async (track) => { if (track.id === 'old') await gate.promise; h.current.setValue(track); h.setActive(track) })
	h.request('old'); h.emit(); h.emit(); await flush()
	assert.equal(h.plays.length, 1)
	h.request('intermediate'); h.emit(); h.request('latest'); h.emit()
	gate.resolve(); await flush(); await bridge.drain()
	assert.equal(h.current.getValue().id, 'latest'); assert.equal(h.pending, null)
	assert.deepEqual(h.plays.map(([track]) => track.id), ['old', 'latest'])
	assert.equal(h.completions.filter(([id]) => id === 'old').length, 1); bridge.dispose()
})

await suite.check('overlapping pending reads cannot replay an older tap after the latest one', async () => {
	const h = runtime(); const bridge = await h.startCarPlayBridge(); await flush()
	const gate = deferred(), old = h.request('old'); let reads = 0
	h.setRead(() => ++reads === 1 ? gate.promise : Promise.resolve(h.pending))
	const first = bridge.drain(); h.request('latest'); const second = bridge.drain(); await flush()
	gate.resolve(old); await Promise.all([first, second]); await flush()
	assert.equal(h.current.getValue().id, 'latest'); bridge.dispose()
})

await suite.check('missing-platform legacy selection normalizes the full QQ queue and preserves unknown/explicit origins', async () => {
	const h = runtime(); const bridge = await h.startCarPlayBridge(); await flush()
	const mid = '0039MnYb0qxYhV'
	const tracks = [
		{ id: mid, title: 'Legacy QQ by id', artist: 'Artist' },
		{ id: '123456', songmid: mid, title: 'Legacy QQ by mid', artist: 'Artist' },
		{ id: mid, platform: 'wy', title: 'Explicit other origin', artist: 'Artist' },
		{ id: mid, platform: 'tx', title: 'Explicit tx', artist: 'Artist' },
		{ id: mid, platform: 'QQ', title: 'Explicit QQ', artist: 'Artist' },
		{ id: '123456', title: 'Unknown numeric id', artist: 'Artist' },
		{ id: 'unknown', songmid: 'not-a-qq-mid', title: 'Unknown mid', artist: 'Artist' },
	]
	const expected = tracks.map((track, index) => index < 2 ? { ...track, platform: 'QQ' } : track)
	h.setPlay(async (track, queue) => {
		assert(queue.includes(track), 'Selected item must come from the normalized queue')
		h.current.setValue(track); h.setActive(track)
	})
	// Exercise each selected index, including same-ID songs from different platforms.
	for (let index = 0; index < tracks.length; index++) {
		h.request(`legacy-${index}`, { queueJSON: JSON.stringify(tracks), index })
		await bridge.drain()
		assert.deepEqual(h.plays.at(-1), [expected[index], expected])
		assert.deepEqual(h.completions.at(-1), [`legacy-${index}`, true])
	}
	assert.equal(h.errors.length, 0); bridge.dispose()
})

await suite.check('invalid queue entries reject the whole selection without filtering or shifting its index', async () => {
	const h = runtime(); const bridge = await h.startCarPlayBridge(); await flush()
	const legacy = { id: '0039MnYb0qxYhV', title: 'Legacy QQ', artist: 'Artist' }
	for (const invalid of [null, 42, 'bad', {}, { id: 123 }, { id: 'bad', platform: 42 }, { id: 'bad', platform: null }]) {
		for (const index of [0, 1, 2]) {
			h.request('invalid-entry', { queueJSON: JSON.stringify([legacy, invalid, song('last')]), index })
			await bridge.drain()
			assert.deepEqual(h.completions.at(-1), ['invalid-entry', false])
			assert.equal(h.pending, null)
		}
	}
	assert.equal(h.plays.length, 0); bridge.dispose()
})

await suite.check('invalid/expired requests are completed false without playback; failures are reported', async () => {
	const h = runtime(); const bridge = await h.startCarPlayBridge(); await flush()
	for (const extra of [
		{ createdAt: Date.now() / 1000 - 601 }, { createdAt: Date.now() / 1000 + 61 }, { createdAt: NaN },
		{ queueJSON: '{' }, { queueJSON: '{}' }, { queueJSON: '[null]' },
		{ queueJSON: '[{"id":1,"platform":"tx"}]' }, { queueJSON: '[{"id":"a","platform":false}]' },
		{ index: -1 }, { index: 0.5 }, { index: 1 },
	]) {
		h.request('invalid', extra); await bridge.drain(); assert.equal(h.pending, null)
		assert.deepEqual(h.completions.at(-1), ['invalid', false])
	}
	assert.equal(h.plays.length, 0)
	h.setPlay(async () => { throw new Error('play failed') }); h.request('failure'); await bridge.drain()
	assert.deepEqual(h.completions.at(-1), ['failure', false]); assert(h.errors.length >= 2)
	bridge.dispose()
})

await suite.check('title projection uses real LRC positions/delay, deduplicates lines and restores on setting changes', async () => {
	const h = runtime(); h.persist.set('music.bluetoothLyrics', true)
	h.lyrics.setValue('[00:01]First\n[00:03]Second')
	const bridge = await h.startCarPlayBridge(); h.setPosition(1); h.tick(); h.tick()
	assert.deepEqual(h.metadata, [[0, { title: 'First', artist: 'Song a - Artist', albumTitle: 'Album a' }]])
	h.setPosition(3); h.tick(); assert.equal(h.metadata.at(-1)[1].title, 'Second')
	h.persist.set('lyric.delaySeconds', 2); h.tick(); assert.equal(h.metadata.at(-1)[1].title, 'First')
	h.persist.set('music.bluetoothLyrics', false); assert.equal(h.metadata.at(-1)[1].title, 'Song a')
	assert.deepEqual(h.metadata.at(-1)[1], { title: 'Song a', artist: 'Artist', albumTitle: 'Album a' })
	const count = h.metadata.length; h.tick(); await bridge.setLyricTitleEnabled(false); assert.equal(h.metadata.length, count)
	await bridge.setLyricTitleEnabled(true); assert.equal(h.persist.get('music.bluetoothLyrics'), true)
	h.tick(); assert.equal(h.metadata.at(-1)[1].title, 'First')
	bridge.dispose(); assert.equal(h.metadata.at(-1)[1].title, 'Song a')
	assert.deepEqual(h.metadata.at(-1)[1], { title: 'Song a', artist: 'Artist', albumTitle: 'Album a' })
})

await suite.check('Bluetooth second line carries song and artist during intros, lyrics and same-line track changes without mutating songs', async () => {
	const h = runtime(); h.persist.set('music.bluetoothLyrics', true)
	const first = h.current.getValue(), snapshot = plain(first)
	h.lyrics.setValue('[00:03]Shared lyric')
	const bridge = await h.startCarPlayBridge(); h.tick()
	assert.deepEqual(h.metadata.at(-1)[1], { title: 'Song a', artist: 'Song a - Artist', albumTitle: 'Album a' })
	h.setPosition(3); h.tick()
	assert.deepEqual(h.metadata.at(-1)[1], { title: 'Shared lyric', artist: 'Song a - Artist', albumTitle: 'Album a' })
	const next = song('b'); h.setActive(next); h.tick()
	assert.equal(h.metadata.at(-1)[1].artist, 'Song a - Artist', 'Do not write to an unadopted native item')
	h.current.setValue(next); h.tick()
	assert.deepEqual(h.metadata.at(-1)[1], { title: 'Shared lyric', artist: 'Song b - Artist', albumTitle: 'Album b' })
	h.lyrics.setValue(null); h.tick()
	assert.deepEqual(h.metadata.at(-1)[1], { title: 'Song b', artist: 'Song b - Artist', albumTitle: 'Album b' })
	await bridge.setLyricTitleEnabled(false)
	assert.deepEqual(h.metadata.at(-1)[1], { title: 'Song b', artist: 'Artist', albumTitle: 'Album b' })
	assert.deepEqual(plain(first), snapshot)
	assert.deepEqual(plain(next), song('b'))
	bridge.dispose()
})

await suite.check('missing artist or album leaves no dangling separator or stale album and disabling remains idempotent', async () => {
	const h = runtime(); h.persist.set('music.bluetoothLyrics', true)
	const track = { ...song('a'), artist: '', album: undefined }
	h.current.setValue(track); h.setActive(track); h.lyrics.setValue('[00:00]Line')
	const bridge = await h.startCarPlayBridge(); h.tick()
	assert.deepEqual(h.metadata.at(-1)[1], { title: 'Line', artist: 'Song a', albumTitle: '' })
	await bridge.setLyricTitleEnabled(false)
	assert.deepEqual(h.metadata.at(-1)[1], { title: 'Song a', artist: '', albumTitle: '' })
	const count = h.metadata.length; h.tick(); bridge.dispose()
	assert.equal(h.metadata.length, count)
})

await suite.check('track transition never projects old lyrics into native next slot; empty/new lyrics reset parser', async () => {
	const h = runtime(); h.persist.set('music.bluetoothLyrics', true); h.lyrics.setValue('[00:00]Old')
	const bridge = await h.startCarPlayBridge(); h.tick(); const count = h.metadata.length
	h.setActive(song('b')); h.tick(); assert.equal(h.metadata.length, count)
	h.current.setValue(song('b')); h.lyrics.setValue(null); h.tick(); assert.equal(h.metadata.length, count)
	h.setActive(h.current.getValue()); h.tick(); assert.equal(h.metadata.at(-1)[1].title, 'Song b')
	h.lyrics.setValue('[00:00]New'); h.tick(); assert.equal(h.metadata.at(-1)[1].title, 'New')
	h.setActive(song('c')); bridge.dispose(); assert.equal(h.metadata.at(-1)[1].title, 'New')
})

await suite.check('dispose removes subscriptions/timers, ignores late reads and allows a new singleton', async () => {
	const h = runtime(); const bridge = await h.startCarPlayBridge(); await flush()
	const gate = deferred(), event = h.request('late'); h.setRead(() => gate.promise)
	const drain = bridge.drain(); bridge.dispose(); bridge.dispose(); gate.resolve(event); await drain
	assert.equal(h.plays.length, 0)
	for (const set of [h.listeners, h.storage, h.appState, h.timers]) assert.equal(set.size, 0)
	const count = h.snapshots.length; await bridge.sync(); await bridge.drain(); await bridge.setLyricTitleEnabled(true)
	assert.equal(h.snapshots.length, count); assert.equal(h.persist.get('music.bluetoothLyrics'), null)
	h.setRead(async () => null)
	const next = await h.startCarPlayBridge(); assert.notEqual(next, bridge); assert.equal(h.listeners.size, 1)
	bridge.dispose(); assert.equal(await h.startCarPlayBridge(), next); next.dispose()
})

await suite.check('dispose during playback suppresses success navigation and never drains a later request', async () => {
	const h = runtime(), gate = deferred(); const bridge = await h.startCarPlayBridge(); await flush()
	h.setPlay(async (track) => { await gate.promise; h.current.setValue(track); h.setActive(track) })
	h.request('playing'); const drain = bridge.drain(); await flush()
	h.request('later'); h.emit(); bridge.dispose(); gate.resolve(); await drain
	assert.deepEqual(h.completions, [['playing', false]])
	assert.equal(h.pending.id, 'later'); assert.equal(h.plays.length, 1)
})

await suite.check('missing native module and non-iOS remain inert', async () => {
	for (const options of [{ ios: false }, { nativeAvailable: false }]) {
		const h = runtime(options); const bridge = await h.startCarPlayBridge(); await bridge.drain(); await bridge.sync()
		assert.equal(h.snapshots.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0)
		bridge.dispose()
	}
})

// CarPlay/UIKit cannot execute in Node. Keep a source-level guard for reload wiring;
// actual CPListTemplate rendering and scene lifecycle still need an iOS device/simulator.
await suite.check('Swift reload preserves each list offset and playlist-directory offset', () => {
	const source = fs.readFileSync(`${root}/ios/CyMusic/AppDelegate.swift`, 'utf8')
	const reload = source.slice(source.indexOf('private func reload()'), source.indexOf('private func emptyItem()'))
	assert.match(reload, /songItems\(id: id, offset: (?:self\.)?listOffsets\[id\] \?\? 0\)/)
	assert.match(reload, /playlistItems\(offset: (?:self\.)?playlistOffset\)/)
	assert.match(source, /listOffsets\[id\] = offset/)
	assert.match(source, /playlistOffset = offset/)
	for (const count of ['stored', 'tracks']) {
		assert(source.includes(`let offset = max(0, min(offset, max(0, ${count}.count - 1) / pageSize * pageSize))`),
			`${count} offset must clamp to the last valid page when the snapshot shrinks`)
	}
})

suite.finish()
