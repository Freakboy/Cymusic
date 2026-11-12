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
await check('manual artwork refresh bypasses detail cache, notifies matching mounted image and never persists candidates', async () => {
	const f = fixture()
	await f.helper.repairNeteaseArtwork(track())
	const notifications = []
	const unsubscribe = f.helper.subscribeArtworkRefresh(track(), uri => notifications.push(uri))
	assert.equal(await f.helper.refreshTrackArtwork(track()), true)
	assert.equal(f.calls.length, 2)
	assert.equal(notifications.length, 1)
	assert.equal(f.writes.length, 0)
	unsubscribe()
	assert.equal(await f.helper.refreshTrackArtwork(track()), false)
	assert.equal(f.calls.length, 2, 'Unbound/hidden requests do not start network')
	assert.equal(await f.helper.refreshTrackArtwork(track('2010', '', 'QQ')), false)
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
	assert.ok(result.artwork.endsWith('/109951170012345678.jpg'), 'exact detail picID precedes stale picUrl hosts')
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
	assert.equal(list.songs[0].verifiedArtwork, url)
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
		useCallback(callback, deps) {
			const index = cursor++, before = slots[index]
			if (!before || deps.some((dep, i) => !Object.is(dep, before.deps[i]))) slots[index] = { deps, callback }
			return slots[index].callback
		},
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
	}, { ...f.clock, Date: { now: () => f.clock.now } })
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
await check('manual refresh reloads the same image URL without persisting cache-buster or accepting old callbacks', async () => {
	const f = fixture()
	const h = hookFixture(f)
	h.render()
	const oldImage = await h.settle()
	f.stores.importedLocalMusicStore.setValue([track()])
	assert.equal(await f.helper.refreshTrackArtwork(track()), true)
	const newImage = h.render()
	assert.ok(newImage.source.uri.includes('cymusicArtworkRetry='))
	oldImage.onLoad()
	f.clock.advance(250)
	assert.equal(f.writes.length, 0)
	newImage.onLoad()
	f.clock.advance(250)
	assert.equal(f.writes.length, 1)
	assert.ok(!f.stores.importedLocalMusicStore.getValue()[0].artwork.includes('cymusicArtworkRetry'))
	h.unmount()
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

await check('original Netease onLoad persists verification once, and restart reuses the confirmed URL', async () => {
	const f = fixture()
	const original = track('2010', 'https://example.com/original.jpg')
	f.stores.importedLocalMusicStore.setValue([original])
	const h = hookFixture(f, original)
	const image = h.render()
	image.onLoad()
	image.onLoad()
	f.clock.advance(250)
	assert.equal(f.writes.length, 1)
	const saved = plain(f.stores.importedLocalMusicStore.getValue()[0])
	assert.equal(saved.verifiedArtwork, original.artwork)
	image.onLoad()
	assert.equal(f.clock.pending, 1, 'only visibility polling remains')
	h.unmount()
	const restarted = fixture()
	restarted.stores.importedLocalMusicStore.setValue([saved])
	const next = hookFixture(restarted, saved)
	assert.equal(next.render().source.uri, original.artwork)
	next.render().onLoad()
	assert.equal(restarted.calls.length, 0)
	assert.equal(restarted.writes.length, 0)
	assert.equal(restarted.clock.pending, 1, 'verified URI does not enqueue persistence')
	next.unmount()
})

await check('a visible target rejected by the full 2+32 queue retries after slots release', async () => {
	const gate = deferred()
	const f = fixture(async url => {
		await gate.promise
		const id = JSON.parse(new URL(url).searchParams.get('ids'))[0]
		return { songs: [{ id, album: { picUrl: `https://example.com/${id}.jpg` } }] }
	})
	const pending = Array.from({ length: 34 }, (_, i) => f.helper.repairNeteaseArtwork(track(String(3000 + i))))
	const h = hookFixture(f)
	h.render()
	await h.settle()
	assert.equal(f.calls.length, 2)
	gate.resolve()
	await Promise.all(pending)
	assert.equal(f.calls.length, 34)
	f.clock.advance(1000)
	h.render()
	assert.equal((await h.settle()).source.uri, 'https://example.com/2010.jpg')
	assert.equal(f.calls.length, 35)
	h.unmount()
	assert.equal(f.clock.pending, 0)
})

await check('visible offline/empty details recover after negative TTL without leaving the screen', async () => {
	for (const [ttl, failure] of [[5000, () => { throw new Error('offline') }], [60000, () => ({ songs: [] })]]) {
		let recovered = false
		const f = fixture(() => recovered ? { songs: [{ id: 2010, album: { picUrl: 'https://example.com/recovered.jpg' } }] } : failure())
		const h = hookFixture(f)
		h.render()
		await h.settle()
		assert.equal(f.calls.length, 1)
		f.clock.advance(ttl - 1)
		h.render()
		assert.equal(f.calls.length, 1)
		recovered = true
		f.clock.advance(1)
		h.render()
		assert.equal((await h.settle()).source.uri, 'https://example.com/recovered.jpg')
		assert.equal(f.calls.length, 2)
		h.unmount()
		assert.equal(f.clock.pending, 0)
	}
})

await check('continuous visibility stops after three failure rounds; offscreen resets budget and cleans retry', async () => {
	const f = fixture(async () => ({ songs: [] }))
	const h = hookFixture(f)
	h.render()
	await h.settle()
	for (let n = 0; n < 5; n++) {
		f.clock.advance(60000)
		h.render()
		await h.settle()
	}
	assert.equal(f.calls.length, 3)
	h.visible = false
	f.clock.advance(500)
	h.render()
	assert.equal(f.clock.pending, 1)
	h.visible = true
	f.clock.advance(500)
	h.render()
	await h.settle()
	assert.equal(f.calls.length, 4)
	h.visible = false
	f.clock.advance(500)
	h.render()
	assert.equal(f.clock.pending, 1, 'leaving visibility clears retry timer')
	h.track = track('999')
	h.render()
	h.unmount()
	assert.equal(f.clock.pending, 0)
	f.clock.advance(120000)
	await flush()
	assert.equal(f.calls.length, 4)
})

await check('bad image candidates stay bounded across timed recovery rounds', async () => {
	const f = fixture()
	const h = hookFixture(f)
	for (let round = 0; round < 4; round++) {
		h.render()
		await h.settle()
		let failures = 0
		while (h.render().source.uri !== 'asset:default') {
			h.render().onError()
			h.render()
			await h.settle()
			assert.ok(++failures <= 16, 'finite candidates per round')
		}
		f.clock.advance(300000)
	}
	h.render()
	await h.settle()
	assert.equal(f.calls.length, 3)
	h.unmount()
	assert.equal(f.clock.pending, 0)
})

await check('changing identity or unmounting cancels a pending visible retry', async () => {
	for (const action of ['recycle', 'unmount']) {
		const f = fixture(async () => ({ songs: [] }))
		const h = hookFixture(f)
		h.render()
		await h.settle()
		assert.equal(f.clock.pending, 2, 'visibility and retry timers')
		if (action === 'recycle') {
			h.track = track('999', 'https://example.com/999.jpg')
			h.render()
			assert.equal(f.clock.pending, 2, 'old identity retry removed; new image deadline plus visibility remain')
		}
		h.unmount()
		assert.equal(f.clock.pending, 0)
		f.clock.advance(120000)
		await flush()
		assert.equal(f.calls.length, 1)
	}
})

await check('stale CDN failure starts exact-ID detail immediately rather than serially exhausting eight hosts', async () => {
	const f = fixture(), h = hookFixture(f, track('2010', 'https://p1.music.126.net/wrong/123.jpg'))
	const start = f.clock.now
	h.render().onError(); h.render()
	await h.settle()
	assert.equal(f.calls.length, 1, 'exact-ID request must start on first image failure at t=0')
	assert.ok(h.render().source.uri.includes('109951170012345678'))
	console.log(`TIMING first failure -> detail start: ${f.clock.now - start}ms`)
	h.unmount()
})
await check('visible image with neither onLoad nor onError has a bounded loading deadline', async () => {
	const f = fixture(), h = hookFixture(f, track('2010', 'https://p1.music.126.net/wrong/123.jpg'))
	const stale = h.render()
	f.clock.advance(8000); h.render(); await h.settle()
	assert.equal(f.calls.length, 1, 'silent native image must recover within 8s')
	assert.notEqual(h.render().source.uri, stale.source.uri)
	stale.onLoad(); f.clock.advance(250)
	assert.equal(f.writes.length, 0, 'late timed-out image cannot persist')
	h.unmount()
})
await check('transient 503 detail retries in five seconds rather than empty-album one-minute TTL', async () => {
	let online = false
	const f = fixture(() => online ? { songs: [{ id: 2010, album: { picUrl: 'https://example.com/recovered.jpg' } }] } : { ok: false, status: 503, text: async () => '' })
	const h = hookFixture(f); h.render(); await h.settle()
	online = true; f.clock.advance(5000); h.render(); await h.settle()
	assert.equal(f.calls.length, 2)
	assert.equal(h.render().source.uri, 'https://example.com/recovered.jpg')
	h.unmount()
})
await check('successful original image cancels deadline and never starts detail; fast CDN success beats pending detail', async () => {
	const gate = deferred(), f = fixture(() => gate.promise)
	const original = track('2010', 'https://p1.music.126.net/wrong/123.jpg')
	const good = hookFixture(f, original)
	good.render().onLoad(); f.clock.advance(8000); good.render()
	assert.equal(f.calls.length, 0); good.unmount()
	const h = hookFixture(f, original)
	h.render().onError(); h.render(); await h.settle()
	const candidate = h.render(); candidate.onLoad()
	gate.resolve({ songs: [{ id: 2010, album: { picUrl: 'https://example.com/detail.jpg' } }] })
	await h.settle()
	assert.equal(h.render().source.uri, candidate.source.uri)
	h.unmount()
})
await check('failed verified URI may persist a new successful candidate, but never clobbers a newer verified store marker', async () => {
	const f = fixture(), original = { ...track('2010', 'https://p1.music.126.net/wrong/123.jpg'), verifiedArtwork: 'https://p1.music.126.net/wrong/123.jpg' }
	f.stores.importedLocalMusicStore.setValue([original])
	const h = hookFixture(f, original)
	h.render().onError(); h.render(); await h.settle()
	const candidate = h.render(); assert.notEqual(candidate.source.uri, original.artwork)
	assert.equal(f.writes.length, 0)
	candidate.onLoad(); f.clock.advance(250)
	assert.equal(f.stores.importedLocalMusicStore.getValue()[0].verifiedArtwork, candidate.source.uri)
	f.helper.updateTrackArtwork(original, 'https://example.com/late.jpg')
	f.clock.advance(250)
	assert.equal(f.stores.importedLocalMusicStore.getValue()[0].verifiedArtwork, candidate.source.uri)
	h.unmount()
})
await check('queued detail for a now-hidden/unmounted cell never starts network when slots release', async () => {
	for (const action of ['hidden', 'unmount']) {
		const gate = deferred(), f = fixture(() => gate.promise)
		const pending = [f.helper.repairNeteaseArtwork(track('3000')), f.helper.repairNeteaseArtwork(track('3001'))]
		const h = hookFixture(f); h.render(); await h.settle()
		assert.equal(f.calls.length, 2)
		if (action === 'hidden') { h.visible = false; f.clock.advance(500); h.render() }
		else h.unmount()
		gate.resolve({ songs: [] }); await Promise.all(pending); await flush()
		assert.equal(f.calls.length, 2)
		if (action === 'hidden') h.unmount()
	}
})
await check('exhausted candidate cache and three-round budget do not freeze recovery on a new mount', async () => {
	let recovered = false
	const f = fixture(() => recovered ? { songs: [{ id: 2010, album: { picUrl: 'https://example.com/new.jpg' } }] } : { songs: [] })
	const h = hookFixture(f); h.render(); await h.settle()
	for (let round = 0; round < 3; round++) { f.clock.advance(60000); h.render(); await h.settle() }
	assert.equal(f.calls.length, 3); h.unmount(); recovered = true
	const next = hookFixture(f); next.render(); await next.settle()
	assert.equal(next.render().source.uri, 'https://example.com/new.jpg'); next.unmount()
	const f2 = fixture(), all = await f2.helper.repairNeteaseArtwork(track())
	const rejected = await f2.helper.repairNeteaseArtwork(track(), all.candidates)
	assert.equal(rejected.retryAt - f2.clock.now, 5000, 'failed positive candidates no longer freeze detail for 5min')
	f2.clock.advance(5000); await f2.helper.repairNeteaseArtwork(track())
	assert.equal(f2.calls.length, 2)
})
await check('silent images exhaust finite candidates/three rounds, hidden cells have no image deadline', async () => {
	const f = fixture(), h = hookFixture(f, track('2010', 'https://p1.music.126.net/wrong/123.jpg'))
	h.render()
	for (let n = 0; n < 70; n++) { f.clock.advance(8000); h.render(); await h.settle() }
	assert.equal(h.render().source.uri, 'asset:default')
	assert.equal(f.calls.length, 3)
	const calls = f.calls.length
	f.clock.advance(300000); h.render(); await h.settle()
	assert.equal(f.calls.length, calls); h.unmount(); assert.equal(f.clock.pending, 0)
	const f2 = fixture(), hidden = hookFixture(f2, track('2010', 'https://p1.music.126.net/wrong/123.jpg'))
	hidden.visible = false; hidden.render(); f2.clock.advance(20000); hidden.render(); await hidden.settle()
	assert.equal(f2.calls.length, 0); hidden.unmount()
})
finish()
