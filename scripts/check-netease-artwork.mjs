import fs from 'node:fs'
import CryptoJS from 'crypto-js'
import { assert, checks, deferred, flush, loadModule } from './native-services-fixture.mjs'
import { fakeClock } from './request-fixture.mjs'

const { check, finish } = checks()
const remote = loadModule('src/helpers/userApi/remotePlaylist.ts', {
	'expo/fetch': { fetch: () => { throw new Error('Unexpected fetch') } }, 'crypto-js': CryptoJS,
}, { URL })

await check('empty modern al does not hide legacy album metadata and artwork', () => {
	const song = remote.normalizeNeteaseSong({ id: 2010, al: {}, album: { name: 'legacy', picUrl: 'https://p1.music.126.net/legacy.jpg' } })
	assert.equal(song.album, 'legacy')
	assert.ok(song.artwork.endsWith('/legacy.jpg'))
})
await check('legacy missing artwork rows have a repair path even without Image onError', () => {
	const row = fs.readFileSync('src/components/TracksListItem.tsx', 'utf8')
	assert.match(row, /useTrackArtwork\(/)
	assert.match(row, /onError=/)
	assert.match(row, /onLoad=/)
	const hook = fs.readFileSync('src/hooks/useTrackArtwork.ts', 'utf8')
	assert.match(hook, /useEffect/)
	assert.match(hook, /visible/)
})

const images = loadModule('src/utils/imageUtils.ts', {}, { URL })
const track = (id = '2010', artwork = '', platform = 'Netease') => ({ id, platform, artwork })
const plain = value => JSON.parse(JSON.stringify(value))
function fixture(fetcher = async () => ({ code: 200, songs: [{ id: 2010, al: {}, album: { picId: '109951170012345678' } }] })) {
	const clock = fakeClock()
	const calls = []
	const writes = []
	const stored = new Map()
	const state = value => ({ getValue: () => value, setValue: next => { value = next } })
	const stores = { playListsStore: state([]), importedLocalMusicStore: state([]), currentMusicStore: state(null) }
	let queue = []
	const remote = loadModule('src/helpers/userApi/remotePlaylist.ts', {
		'expo/fetch': { fetch: async (url, options) => {
			calls.push({ url, options })
			const data = await fetcher(url, options)
			return typeof data.text === 'function' ? data : { ok: true, text: async () => JSON.stringify(data) }
		} }, 'crypto-js': CryptoJS,
	}, { URL, ...clock })
	const helper = loadModule('src/helpers/neteaseArtwork.ts', {
		'@/player/PlayerStore': stores,
		'@/store/PersistStatus': { get: key => stored.get(key), set: (key, value) => { stored.set(key, value); writes.push({ key, value }) } },
		'@/store/playList': { getPlayList: () => queue, setPlayList: value => { queue = value; writes.push({ key: 'music.play-list', value }) } },
		'@/utils/imageUtils': images, './userApi/remotePlaylist': remote,
	}, { URL, ...clock, Date: { now: () => clock.now } })
	return { helper, remote, clock, calls, writes, stores, stored, get queue() { return queue }, set queue(value) { queue = value } }
}

await check('missing/invalid HTTP artwork uses exact original ID details and preserves raw long picId', async () => {
	const f = fixture(async () => ({ ok: true, text: async () => '{"code":200,"songs":[{"id":2010,"al":{},"album":{"picId":109951170012345678}}]}' }))
	const result = await f.helper.repairNeteaseArtwork(track('2010', 'invalidhttp://broken'))
	assert.ok(result.artwork.endsWith('/109951170012345678.jpg'))
	assert.equal(f.calls.length, 1)
	assert.equal(new URL(f.calls[0].url).searchParams.get('ids'), '[2010]')
	assert.equal(f.writes.length, 0, 'candidate is not yet a downloaded image')
	assert.equal(f.clock.pending, 0)
})
await check('CDN failures try host and exact picID hash reconstruction before detail; old bad IDs reach detail', async () => {
	const f = fixture()
	const old = track('2010', 'https://p1.music.126.net/wrong/123.jpg')
	const candidates = f.helper.neteaseArtworkCandidates(old.artwork)
	assert.ok(candidates.includes(f.remote.neteaseImage('123')))
	assert.ok(candidates.some(url => url.includes('p2.music.126.net')))
	assert.equal((await f.helper.repairNeteaseArtwork(old, [old.artwork])).artwork, candidates[1])
	assert.equal(f.calls.length, 0)
	const repaired = await f.helper.repairNeteaseArtwork(old, candidates)
	assert.ok(repaired.artwork.endsWith('/109951170012345678.jpg'))
	assert.equal(f.calls.length, 1)
	const none = await f.helper.repairNeteaseArtwork(old, [...candidates, ...repaired.candidates])
	assert.equal(none.artwork, '')
	assert.equal(f.calls.length, 1)
})
await check('QQ, local, wrong detail IDs and title/artist matches cannot repair Netease artwork', async () => {
	const f = fixture(async () => ({ songs: [{ id: 999, name: 'same title', album: { picUrl: 'https://example.com/unrelated.jpg' } }] }))
	for (const platform of ['QQ', 'local', undefined]) {
		assert.equal((await f.helper.repairNeteaseArtwork({ id: '2010', platform })).artwork, '')
	}
	assert.equal(f.calls.length, 0)
	assert.equal((await f.helper.repairNeteaseArtwork(track())).artwork, '')
	assert.equal(f.calls.length, 1)
})
await check('detail keeps both legacy album and modern al picID alternatives even with a stale valid picUrl', async () => {
	const stale = 'https://p1.music.126.net/obsolete/123.jpg'
	const f = fixture(async () => ({ songs: [{ id: 2010,
		al: { picUrl: stale, picId: '109951170012345678' },
		album: { picUrl: '', picId_str: '109951170012345679' },
	}] }))
	const failed = f.helper.neteaseArtworkCandidates(stale)
	const result = await f.helper.repairNeteaseArtwork(track('2010', stale), failed)
	assert.ok(result.candidates.some(url => url.endsWith('/109951170012345678.jpg')))
	assert.ok(result.candidates.some(url => url.endsWith('/109951170012345679.jpg')))
	assert.ok(result.candidates.every(url => !failed.includes(url)))
})
await check('shared requests deduplicate, run max two, and bound a 2000-item flood to 34 tasks', async () => {
	const gate = deferred()
	let active = 0
	let maximum = 0
	const f = fixture(async () => {
		maximum = Math.max(maximum, ++active)
		await gate.promise
		active--
		return { songs: [] }
	})
	const duplicate = Array.from({ length: 20 }, () => f.helper.repairNeteaseArtwork(track()))
	assert.equal(f.calls.length, 1)
	const flood = Array.from({ length: 2000 }, (_, i) => f.helper.repairNeteaseArtwork(track(String(i + 3000))))
	assert.equal(f.calls.length, 2)
	gate.resolve()
	await Promise.all([...duplicate, ...flood])
	assert.equal(maximum, 2)
	assert.equal(f.calls.length, 34)
	await f.helper.repairNeteaseArtwork(track())
	assert.equal(f.calls.length, 34, 'negative cache suppresses repeated failures')
	f.clock.advance(60001)
	await f.helper.repairNeteaseArtwork(track())
	assert.equal(f.calls.length, 35, 'failure cache expires')
})
await check('timeout and HTTP 403/404 fail closed without writes and release both queue slots', async () => {
	for (const status of [403, 404]) {
		const f = fixture(async () => ({ ok: false, status, text: async () => '' }))
		assert.equal((await f.helper.repairNeteaseArtwork(track())).artwork, '')
		assert.equal(f.clock.pending, 0)
		assert.equal(f.writes.length, 0)
	}
	const f = fixture((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))))
	const pending = f.helper.repairNeteaseArtwork(track())
	f.clock.advance(20000)
	assert.equal((await pending).artwork, '')
	assert.equal(f.clock.pending, 0)
})
await check('confirmed repairs batch latest playlists/local/queue/current by id+platform, preserving unrelated fields', () => {
	const f = fixture()
	const original = { ...track(), url: 'file:///musicCache/2010.mp3', localAdded: true }
	const qq = track('2010', 'https://qq.test/keep.jpg', 'QQ')
	f.stores.playListsStore.setValue([{ id: 'list', coverImg: 'playlist-cover', songs: [original, qq] }])
	f.stores.importedLocalMusicStore.setValue([original, qq])
	f.stores.currentMusicStore.setValue(original)
	f.queue = [original, qq]
	const url = 'https://p2.music.126.net/confirmed.jpg'
	f.helper.updateTrackArtwork(original, url)
	f.helper.updateTrackArtwork(track('2011'), url)
	assert.equal(f.writes.length, 0)
	// A user addition during the delay must survive the flush.
	f.stores.playListsStore.setValue([{ id: 'list', coverImg: 'playlist-cover', songs: [original, qq, track('2011')] }])
	f.clock.advance(250)
	const list = f.stores.playListsStore.getValue()[0]
	assert.equal(list.songs[0].artwork, url)
	assert.equal(list.songs[0].url, original.url)
	assert.equal(list.songs[0].localAdded, true)
	assert.equal(list.songs[1], qq)
	assert.equal(list.songs[2].artwork, url)
	assert.equal(list.coverImg, 'playlist-cover')
	assert.equal(f.stores.importedLocalMusicStore.getValue()[0].artwork, url)
	assert.equal(f.stores.currentMusicStore.getValue().artwork, url)
	assert.equal(f.queue[0].artwork, url)
	assert.deepEqual(f.writes.map(write => write.key).sort(), ['music.importedLocalMusic', 'music.musicItem', 'music.play-list', 'music.playLists'].sort())
	f.helper.updateTrackArtwork(original, url)
	f.clock.advance(250)
	assert.equal(f.writes.length, 4, 'unchanged artwork is not rewritten')
})

function hookFixture(f, initial = track(), options = {}) {
	const slots = []
	let cursor = 0
	let dirty = false
	let mounted = true
	let currentTrack = initial
	let current = false
	let visible = true
	let output
	const effects = []
	const react = {
		useState(initial) {
			const index = cursor++
			slots[index] ??= { value: initial }
			return [slots[index].value, value => {
				assert.ok(mounted, 'no state updates after unmount')
				const next = typeof value === 'function' ? value(slots[index].value) : value
				if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true }
			}]
		},
		useRef(initial) { return slots[cursor++] ??= { current: initial } },
		useEffect(callback, deps) {
			const index = cursor++
			const before = slots[index]
			if (!before || deps.some((dep, i) => !Object.is(dep, before.deps[i]))) {
				slots[index] = { deps, cleanup: before?.cleanup }
				effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback() })
			}
		},
	}
	const context = { getRef: () => ({ props: { data: [currentTrack] }, computeVisibleIndices: () => visible ? { startIndex: 0, endIndex: 0 } : { startIndex: -1, endIndex: -1 } }) }
	const hook = loadModule('src/hooks/useTrackArtwork.ts', {
		react, '@shopify/flash-list': { useFlashListContext: () => context },
		'@/constants/images': { unknownTrackImageUri: 'asset:default' },
		'@/helpers/neteaseArtwork': f.helper, '@/utils/imageUtils': images,
	}, f.clock)
	function render() {
		for (let n = 0; n < 20; n++) {
			dirty = false
			cursor = 0
			output = hook.useTrackArtwork(currentTrack, current, options)
			while (effects.length) effects.shift()()
			if (!dirty) return output
		}
		throw new Error('render loop')
	}
	return { render, async settle() { await flush(); return render() },
		set track(value) { currentTrack = value }, set current(value) { current = value }, set visible(value) { visible = value },
		unmount() { slots.forEach(slot => slot.cleanup?.()); mounted = false },
	}
}

await check('visible missing artwork fetches without onError; only onLoad confirms persistence', async () => {
	const f = fixture()
	const h = hookFixture(f)
	assert.equal(h.render().source.uri, 'asset:default')
	const image = await h.settle()
	assert.ok(image.source.uri.includes('109951170012345678'))
	assert.equal(f.writes.length, 0)
	f.stores.importedLocalMusicStore.setValue([track()])
	image.onLoad()
	assert.equal(f.writes.length, 0)
	f.clock.advance(250)
	assert.equal(f.writes.length, 1)
	h.unmount()
	assert.equal(f.clock.pending, 0)
})
await check('2000 recycled offscreen tracks do not fetch; entering visible range or current triggers repair', async () => {
	const f = fixture()
	const h = hookFixture(f)
	h.visible = false
	for (let id = 1; id <= 2000; id++) { h.track = track(String(id)); h.render() }
	assert.equal(f.calls.length, 0)
	h.track = track()
	h.render()
	h.visible = true
	f.clock.advance(500)
	h.render()
	await h.settle()
	assert.equal(f.calls.length, 1)
	h.visible = false
	h.track = track('2011')
	h.current = true
	h.render()
	await h.settle()
	assert.equal(f.calls.length, 2)
	h.unmount()
})
await check('403/404 Image errors exhaust unique candidates and detail then settle on default without looping', async () => {
	const f = fixture()
	const h = hookFixture(f, track('2010', 'https://p1.music.126.net/wrong/123.jpg'))
	const seen = new Set()
	for (let n = 0; n < 25; n++) {
		const image = h.render()
		if (image.source.uri === 'asset:default') break
		assert.ok(!seen.has(image.source.uri), 'failed source is never retried in the same session')
		seen.add(image.source.uri)
		image.onError()
		h.render()
		await h.settle()
	}
	const fallback = h.render()
	assert.equal(fallback.source.uri, 'asset:default')
	fallback.onError()
	fallback.onLoad()
	h.render()
	assert.equal(f.calls.length, 1)
	assert.equal(f.writes.length, 0)
	h.unmount()
})
await check('recycling/unmount rejects stale detail completions and stale Image callbacks', async () => {
	const gate = deferred()
	const f = fixture(() => gate.promise)
	const h = hookFixture(f)
	h.render()
	h.track = track('999', 'https://example.com/999.jpg')
	const good = h.render()
	gate.resolve({ songs: [{ id: 2010, album: { picUrl: 'https://example.com/2010.jpg' } }] })
	await h.settle()
	assert.equal(h.render().source.uri, good.source.uri)
	h.track = track('2010', 'https://p1.music.126.net/broken/123.jpg')
	const stale = h.render()
	stale.onError()
	h.render()
	const repaired = await h.settle()
	stale.onError()
	assert.equal(h.render().source.uri, repaired.source.uri)
	h.track = track('other', 'https://example.com/other.jpg')
	h.render()
	repaired.onLoad()
	assert.equal(f.clock.pending, 0, 'invalid ID has neither visibility nor persist timer')
	h.unmount()
	repaired.onLoad()
	assert.equal(f.clock.pending, 0, 'late onLoad after unmount cannot persist')
	const f2 = fixture(() => gate.promise)
	const h2 = hookFixture(f2)
	h2.render()
	h2.unmount()
	await flush()
	assert.equal(f2.writes.length, 0)
})
await check('visibility change during pending detail resumes deduplicated repair', async () => {
	const gate = deferred()
	const f = fixture(() => gate.promise)
	const h = hookFixture(f)
	h.render()
	h.visible = false
	f.clock.advance(500)
	h.render()
	h.visible = true
	f.clock.advance(500)
	h.render()
	gate.resolve({ songs: [{ id: 2010, album: { picUrl: 'https://example.com/2010.jpg' } }] })
	assert.equal((await h.settle()).source.uri, 'https://example.com/2010.jpg')
	assert.equal(f.calls.length, 1)
	h.unmount()
})
await check('invalid artwork falls back, while local file artwork remains local', () => {
	for (const input of ['', 'invalidhttp', 'invalidhttp://cover', 'http://', 'https://user:pass@example.com/image']) assert.equal(images.usableArtwork(input), undefined)
	assert.equal(images.usableArtwork('file:///local.jpg'), 'file:///local.jpg')
	assert.equal(images.usableArtwork('//p1.music.126.net/test.jpg'), 'https://p1.music.126.net/test.jpg')
	assert.deepEqual(plain(fixture().helper.neteaseArtworkCandidates('file:///local.jpg')), [])
})

await check('all four Netease aliases share request dedup and persist identity, never QQ numeric collisions', async () => {
	const f = fixture()
	const aliases = ['Netease', 'netease', 'wy', '163']
	const results = await Promise.all(aliases.map(platform => f.helper.repairNeteaseArtwork(track('2010', '', platform))))
	assert.equal(f.calls.length, 1)
	assert.ok(results.every(result => result.artwork === results[0].artwork))
	const songs = [...aliases, 'QQ'].map(platform => track('2010', '', platform))
	f.stores.importedLocalMusicStore.setValue(songs)
	f.helper.updateTrackArtwork(track('2010', '', 'wy'), results[0].artwork)
	f.clock.advance(250)
	assert.ok(f.stores.importedLocalMusicStore.getValue().slice(0, 4).every(song => song.artwork === results[0].artwork))
	assert.equal(f.stores.importedLocalMusicStore.getValue()[4], songs[4])
})
await check('missing/unsafe numeric song identities never fetch or schedule persistence', async () => {
	const f = fixture()
	for (const id of [undefined, null, '', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, {}, 'undefined', '1e4']) {
		const song = { id, platform: 'Netease' }
		assert.equal((await f.helper.repairNeteaseArtwork(song)).artwork, '')
		f.helper.updateTrackArtwork(song, 'https://example.com/confirmed.jpg')
	}
	assert.equal(f.calls.length, 0)
	assert.equal(f.clock.pending, 0)
})
await check('fake256 recycled UI cases allow absent track, preserve full resolution and keep lastTrack passive', async () => {
	const f = fixture()
	const published = []
	const h = hookFixture(f, null, { fullSize: true, onConfirmed: (...args) => published.push(args) })
	h.visible = false
	assert.equal(h.render().source.uri, 'asset:default')
	for (let index = 0; index < 256; index++) {
		h.track = track(String(index + 1), index % 2 ? 'invalidhttp' : '', ['Netease', 'netease', 'wy', '163'][index % 4])
		const image = h.render()
		assert.equal(image.source.uri, 'asset:default')
		image.onError(); image.onLoad()
	}
	assert.equal(f.calls.length, 0)
	assert.equal(published.length, 0)
	h.track = track('2010', 'https://y.gtimg.cn/music/photo_new/T002R800x800M000full.jpg')
	assert.ok(h.render().source.uri.includes('800x800'))
	h.render().onLoad()
	assert.equal(published.length, 0, 'lastTrack is not current')
	h.current = true
	h.render().onLoad()
	assert.equal(published.length, 1)
	h.track = undefined
	h.render().onLoad()
	assert.equal(published.length, 1)
	h.unmount()
	const thumbnail = hookFixture(f, track('2010', 'https://y.gtimg.cn/music/photo_new/T002R800x800M000full.jpg'))
	assert.ok(thumbnail.render().source.uri.includes('150x150'))
	thumbnail.unmount()
})

finish()
