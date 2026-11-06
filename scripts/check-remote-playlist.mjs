import { assert, checks, deferred, flush, loadModule } from './native-services-fixture.mjs'
import { fakeClock } from './request-fixture.mjs'

const { check, finish } = checks()
const plain = (value) => JSON.parse(JSON.stringify(value))
const ref = (platform = 'QQ', remoteId = '42') => ({ platform, remoteId, sourceUrl: remoteId })
const song = (id, platform = 'QQ', extra = {}) => ({ id, platform, title: id, artist: 'artist', album: '', artwork: '', duration: 1, ...extra })
const qqPage = (ids, total = ids.length) => ({ code: 0, cdlist: [{ dissname: 'remote', songnum: total, songlist: ids.map((mid) => ({ mid, title: mid })) }] })
const netSong = (id) => ({ id, name: `song ${id}`, ar: [{ name: 'new artist' }], al: { name: 'new album', picUrl: 'new.jpg' }, dt: 123000 })

function fixture(responses = [], initial = []) {
	const clock = fakeClock()
	const calls = []
	const writes = []
	let playlists = initial
	const remote = loadModule('src/helpers/userApi/remotePlaylist.ts', { 'expo/fetch': {
		async fetch(url, options) {
			calls.push({ url, options })
			const response = responses.shift()
			if (response instanceof Error) throw response
			if (typeof response === 'function') return response(url, options)
			assert.ok(response, `Unexpected request: ${url}`)
			return { ok: true, json: async () => response }
		},
	} }, { ...clock, URL })
	const store = loadModule('src/helpers/remotePlaylistStore.ts', {
		'@/player/PlayerStore': { playListsStore: { getValue: () => playlists, setValue: (value) => { playlists = value } } },
		'@/store/PersistStatus': { set: (key, value) => { assert.equal(key, 'music.playLists'); writes.push(value) } },
		'./userApi/remotePlaylist': remote,
	})
	return { ...remote, ...store, clock, calls, writes, get playlists() { return playlists }, set playlists(value) { playlists = value } }
}

await check('references detect both platforms, disstid, hash URLs and reject mismatched selection', () => {
	const f = fixture()
	assert.equal(f.parseRemotePlaylistReference('https://music.163.com/#/playlist?id=42').platform, 'Netease')
	assert.equal(f.parseRemotePlaylistReference('分享 https://y.qq.com/n/ryqq/playlist/42').remoteId, '42')
	assert.equal(f.parseRemotePlaylistReference('https://y.qq.com/a?disstid=42').remoteId, '42')
	assert.equal(f.parseRemotePlaylistReference('42', 'QQ').remoteId, '42')
	assert.equal(f.parseRemotePlaylistReference('42'), null)
	assert.equal(f.parseRemotePlaylistReference('https://music.163.com/playlist?id=42', 'QQ'), null)
	assert.notEqual(f.remotePlaylistId(ref()), f.remotePlaylistId(ref('Netease')))
})

await check('share text parses the URL alone, not unrelated titles or numeric query parameters', () => {
	const f = fixture()
	assert.equal(f.parseRemotePlaylistReference('网易云用户分享 QQ 歌单 https://y.qq.com/n/ryqq/playlist/42。').remoteId, '42')
	assert.equal(f.parseRemotePlaylistReference('https://y.qq.com/n/yqq/playlist/42.html').remoteId, '42')
	for (const input of ['https://evil.example/?id=42', 'https://music.163.com.evil.example/playlist?id=42',
		'https://evil.example/music.163.com/playlist?id=42', 'https://music.163.com/song?id=42',
		'https://y.qq.com/n/ryqq/songDetail/42', 'https://y.qq.com:8443/playlist/42',
		'https://user:pass@y.qq.com/playlist/42', 'https://music.163.com/playlist?id=42oops']) {
		assert.equal(f.parseRemotePlaylistReference(input, 'QQ'), null, input)
	}
})

const redirect = (location, status = 302) => () => ({ status, ok: false, headers: { get: (name) => name === 'location' ? location : null } })
for (const [platform, short, target, page] of [
	['QQ', 'https://c6.y.qq.com/base/fcgi-bin/u?__=sample', 'https://i.y.qq.com/n2/m/share/details/taoge.html?id=42', qqPage(['a'])],
	['Netease', 'https://163cn.tv/sample', 'https://y.music.163.com/m/playlist?id=42', { code: 200, playlist: { trackIds: [{ id: 1 }], tracks: [netSong(1)] } }],
]) {
	await check(`${platform} share short URL resolves before importing and retains original source`, async () => {
		const f = fixture([redirect(target), page])
		// importPlayList.handlePreview performs this synchronous gate before the async helper.
		const parsed = f.parseRemotePlaylistReference(`分享歌单 ${short}`, platform)
		assert.ok(parsed)
		assert.equal(parsed.platform, platform)
		assert.equal(parsed.remoteId, undefined)
		const result = await f.fetchRemotePlaylistFromInput(`分享歌单 ${short} （来自音乐）`, platform)
		assert.equal(result.id, `remote:${platform}:42`)
		assert.equal(result.remoteBinding.sourceUrl, short)
		assert.equal(f.calls[0].options.redirect, 'manual')
		assert.equal(f.clock.pending, 0)
	})
}

await check('relative redirects resolve against the current official URL', async () => {
	const f = fixture([redirect('/n/ryqq/playlist/42'), qqPage(['a'])])
	assert.equal((await f.fetchRemotePlaylistFromInput('https://c6.y.qq.com/base/fcgi-bin/u?__=sample')).remoteBinding.remoteId, '42')
})

for (const target of ['https://evil.example/playlist?id=42', 'https://y.qq.com.evil.example/playlist/42',
	'https://music.163.com/playlist?id=42', 'file:///playlist/42', 'https://user:pass@y.qq.com/playlist/42',
	'https://y.qq.com/song?id=42']) {
	await check(`unsafe or non-playlist short-link target is rejected: ${target}`, async () => {
		const f = fixture([redirect(target)])
		await assert.rejects(f.fetchRemotePlaylistFromInput('https://c6.y.qq.com/base/fcgi-bin/u?__=sample', 'QQ'))
		assert.equal(f.calls.length, 1)
		assert.equal(f.clock.pending, 0)
	})
}

await check('short link mismatch makes no request, and loops, absent location, HTTP and automatic redirects fail closed', async () => {
	const short = 'https://163cn.tv/sample'
	const mismatch = fixture()
	await assert.rejects(mismatch.fetchRemotePlaylistFromInput(short, 'QQ'))
	assert.equal(mismatch.calls.length, 0)
	for (const responses of [[redirect(null)],
		[() => ({ status: 404, ok: false })], [() => ({ ok: true, redirected: true, url: 'https://evil.example/' })]]) {
		const f = fixture(responses)
		await assert.rejects(f.fetchRemotePlaylistFromInput(short))
		assert.ok(f.calls.length <= 6)
		assert.equal(f.clock.pending, 0)
	}
})

await check('short links stop after five redirects even when every host is official', async () => {
	const f = fixture(Array.from({ length: 6 }, (_, i) => redirect(`/base/fcgi-bin/u?__=hop${i}`)))
	await assert.rejects(f.fetchRemotePlaylistFromInput('https://c6.y.qq.com/base/fcgi-bin/u?__=sample'), /超过 5 次/)
	assert.equal(f.calls.length, 6)
	assert.equal(f.clock.pending, 0)
})

await check('short-link request aborts on timeout', async () => {
	const f = fixture([(_url, { signal }) => new Promise((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(new Error('aborted')))
	})])
	const pending = assert.rejects(f.fetchRemotePlaylistFromInput('https://163cn.tv/sample'), /aborted/)
	f.clock.advance(20000)
	await pending
	assert.equal(f.clock.pending, 0)
})

await check('short-link redirects share a single timeout rather than resetting it per hop', async () => {
	let f
	f = fixture([() => {
		f.clock.advance(10000)
		return redirect('/next')()
	}, (_url, { signal }) => new Promise((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(new Error('aborted')))
	})])
	const pending = assert.rejects(f.fetchRemotePlaylistFromInput('https://163cn.tv/sample'), /aborted/)
	await flush()
	assert.equal(f.calls.length, 2)
	f.clock.advance(10000)
	await pending
	assert.equal(f.clock.pending, 0)
})

await check('Netease full trackIds prove completeness when trackCount is absent, including empty lists', async () => {
	for (const ids of [[], [1, 2]]) {
		const f = fixture([{ code: 200, playlist: { trackIds: ids.map((id) => ({ id })), tracks: [] } },
			{ code: 200, songs: ids.map(netSong) }])
		assert.deepEqual(plain((await f.fetchRemotePlaylist(ref('Netease'))).songs.map((item) => Number(item.id))), ids)
	}
})

await check('QQ rejects a page whose declared offset or page size disagrees', async () => {
	for (const extra of [{ song_begin: 1 }, { cur_song_num: 2 }]) {
		const page = qqPage(['a'])
		Object.assign(page.cdlist[0], extra)
		const f = fixture([page])
		await assert.rejects(f.fetchRemotePlaylist(ref()))
	}
})

for (const [name, playlist] of [
	['real 1501-count / 1500-ID truncation', { trackCount: 1501, trackIds: Array.from({ length: 1500 }, (_, i) => ({ id: i + 1 })), tracks: [] }],
	['countless duplicate IDs', { trackIds: [{ id: 1 }, { id: 1 }], tracks: [netSong(1)] }],
	['countless invalid IDs', { trackIds: [{ id: 'bad' }], tracks: [] }],
	['null total', { trackCount: null, trackIds: [], tracks: [] }],
]) {
	await check(`Netease ${name} preserves the original stored playlist`, async () => {
		const original = { id: 'remote:Netease:42', platform: 'Netease', songs: [song('old')], remoteBinding: ref('Netease') }
		const f = fixture([{ code: 200, playlist }], [original])
		await assert.rejects(f.refreshRemotePlaylist(original.id))
		assert.equal(f.writes.length, 0)
		assert.equal(f.playlists[0], original)
	})
}

await check('QQ consumes all pages using the actual offset and both song formats', async () => {
	const f = fixture([qqPage(['a', 'b'], 3), { code: 0, cdlist: [{ songnum: 3, songlist: [{ songmid: 'c', songname: 'old', albumname: 'album', interval: 15 }] }] }])
	const result = await f.fetchRemotePlaylist(ref())
	assert.deepEqual(plain(result.songs.map((item) => item.id)), ['a', 'b', 'c'])
	assert.match(f.calls[1].url, /song_begin=2&song_num=100/)
	assert.equal(result.songs[2].album, 'album')
	assert.equal(result.id, 'remote:QQ:42')
	assert.equal(f.clock.pending, 0)
})

for (const [name, pages] of [
	['missing page', [qqPage(['a'], 2), { code: 0 }]],
	['empty page', [qqPage(['a'], 2), qqPage([], 2)]],
	['repeated page', [qqPage(['a'], 2), qqPage(['a'], 2)]],
	['changed count', [qqPage(['a'], 2), qqPage(['b'], 3)]],
	['missing count', [{ code: 0, cdlist: [{ songlist: [] }] }]],
	['API error', [{ code: 100, cdlist: [] }]],
	['transport error', [new Error('offline')]],
]) {
	await check(`QQ ${name} cannot write over stored songs`, async () => {
		const original = { id: '42', platform: 'QQ', songs: [song('old')] }
		const f = fixture(pages, [original])
		await assert.rejects(f.refreshRemotePlaylist('42'))
		assert.equal(f.writes.length, 0)
		assert.equal(f.playlists[0], original)
		assert.equal(f.clock.pending, 0)
	})
}

await check('HTTP failure and invalid JSON clear request timers', async () => {
	for (const response of [
		() => ({ ok: false, status: 503 }),
		() => ({ ok: true, json: async () => { throw new Error('invalid JSON') } }),
	]) {
		const f = fixture([response])
		await assert.rejects(f.fetchRemotePlaylist(ref()))
		assert.equal(f.clock.pending, 0)
	}
})

await check('request timeout aborts and releases the timer', async () => {
	const f = fixture([(_url, { signal }) => new Promise((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(new Error('aborted')))
	})])
	const pending = f.fetchRemotePlaylist(ref())
	const rejected = assert.rejects(pending, /aborted/)
	f.clock.advance(20000)
	await rejected
	assert.equal(f.clock.pending, 0)
})

await check('Netease fills missing IDs anywhere, reorders by full trackIds, and normalizes old/new fields', async () => {
	const f = fixture([
		{ code: 200, result: { name: 'old playlist', trackCount: 3, trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }], tracks: [netSong(3), netSong(1)] } },
		{ code: 200, songs: [{ id: 2, name: 'old song', artists: [{ name: 'old artist' }], album: { name: 'old album', picUrl: 'old.jpg' }, duration: 45000 }] },
	])
	const result = await f.fetchRemotePlaylist(ref('Netease'))
	assert.deepEqual(plain(result.songs.map((item) => item.id)), ['1', '2', '3'])
	assert.match(decodeURIComponent(f.calls[1].url), /ids=\[2\]/)
	assert.equal(result.songs[1].artist, 'old artist')
	assert.equal(result.songs[1].album, 'old album')
	assert.equal(result.songs[1].artwork, 'old.jpg')
	assert.equal(result.songs[1].duration, 45)
	assert.equal(result.songs[0].duration, 123)
})

await check('Netease batches a full ID list without depending on initial track order', async () => {
	const ids = Array.from({ length: 402 }, (_, index) => index + 1)
	const f = fixture([
		{ code: 200, playlist: { trackCount: ids.length, trackIds: ids.map((id) => ({ id })), tracks: [netSong(402)] } },
		...Array.from({ length: 3 }, (_, index) => ({ code: 200, songs: ids.slice(index * 200, Math.min(index * 200 + 200, 401)).reverse().map(netSong) })),
	])
	const result = await f.fetchRemotePlaylist(ref('Netease'))
	assert.equal(result.songs.length, 402)
	assert.deepEqual(plain(result.songs.map((item) => Number(item.id))), ids)
	assert.equal(f.calls.length, 4)
})

for (const [name, playlist, details = []] of [
	['truncated ID list', { trackCount: 2, trackIds: [{ id: 1 }], tracks: [netSong(1)] }],
	['wrong detail IDs', { trackCount: 2, trackIds: [{ id: 1 }, { id: 2 }], tracks: [netSong(1)] }, [{ code: 200, songs: [netSong(3)] }]],
	['missing songs field', { trackCount: 1, trackIds: [{ id: 1 }], tracks: [] }, [{ code: 200 }]],
	['duplicate IDs', { trackCount: 2, trackIds: [{ id: 1 }, { id: 1 }], tracks: [] }],
	['legacy truncated tracks', { trackCount: 2, tracks: [netSong(1)] }],
	['missing total', { tracks: [netSong(1)] }],
	['missing arrays on empty response', { trackCount: 0 }],
]) {
	await check(`Netease ${name} cannot overwrite a stored playlist`, async () => {
		const original = { id: 'remote:Netease:42', platform: 'Netease', songs: [song('old')], remoteBinding: ref('Netease') }
		const f = fixture([{ code: 200, playlist }, ...details], [original])
		await assert.rejects(f.refreshRemotePlaylist(original.id))
		assert.equal(f.writes.length, 0)
		assert.equal(f.playlists[0], original)
	})
}

await check('verified empty playlists are accepted, rather than confused with failed requests', async () => {
	const f = fixture([qqPage([]), { code: 200, playlist: { trackCount: 0, tracks: [], trackIds: [] } }])
	assert.equal((await f.fetchRemotePlaylist(ref())).songs.length, 0)
	assert.equal((await f.fetchRemotePlaylist(ref('Netease'))).songs.length, 0)
})

for (const binding of [undefined, ref()]) {
	await check(`first QQ refresh without a snapshot preserves unmarked additions (${binding ? 'bound' : 'legacy numeric ID'})`, async () => {
		const original = { id: '42', platform: 'QQ', remoteBinding: binding,
			songs: [song('remote'), song('manual'), song('manual', 'Netease')] }
		const f = fixture([qqPage(['remote', 'new']), qqPage(['new']), qqPage([])], [original])
		const first = await f.refreshRemotePlaylist('42')
		assert.equal(first.id, 'remote:QQ:42')
		assert.deepEqual(plain(first.songs.map((item) => f.songKey(item))), ['QQ:remote', 'QQ:new', 'QQ:manual', 'Netease:manual'])
		assert.deepEqual(plain(first.remoteBinding.remoteSongKeys), ['QQ:remote', 'QQ:new'])
		assert.deepEqual(plain(first.songs.map((item) => item.localAdded ?? false)), [false, false, true, true])
		assert.deepEqual(plain(f.writes[0]), plain([first]))
		assert.equal(original.songs[1].localAdded, undefined)
		const second = await f.refreshRemotePlaylist(first.id)
		assert.deepEqual(plain(second.songs.map((item) => f.songKey(item))), ['QQ:new', 'QQ:manual', 'Netease:manual'])
		assert.deepEqual(plain(second.remoteBinding.remoteSongKeys), ['QQ:new'])
		const third = await f.refreshRemotePlaylist(second.id)
		assert.deepEqual(plain(third.songs.map((item) => f.songKey(item))), ['QQ:manual', 'Netease:manual'])
		assert.deepEqual(plain(third.remoteBinding.remoteSongKeys), [])
		assert.equal(f.writes.length, 3)
	})
}

await check('an explicit empty remote snapshot is not treated as an unknown legacy snapshot', async () => {
	const original = { id: '42', platform: 'QQ', remoteBinding: { ...ref(), remoteSongKeys: [] }, songs: [song('manual')] }
	const f = fixture([qqPage(['remote']), qqPage([])], [original])
	const first = await f.refreshRemotePlaylist('42')
	assert.equal(first.songs.find((item) => item.id === 'manual').localAdded, true)
	assert.equal(first.songs.find((item) => item.id === 'remote').localAdded, undefined)
	const second = await f.refreshRemotePlaylist(first.id)
	assert.deepEqual(plain(second.songs.map((item) => item.id)), ['manual'])
})

await check('bound QQ refresh preserves explicit local songs and custom fields, without cross-platform collision', async () => {
	const original = { id: '42', platform: 'QQ', title: 'mine', name: 'mine', artwork: 'mine.jpg', coverImg: 'cover.jpg', customName: true, customCover: true,
		remoteBinding: { ...ref(), remoteSongKeys: ['QQ:old'] },
		songs: [song('old'), song('local', 'QQ', { localAdded: true })] }
	const net = { id: 'remote:Netease:42', platform: 'Netease', remoteBinding: ref('Netease'), songs: [] }
	const f = fixture([qqPage(['new'])], [original, net])
	const result = await f.refreshRemotePlaylist('42')
	assert.equal(result.id, 'remote:QQ:42')
	assert.equal(result.remoteBinding.remoteId, '42')
	assert.deepEqual(plain(result.songs.map((item) => item.id)), ['new', 'local'])
	assert.equal(result.title, 'mine')
	assert.equal(result.coverImg, 'cover.jpg')
	assert.equal(f.playlists[1], net)
	assert.equal(f.writes.length, 1)
})

await check('refresh preserves in-flight local additions, coalesces requests, and does not resurrect deletions', async () => {
	const response = deferred()
	const original = { id: '42', platform: 'QQ', songs: [song('old')], remoteBinding: { ...ref(), remoteSongKeys: ['QQ:old'] } }
	const f = fixture([() => response.promise], [original])
	const pending = f.refreshRemotePlaylist('42')
	assert.equal(f.refreshRemotePlaylist('42'), pending)
	f.playlists = [{ ...original, songs: [...original.songs, song('extra', 'Netease')] }]
	response.resolve({ ok: true, json: async () => qqPage(['new']) })
	const result = await pending
	assert.deepEqual(plain(result.songs.map((item) => item.id)), ['new', 'extra'])
	assert.equal(result.songs[1].localAdded, true)
	const deletion = deferred()
	const g = fixture([() => deletion.promise], [original])
	const deleted = g.refreshRemotePlaylist('42')
	g.playlists = []
	deletion.resolve({ ok: true, json: async () => qqPage(['new']) })
	await assert.rejects(deleted, /已被删除/)
	assert.equal(g.writes.length, 0)
})

await check('reimport updates, copy is independent, merge keeps old songs, custom overrides persist', async () => {
	const f = fixture([qqPage(['a']), qqPage(['b']), qqPage(['c'])])
	const first = await f.fetchRemotePlaylist(ref())
	f.importRemotePlaylist(first, 'update', { name: 'custom', artwork: 'custom.jpg' })
	const second = await f.fetchRemotePlaylist(ref())
	const updated = f.importRemotePlaylist(second)
	assert.equal(f.playlists.length, 1)
	assert.equal(updated.name, 'custom')
	assert.equal(updated.artwork, 'custom.jpg')
	assert.equal(updated.customName, true)
	assert.deepEqual(plain(updated.songs.map((item) => item.id)), ['b'])
	const copy = f.importRemotePlaylist(second, 'copy')
	assert.notEqual(copy.id, second.id)
	assert.equal(copy.remoteBinding, undefined)
	const merged = f.importRemotePlaylist(await f.fetchRemotePlaylist(ref()), 'merge')
	assert.deepEqual(plain(merged.songs.map((item) => item.id)), ['c', 'b'])
	assert.equal(merged.songs[1].localAdded, true)
	assert.equal(f.playlists.length, 2)
})

await check('localAdded survives temporarily appearing in the remote snapshot', async () => {
	const f = fixture([qqPage(['a']), qqPage([])])
	const first = await f.fetchRemotePlaylist(ref())
	const existing = { ...first, songs: [song('a', 'QQ', { localAdded: true })] }
	const merged = f.mergeRemotePlaylist(existing, first)
	const empty = await f.fetchRemotePlaylist(ref())
	assert.equal(f.mergeRemotePlaylist(merged, empty).songs[0].id, 'a')
})

await check('importing identical remote IDs on different platforms creates separate local playlists', async () => {
	const f = fixture([qqPage(['a']), { code: 200, playlist: { trackCount: 1, trackIds: [{ id: 1 }], tracks: [netSong(1)] } }])
	f.importRemotePlaylist(await f.fetchRemotePlaylist(ref()))
	f.importRemotePlaylist(await f.fetchRemotePlaylist(ref('Netease')))
	assert.deepEqual(plain(f.playlists.map((item) => item.id)), ['remote:QQ:42', 'remote:Netease:42'])
})

await check('failed refresh can be retried and migrates a previously saved numeric binding', async () => {
	const original = { id: '42', platform: 'QQ', songs: [], remoteBinding: ref() }
	const f = fixture([new Error('offline'), qqPage(['a'])], [original])
	await assert.rejects(f.refreshRemotePlaylist('42'))
	const result = await f.refreshRemotePlaylist('42')
	assert.equal(result.id, 'remote:QQ:42')
	assert.equal(f.writes.length, 1)
})

await check('an unrelated local ID collision fails without modifying either stored playlist', async () => {
	const original = { id: '42', platform: 'QQ', songs: [] }
	const unrelated = { id: 'remote:QQ:42', platform: 'local', songs: [song('local')] }
	const f = fixture([qqPage(['a'])], [original, unrelated])
	await assert.rejects(f.refreshRemotePlaylist('42'), /ID/)
	assert.equal(f.writes.length, 0)
	assert.equal(f.playlists[0], original)
	assert.equal(f.playlists[1], unrelated)
})

function rowFixture(onRefresh) {
	const clock = fakeClock()
	const states = []
	const refs = []
	const effects = []
	const alerts = []
	const menus = []
	let stateIndex = 0
	let refIndex = 0
	let effectIndex = 0
	let opened = 0
	const react = {
		createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
		useMemo: (callback) => callback(),
		useState: (initial) => {
			const index = stateIndex++
			if (!(index in states)) states[index] = initial
			return [states[index], (value) => { states[index] = value }]
		},
		useRef: (initial) => {
			const index = refIndex++
			return refs[index] ??= { current: initial }
		},
		useEffect: (callback) => {
			const index = effectIndex++
			if (!(index in effects)) effects[index] = { callback }
		},
	}
	const { PlaylistListItem } = loadModule('src/components/PlaylistListItem.tsx', {
		react,
		'@/hooks/useAppTheme': { useThemeColors: () => ({ primary: 'blue', error: 'red' }) },
		'@/styles': { useDefaultStyles: () => ({ text: {} }) },
		'@expo/vector-icons': { Ionicons: 'Icon' },
		'expo-image': { Image: 'Image' },
		'@/helpers/userApi/remotePlaylist': { getPlaylistReference: () => ref() },
		'react-native': { ActivityIndicator: 'Spinner', Text: 'Text', TouchableHighlight: 'Row', TouchableOpacity: 'Button', View: 'View',
			StyleSheet: { create: (value) => value }, Alert: { alert: (...args) => alerts.push(args) } },
	}, { ...clock, React: react, Error })
	function render() {
		stateIndex = refIndex = effectIndex = 0
		const tree = PlaylistListItem({ playlist: { id: '42', platform: 'QQ' }, onRefresh,
			onPress: () => opened++, onMore: (_playlist, refresh) => menus.push(refresh) })
		for (const effect of effects) if (!effect.ran) {
			effect.ran = true
			effect.cleanup = effect.callback()
		}
		return tree
	}
	function all(node, type) {
		if (!node || typeof node !== 'object') return []
		return [...(node.type === type ? [node] : []), ...(node.props?.children ?? []).flat(Infinity).flatMap((child) => all(child, type))]
	}
	return { render, all, clock, alerts, menus, get opened() { return opened }, unmount: () => effects.forEach((effect) => effect.cleanup?.()) }
}

await check('row refresh/more stop propagation, show pending/check, and clean success timer on unmount', async () => {
	const pending = deferred()
	let requests = 0
	const f = rowFixture(() => { requests++; return pending.promise })
	const row = f.render()
	const buttons = f.all(row, 'Button')
	for (const button of buttons) {
		let stopped = false
		button.props.onPress({ stopPropagation: () => { stopped = true } })
		if (!stopped) row.props.onPress()
	}
	assert.equal(f.opened, 0)
	assert.equal(f.menus.length, 1)
	void f.menus[0]()
	assert.equal(requests, 1)
	assert.equal(f.all(f.render(), 'Spinner').length, 1)
	pending.resolve()
	await flush()
	assert.ok(f.all(f.render(), 'Icon').some((node) => node.props.name === 'checkmark-circle'))
	assert.equal(f.clock.pending, 1)
	f.unmount()
	assert.equal(f.clock.pending, 0)
})

await check('row refresh errors stay visible and more-menu refresh uses the same state', async () => {
	const f = rowFixture(async () => { throw new Error('missing page') })
	f.all(f.render(), 'Button')[1].props.onPress({ stopPropagation() {} })
	await f.menus[0]()
	assert.ok(f.all(f.render(), 'Icon').some((node) => node.props.name === 'alert-circle'))
	assert.equal(f.alerts[0][1], 'missing page')
	assert.equal(f.clock.pending, 0)
	f.unmount()
})

await check('unmount during an in-flight refresh cannot schedule a late success timer', async () => {
	const pending = deferred()
	const f = rowFixture(() => pending.promise)
	f.all(f.render(), 'Button')[0].props.onPress({ stopPropagation() {} })
	f.unmount()
	pending.resolve()
	await flush()
	assert.equal(f.clock.pending, 0)
})

finish()
