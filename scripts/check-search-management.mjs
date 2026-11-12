// Run: node scripts/check-search-management.mjs
// Execute real TypeScript with controlled hooks, network, stores and time.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import CryptoJS from 'crypto-js'
import { createSourceFixture, script as lxScript } from './source-runtime-fixture.mjs'
import './check-search-play-mode.mjs'

const deferred = () => {
	let resolve, reject
	const promise = new Promise((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}
function clock() {
	let now = 0,
		next = 0
	const timers = new Map()
	return {
		setTimeout(fn, delay) {
			const id = ++next
			timers.set(id, { fn, at: now + delay })
			return id
		},
		clearTimeout(id) {
			timers.delete(id)
		},
		advance(delay) {
			now += delay
			for (const [id, timer] of [...timers])
				if (timer.at <= now) {
					timers.delete(id)
					timer.fn()
				}
		},
	}
}
function load(path, imports, timers = clock()) {
	const exports = {}
	if (imports.react && !imports.react.createElement) {
		imports.react.createElement = (type, props, ...children) => ({
			type,
			props: { ...props, children },
		})
	}
	const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
	const code = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
		},
	}).outputText
	vm.runInNewContext(
		code,
		{
			exports,
			URL,
			AbortController,
			fetch: imports.fetch,
			console,
			...timers,
			require(name) {
				if (!(name in imports)) throw new Error(`Unexpected import ${name}`)
				return imports[name]
			},
		},
		{ filename: path },
	)
	return exports
}

// Search transport: correct category, page size, metadata end and API errors.
{
	let response, request
	const search = load('src/helpers/searchAll.ts', {
		'crypto-js': CryptoJS,
		'@/player/sourceResolver/txSearch': load('src/player/sourceResolver/txSearch.ts', { 'crypto-js': CryptoJS }),
		axios: {
			post: async (...args) => {
				request = args
				return { data: response }
			},
		},
	}).default
	response = {
		code: 0,
		req_1: {
			code: 0,
			data: {
				meta: { sum: 21 },
				body: {
					singer: { list: [{ singerMID: 'singer-mid', singerID: 12, singerName: 'Artist' }] },
				},
			},
		},
	}
	const signal = new AbortController().signal
	let result = await search(' artist ', 1, 'artists', signal)
	assert.equal(request[1].req_1.param.num_per_page, 20)
	assert.equal(request[1].req_1.param.query, 'artist')
	assert.equal(request[1].req_1.param.search_type, 1)
	assert.equal(request[2].signal, signal)
	assert.equal(result.data[0].singerMID, 'singer-mid')
	assert.equal(result.hasMore, true)
	result = await search('artist', 2, 'artists')
	assert.equal(result.hasMore, false)
	for (const [type, key, number, item] of [
		['songs', 'song', 0, { mid: 'song-mid', id: 12, title: 'Song', singer: [] }],
		['albums', 'album', 2, { albumMID: 'album-mid', albumName: 'Album' }],
		['playlists', 'songlist', 3, { dissid: 123, dissname: 'Playlist' }],
	]) {
		response.req_1.data.body = { [key]: { list: [item] } }
		result = await search('query', 1, type)
		assert.equal(request[1].req_1.param.search_type, number)
		assert.equal(result.data.length, 1)
		if (type === 'songs') assert.equal(result.data[0].songmid, 'song-mid')
	}
	response = { code: 0, req_1: { code: 1000 } }
	await assert.rejects(search('x'), /Invalid search response/)
	assert.equal((await search('  ')).hasMore, false)
}

// Minimal hook driver: invoke the screen's actual handlers and async effects.
{
	const timers = clock(),
		slots = [],
		effects = []
	let cursor = 0,
		tree
	const changed = (a, b) => !a || a.length !== b.length || a.some((value, i) => value !== b[i])
	const react = {
		useState(initial) {
			const index = cursor++
			if (!slots[index]) slots[index] = { value: initial }
			return [
				slots[index].value,
				(value) => {
					slots[index].value = typeof value === 'function' ? value(slots[index].value) : value
				},
			]
		},
		useRef(initial) {
			const index = cursor++
			return (slots[index] ||= { current: initial })
		},
		useMemo(factory, deps) {
			const index = cursor++
			if (!slots[index] || changed(slots[index].deps, deps))
				slots[index] = { deps, value: factory() }
			return slots[index].value
		},
		useCallback(fn, deps) {
			return react.useMemo(() => fn, deps)
		},
		useEffect(fn, deps) {
			const index = cursor++
			if (!slots[index] || changed(slots[index].deps, deps)) {
				const previous = slots[index]
				slots[index] = { deps }
				effects.push(() => {
					previous?.cleanup?.()
					slots[index].cleanup = fn()
				})
			}
		},
	}
	react.useLayoutEffect = react.useEffect
	const calls = []
	const hotPlayback = [], hotNavigation = []
	const hotSong = { id: 'chart-song', platform: 'tx', title: 'Chart song' }
	const hotPlaylist = { id: 'catalogue-playlist', title: 'Catalogue playlist', searchKind: 'playlists' }
	const jsx = (type, props) => ({ type, props })
	let Screen = load(
		'src/app/(tabs)/search/index.tsx',
		{
			react,
			'react/jsx-runtime': { jsx, jsxs: jsx },
			'@/components/SearchList': { SearchList: 'SearchList' },
			'@/components/TracksListItem': 'TracksListItem',
			'@/helpers/trackPlayerIndex': { play: async (track) => hotPlayback.push(track) },
			'@/store/PersistStatus': { get: () => 'append' },
			'@/store/queue': { useQueue: () => ({ setActiveQueueId() {} }) },
			'@/hooks/useSearchHot': { useSearchHot: (kind) => ({ tracks: kind === 'songs' ? [hotSong] : [hotPlaylist], loading: false, error: false, retry() {} }) },
			'@/locales/searchDiscovery': { useSearchDiscoveryText: () => ({ songs: 'Hot songs', playlists: 'Hot playlists' }) },
			'expo-router': { router: { navigate: (target) => hotNavigation.push(target) } },
			'expo-image': { Image: 'Image' },
			'@/constants/tokens': {},
			'@/hooks/useAppTheme': { useThemeColors: () => ({}) },
			'@/helpers/searchAll': {
				default: (...args) => {
					const d = deferred()
					calls.push({ args, ...d })
					return d.promise
				},
				__esModule: true,
			},
			'@/locales/sourceSearch': { useSourceSearchText: () => labels },
			'@/utils/i18n': { t: (key) => key },
			'react-native': {
				ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', TouchableOpacity: 'TouchableOpacity', Alert: {},
				TextInput: 'TextInput',
				View: 'View',
				Text: 'Text',
				Pressable: 'Pressable',
				StyleSheet: { create: (s) => s },
				useWindowDimensions: () => ({ width: 400 }),
				Animated: { Value: class {}, View: 'Animated', spring: () => ({ start() {} }) },
			},
			'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
		},
		timers,
	).default
	const labels = {
		albums: 'Albums',
		playlists: 'Playlists',
		retry: 'Retry',
		searchError: 'Error',
		songSearch: 'Songs or artists',
		clearSearch: 'Clear',
	}
	const render = () => {
		cursor = 0
		tree = Screen()
		while (effects.length) effects.shift()()
	}
	const nodes = (node) => {
		if (!node || typeof node !== 'object') return []
		return [node, ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child))]
	}
	const list = () => nodes(tree).find((node) => node.type === 'SearchList')?.props ?? { tracks: [] }
	const input = (value) => {
		const field = nodes(tree).find((node) => node.type === 'TextInput')
		assert.ok(field, 'Search tab must render a visible TextInput without native header support')
		field.props.onChangeText(value)
		render()
	}
	render()
	assert.ok(nodes(tree).some((node) => node.type === 'ScrollView'), 'Empty query displays discovery')
	assert.ok(!nodes(tree).some((node) => node.type === 'SearchList'))
	await nodes(tree).find((node) => node.type === 'TracksListItem').props.onTrackSelect(hotSong)
	assert.equal(hotPlayback[0], hotSong)
	assert.ok(!nodes(tree).some((node) => node.type === 'TouchableOpacity'), 'Songs tab does not mix in playlists')
	nodes(tree).find((node) => node.type === 'Pressable' && nodes(node).some((child) => child.type === 'Text' && child.props.children === labels.playlists)).props.onPress()
	render()
	assert.ok(!nodes(tree).some((node) => node.type === 'TracksListItem'), 'Playlists tab does not mix in songs')
	nodes(tree).find((node) => node.type === 'TouchableOpacity').props.onPress()
	assert.equal(hotNavigation[0].pathname, '/(tabs)/search/collection')
	assert.equal(hotNavigation[0].params.id, 'catalogue-playlist')
	nodes(tree).find((node) => node.type === 'Pressable' && nodes(node).some((child) => child.type === 'Text' && child.props.children === 'find.songs')).props.onPress()
	render()
	const field = nodes(tree).find((node) => node.type === 'TextInput')
	assert.ok(field, 'Search tab must render a visible TextInput without native header support')
	assert.equal(field.props.style.minHeight, 44)
	input('a')
	assert.ok(!nodes(tree).some((node) => node.type === 'ScrollView'), 'Query hides both hot sections immediately')
	timers.advance(349)
	assert.equal(calls.length, 0)
	input('ab')
	timers.advance(350)
	assert.equal(calls.length, 1)
	assert.equal(calls[0].args[0], 'ab')
	input('new')
	assert.equal(calls[0].args[3].aborted, true)
	timers.advance(350)
	calls[0].resolve({ data: [{ id: 'stale' }], hasMore: false })
	await flush()
	render()
	assert.equal(list().tracks.length, 0)
	calls[1].resolve({ data: [{ id: '1' }], hasMore: true })
	await flush()
	render()
	assert.equal(list().tracks[0].id, '1')
	list().onLoadMore()
	list().onLoadMore()
	assert.equal(calls.length, 3)
	assert.equal(calls[2].args[1], 2)
	calls[2].reject(new Error('offline'))
	await flush()
	render()
	assert.equal(list().tracks.length, 1)
	assert.equal(list().error, 'Error')
	list().onLoadMore()
	assert.equal(calls.length, 3)
	list().onRetry()
	assert.equal(calls[3].args[1], 2)
	calls[3].resolve({ data: [{ id: '1' }, { id: '2' }], hasMore: false })
	await flush()
	render()
	assert.equal(list().tracks.length, 2)
	const artist = nodes(tree).find(
		(node) => node.type === 'Pressable' && node.props.children?.props?.children === 'find.artists',
	)
	artist.props.onPress()
	render()
	timers.advance(350)
	assert.equal(calls[4].args[2], 'artists')
	input('')
	calls[4].resolve({ data: [{ id: 'late-artist' }], hasMore: false })
	await flush()
	render()
	assert.equal(list().tracks.length, 0)
	input('revisit')
	timers.advance(350)
	calls[5].resolve({ data: [{ id: 'revisit' }], hasMore: false })
	await flush()
	render()
	// Batched changes can end at the same keyword React already rendered.
	nodes(tree)
		.find((node) => node.type === 'TextInput')
		.props.onChangeText('temporary')
	nodes(tree)
		.find((node) => node.type === 'TextInput')
		.props.onChangeText('revisit')
	render()
	timers.advance(350)
	assert.equal(calls.length, 7)
	assert.equal(calls[6].args[0], 'revisit')
	for (const [label, type] of [
		['Albums', 'albums'],
		['Playlists', 'playlists'],
		['find.songs', 'songs'],
	]) {
		const button = nodes(tree).find(
			(node) => node.type === 'Pressable' && node.props.children?.props?.children === label,
		)
		assert.equal(button.props.style[0].minHeight, 44)
		button.props.onPress()
		render()
		timers.advance(350)
		assert.equal(calls.at(-1).args[2], type)
		calls.at(-1).resolve({ data: [{ id: type }], hasMore: false })
		await flush()
		render()
		assert.equal(list().tracks[0].id, type)
	}
	nodes(tree)
		.find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Clear')
		.props.onPress()
	render()
	render()
	assert.equal(nodes(tree).find((node) => node.type === 'TextInput').props.value, '')
	assert.equal(list().tracks.length, 0)
	const requestCount = calls.length
	input('unmount')
	for (const slot of slots) slot?.cleanup?.()
	timers.advance(350)
	assert.equal(calls.length, requestCount)

	// Collection pages advance by the returned count, not the requested size.
	slots.length = 0
	calls.length = 0
	let params = { id: 'playlist', kind: 'playlists', title: 'Fixture' }
	Screen = load(
		'src/app/(tabs)/search/collection.tsx',
		{
			react,
			'react/jsx-runtime': { jsx, jsxs: jsx },
			'@/components/SearchList': { SearchList: 'SearchList' },
			'@/hooks/useAppTheme': { useThemeColors: () => ({}) },
			'@/locales/sourceSearch': { useSourceSearchText: () => labels },
			'expo-router': { Stack: { Screen: 'Screen' }, useLocalSearchParams: () => params },
			'react-native': { View: 'View' },
			axios: {
				get: (...args) => {
					const d = deferred()
					calls.push({ args, ...d })
					return d.promise
				},
			},
		},
		timers,
	).default
	const collectionPage = (ids, total, begin) => ({
		data: {
			code: 0,
			cdlist: [
				{
					total_song_num: total,
					song_begin: begin,
					songlist: ids.map((mid) => ({ mid, title: mid, singer: [] })),
				},
			],
		},
	})
	render()
	calls[0].resolve(collectionPage(['1', '2'], 3, 0))
	await flush()
	render()
	assert.equal(list().hasMore, true)
	list().onLoadMore()
	list().onLoadMore()
	assert.equal(calls.length, 2)
	assert.match(calls[1].args[0], /song_begin=2&/)
	calls[1].reject(new Error('offline'))
	await flush()
	render()
	assert.equal(list().tracks.length, 2)
	list().onRetry()
	assert.match(calls[2].args[0], /song_begin=2&/)
	calls[2].resolve(collectionPage(['3'], 3, 2))
	await flush()
	render()
	assert.equal(list().tracks.length, 3)
	assert.equal(list().hasMore, false)
	params = { id: 'another', kind: 'playlists', title: 'Another' }
	render()
	params = { id: 'album', kind: 'albums', title: 'Album' }
	render()
	assert.equal(calls[3].args[1].signal.aborted, true)
	calls[3].resolve(collectionPage(['stale'], 1, 0))
	await flush()
	render()
	assert.equal(list().tracks.length, 0)
	calls[4].resolve({
		data: {
			code: 0,
			data: { total_song_num: 1, song_begin: 0, list: [{ songmid: 'album-song', singer: [] }] },
		},
	})
	await flush()
	render()
	assert.equal(list().tracks[0].id, 'album-song')
	assert.equal(list().hasMore, false)
}

// Source operations: metadata-only lx import, unselected isolation, serial lock and timeout.
{
	const platformRequests = []
	const fixture = createSourceFixture({ imports: {
		'crypto-js': CryptoJS,
		'crypto-js/sha256': CryptoJS.SHA256,
		axios: { request: async (request) => {
			platformRequests.push(request)
			return { data: { code: 200, data: { resources: [{ baseInfo: { simpleSongData: {
				id: 109998, name: '贝加尔湖畔', ar: [{ name: '李健' }], al: { name: '依然', id: 10888 }, dt: 245600,
			} } }] } } }
		} },
	} })
	const platforms = fixture.load('src/player/sourceResolver/platforms')
	const timers = fixture.clock
	const store = (value) => ({
		getValue: () => value,
		setValue: (next) => {
			value = next
		},
	})
	const selected = store(null),
		sources = store([]),
		resolving = store(null)
	const saved = new Map(),
		added = []
	const nowPersist = {
		get: (key) => saved.get(key) ?? null,
		set: (key, value) => saved.set(key, value),
		useValue: (key, fallback) => saved.get(key) ?? fallback,
	}
	const adapter = fixture.adapter
	const factory = load('src/helpers/userApi/importMusicSource.ts', {
		'./lxMusicSourceAdapter': adapter,
	})
	const reloaded = [],
		requests = [],
		matchRequests = []
	let matchError
	let response = '',
		httpStatus = 200
	// Share the production queue with simulated playback, rather than running tasks inline.
	const runtime = load('src/player/sourceResolver/runtime.ts', {
		'@/helpers/userApi/lxMusicSourceAdapter': adapter,
	}, timers)
	const helper = load(
		'src/helpers/sourceManagement.ts',
		{
			'@/player/sourceResolver/runtime': runtime,
			'@/player/sourceResolver/platforms': {
				RESOLUTION_PLATFORMS: ['tx', 'wy', 'kg', 'kw', 'mg'],
				resolvePlatformMusicInfo: async (item, platform) => {
					matchRequests.push({ item, platform })
					if (platform === 'wy' && matchError) throw matchError
					if (platform === 'wy' && item.id === '109998') return platforms.resolvePlatformMusicInfo(item, platform)
					return { source: platform, songmid: platform === 'tx' ? '004IArbh3ytHgR' : item.id }
				},
			},
			fetch: async (url, options) => {
				requests.push({ url, options })
				return { ok: httpStatus === 200, status: httpStatus, text: async () => response }
			},
			'@/helpers/trackPlayerIndex': {
				addMusicApi: (source) => added.push(source),
				setMusicApiAsSelectedById: async (id) => reloaded.push(id),
			},
			'@/helpers/userApi/importMusicSource': factory,
			'@/helpers/userApi/lxMusicSourceAdapter': adapter,
			'@/player/PlayerStore': {
				musicApiSelectedStore: selected,
				musicApiStore: sources,
				trackSourceLoadingStore: resolving,
			},
			'@/store/PersistStatus': nowPersist,
		},
		timers,
	)
	assert.equal(
		helper
			.describeSourceChannels({ platform: 'tx' })
			.every((channel) => channel.state === 'undeclared'),
		true,
	)
	const channels = helper.describeSourceChannels({
		sources: {
			tx: { actions: ['musicUrl'], qualitys: ['128k'] },
			wy: { actions: [] },
			kg: false,
		},
	})
	assert.deepEqual(
		Array.from(channels, (channel) => channel.id),
		['tx', 'wy', 'kg', 'kw', 'mg'],
	)
	assert.deepEqual(
		Array.from(channels, (channel) => channel.state),
		['supported', 'unsupported', 'unsupported', 'undeclared', 'undeclared'],
	)
	const lx = (version = '1') =>
		`/**\n * @name fixture\n * @author author\n * @version ${version}\n * @homepage https://homepage.test\n */\nlx.on(lx.EVENT_NAMES.request, () => {});`
	await helper.importManagedSource(lx(), 'busy', 'https://scripts.test/source.js')
	assert.equal(added[0].getMusicUrl, undefined)
	assert.equal(added[0].enabled, true)
	assert.equal(added[0].importUrl, 'https://scripts.test/source.js')
	await helper.importManagedSource(lx('2'), 'busy')
	assert.equal(added[1].id, added[0].id, 'Version must not affect stable lx IDs')
	const original = { ...added[0], id: 'legacy-lx-id', enabled: false, isSelected: false }
	sources.setValue([{ id: 'first' }, original, { id: 'last' }])
	await helper.importManagedSource(lx('3'), 'busy')
	assert.equal(added[2].id, original.id)
	assert.equal(added[2].enabled, false)
	assert.equal(added[2].importUrl, original.importUrl)
	const snapshot = sources.getValue()
	for (const invalid of [
		'',
		'<html>homepage</html>',
		'module.exports = {}',
		`${lx()}\nconst = ;`,
	]) {
		response = invalid
		await assert.rejects(helper.updateManagedSource(original.id, 'busy'))
		assert.equal(sources.getValue(), snapshot, 'Invalid update must leave old sources intact')
	}
	httpStatus = 503
	await assert.rejects(helper.updateManagedSource(original.id, 'busy'), /HTTP 503/)
	assert.equal(sources.getValue(), snapshot)
	httpStatus = 200
	response = lx('4')
	await helper.updateManagedSource(original.id, 'busy')
	assert.equal(requests.at(-1).url, original.importUrl)
	assert.equal(sources.getValue()[1].id, original.id)
	assert.equal(sources.getValue()[1].enabled, false)
	assert.equal(sources.getValue()[1].version, '4')
	assert.equal(sources.getValue()[0], snapshot[0])
	assert.equal(sources.getValue()[2], snapshot[2])
	assert.equal(reloaded.length, 0)
	selected.setValue({ id: original.id })
	response =
		'module.exports = { id: "different", name: "native", getMusicUrl: async () => "https://audio.test/a" }'
	await helper.updateManagedSource(original.id, 'busy')
	assert.equal(sources.getValue()[1].id, original.id)
	assert.equal(sources.getValue()[1].importUrl, original.importUrl)
	assert.deepEqual(reloaded, [original.id])
	sources.setValue([{ id: 'homepage-only', srcUrl: 'https://homepage.test' }])
	const count = requests.length
	await assert.rejects(helper.updateManagedSource('homepage-only', 'busy'), /no import URL/)
	assert.equal(requests.length, count)
	await assert.rejects(helper.fetchManagedSourceScript('file:///source.js'), /HTTP\(S\)/)
	helper.saveSourceList([{ id: 'disabled', enabled: false }])
	assert.equal(saved.get('music.musicApi'), sources.getValue())
	await assert.rejects(helper.testSourceChannels('missing', 'busy'), /SOURCE_NOT_FOUND/)
	selected.setValue({ id: 'current' })
	resolving.setValue('track')
	await assert.rejects(helper.testSourceChannels('current', 'busy'), /busy/)
	resolving.setValue(null)
	const playback = deferred()
	const playing = runtime.withSourceRuntimeLock(() => playback.promise)
	const unselected = {
		id: 'other',
		script: 'let calls = 0; module.exports = { getMusicUrl: async () => ++calls === 1 ? { url: "https://audio.test/isolated", headers: { Referer: "test" } } : null }',
		getMusicUrl: () => { throw new Error('must not execute selected closure') },
	}
	const current = { id: 'current', getMusicUrl: () => 'https://audio.test/playback' }
	selected.setValue(current)
	sources.setValue([current, unselected])
	const sourceSnapshot = sources.getValue()
	const savedSnapshot = saved.get('music.musicApi')
	const result = helper.testSourceChannels('other', 'busy')
	let testSettled = false
	void result.then(() => { testSettled = true })
	await flush()
	await assert.rejects(helper.testSourceChannels('other', 'busy'), /busy/)
	assert.equal(testSettled, false, 'Diagnostics must wait for the playback runtime lock')
	playback.resolve()
	await playing
	const results = await result
	assert.equal(results[0].urlResolved, true)
	assert.equal(results[0].state, 'undeclared')
	assert.equal(results.every(channel => channel.playbackVerified === false), true)
	assert.equal(results.slice(1).every(channel => channel.state === 'undeclared' && !channel.urlResolved), true)
	assert.equal(selected.getValue(), current)
	assert.equal(await current.getMusicUrl(), 'https://audio.test/playback')
	assert.equal(sources.getValue(), sourceSnapshot)
	assert.equal(saved.get('music.musicApi'), savedSnapshot)
	const repeated = await helper.testSourceChannels('other', 'busy')
	assert.equal(repeated[0].urlResolved, true, 'Each test must execute a fresh script closure')
	helper.assertSourceIdle('busy')
	const multi = {
		id: 'multi',
		script: `module.exports = {
			sources: {
				tx: { actions: ['musicUrl'], qualitys: ['128k'] },
				wy: { actions: ['musicUrl'], qualitys: ['320k'] },
				kg: false,
				mg: { actions: ['musicUrl'], qualitys: ['flac'] }
			},
			getMusicUrl: async (title, artist, mid, quality, context) => {
				if (context.musicInfo.source !== context.platform) throw new Error('WRONG_PLATFORM')
				if (context.platform === 'wy') {
					if (title !== '贝加尔湖畔' || artist !== '李健' || mid !== '' || context.musicInfo.songmid !== 109998 || quality !== '320k') throw new Error('WRONG_WY_SAMPLE')
					throw new Error('WY_OFFLINE')
				}
				if (context.platform === 'tx' && (mid !== '004IArbh3ytHgR' || quality !== '128k')) throw new Error('WRONG_TX')
				if (context.platform === 'mg' && (mid !== '' || quality !== 'flac')) throw new Error('WRONG_MG')
				return 'https://audio.test/' + context.platform
			}
		}`,
	}
	sources.setValue([current, multi])
	matchRequests.length = 0
	const multiResults = await helper.testSourceChannels(multi.id, 'busy')
	const wySample = matchRequests.find(({ platform }) => platform === 'wy').item
	assert.equal(wySample.title, '贝加尔湖畔', 'WY defaults must use an available native sample, not QQ 稻香')
	assert.equal(wySample.artist, '李健')
	assert.equal(wySample.album, '依然')
	assert.equal(wySample.platform, 'wy')
	assert.equal(String(wySample.id), '109998')
	assert.ok(!wySample.duration, 'WY sample duration must not be guessed')
	assert.equal(platformRequests.length, 1, 'Default WY must use the real business search and strict matcher')
	assert.equal(platformRequests[0].url, 'https://interface.music.163.com/eapi/batch')
	const wyInfo = await platforms.resolvePlatformMusicInfo(wySample, 'wy')
	assert.equal(wyInfo.songmid, 109998, 'Only the matched native WY ID reaches the plugin')
	assert.equal(wyInfo.duration, 245.6)
	for (const changed of [
		{ title: '贝加尔湖畔 (Live)' }, { artist: 'Other' }, { album: 'Other' }, { duration: 200 },
	]) assert.equal(platforms.selectPlatformMatch({ ...wySample, ...changed }, [wyInfo]), null)
	for (const { item, platform } of matchRequests.filter(({ platform }) => platform !== 'wy')) {
		assert.equal(item.title, '稻香', platform)
		assert.equal(item.artist, '周杰伦', platform)
		assert.equal(item.songmid, '003aAYrm3GE0Ac', platform)
	}
	assert.deepEqual(Array.from(multiResults, ({ id, state, urlResolved }) => [id, state, urlResolved]), [
		['tx', 'supported', true], ['wy', 'failed', false], ['kg', 'unsupported', false],
		['kw', 'undeclared', false], ['mg', 'supported', true],
	])
	assert.match(multiResults[1].error, /^(?:Error: )?WY_OFFLINE$/)
	assert.equal(multiResults[1].failureStage, 'urlResolution')
	assert.equal(multiResults[1].declaredState, 'supported')
	assert.equal(multiResults[0].failureStage, undefined)
	const custom = { id: 'custom-id', platform: 'tx', title: 'Custom', artist: 'Artist', album: 'Custom album', duration: 100 }
	matchRequests.length = 0
	matchError = new Error('wy_MATCH_NOT_FOUND')
	const unmatched = await helper.testSourceChannels(multi.id, 'busy', { item: custom })
	assert.ok(matchRequests.every(({ item }) => item === custom), 'Explicit samples must never be replaced, even on matching failure')
	assert.equal(unmatched[1].failureStage, 'matching')
	assert.match(unmatched[1].error, /^(?:Error: )?wy_MATCH_NOT_FOUND$/)
	assert.equal(unmatched[1].declaredState, 'supported')
	assert.equal(unmatched[1].urlResolved, false)
	assert.equal(unmatched[4].urlResolved, true, 'Matching failure must not prevent later channels from being tested')
	matchError = undefined
	const customRequest = {
		id: 'custom-request',
		script: `module.exports = { sources: { wy: {actions:['musicUrl'], qualitys:['128k']} },
			getMusicUrl: async (title, artist, mid, quality, context) => {
				if (title !== 'Custom' || artist !== 'Artist' || mid !== '' || context.musicInfo.songmid !== 'custom-id') throw new Error('CUSTOM_REPLACED')
				return 'https://audio.test/custom'
			} }`,
	}
	sources.setValue([current, multi, customRequest])
	assert.equal((await helper.testSourceChannels(customRequest.id, 'busy', { item: custom }))[1].urlResolved, true)
	const broken = { id: 'broken', sources: { wy: {actions: ['musicUrl'], qualitys: ['128k']}, kg: false }, script: 'throw new Error("INIT_FAILED")' }
	sources.setValue([current, multi, broken])
	const initialization = await helper.testSourceChannels(broken.id, 'busy')
	assert.ok(initialization.every(({ failureStage, urlResolved }) => failureStage === 'initialization' && !urlResolved))
	assert.equal(initialization[1].declaredState, 'supported')
	assert.equal(initialization[2].declaredState, 'unsupported')
	assert.match(initialization[1].error, /INIT_FAILED/)
	assert.ok(multiResults.every((channel) => channel.playbackVerified === false))
	assert.equal(selected.getValue(), current)
	assert.equal(saved.get('music.musicApi'), savedSnapshot)
	for (const changed of ['selection', 'loading']) {
		const blocked = deferred()
		const holding = runtime.withSourceRuntimeLock(() => blocked.promise)
		const waiting = helper.testSourceChannels(multi.id, 'busy')
		const replacement = { id: 'replacement', getMusicUrl: () => 'https://audio.test/replacement' }
		if (changed === 'selection') selected.setValue(replacement)
		else resolving.setValue('playback')
		const checked = changed === 'loading'
			? assert.rejects(waiting, /busy/)
			: waiting.then((results) => {
				assert.equal(results[0].urlResolved, true)
				assert.equal(selected.getValue(), replacement, 'Queued tests must preserve the latest selection')
			})
		blocked.resolve()
		await holding
		await checked
		resolving.setValue(null)
		helper.assertSourceIdle('busy')
	}
	sources.setValue([])
	selected.setValue({ id: 'current', script: 'module.exports = { sources: {tx: {actions:["musicUrl"],qualitys:["128k"]}, wy: false}, getMusicUrl: async () => "file:///invalid" }' })
	const failed = await helper.testSourceChannels('current', 'busy')
	assert.equal(failed[0].state, 'failed')
	assert.equal(failed[1].state, 'unsupported')
	assert.equal(failed[0].error, 'INVALID_AUDIO_URL')
	assert.equal(failed[0].failureStage, 'urlResolution')
	selected.setValue({ id: 'current', script: 'module.exports = {getMusicUrl: () => new Promise(() => {})}' })
	const timeout = helper.testSourceChannels('current', 'busy')
	await flush()
	timers.advance(5000)
	assert.match((await timeout)[0].error, /^(?:Error: )?SOURCE_REQUEST_TIMEOUT$/)
	helper.assertSourceIdle('busy')
	assert.equal(await runtime.withSourceRuntimeLock(async () => true), true)

	// Use the actual adapter and native event fixture to verify singleton restoration.
	const loadedCurrent = await fixture.initialized('playback')
	selected.setValue(loadedCurrent)
	const otherLx = { id: 'other-lx', scriptType: 'lxmusic', script: lxScript('diagnostic') }
	sources.setValue([loadedCurrent, otherLx])
	const lxSnapshot = sources.getValue()
	const loadCount = fixture.native.loads.length
	const diagnostic = helper.testSourceChannels(otherLx.id, 'busy')
	await flush()
	assert.equal(fixture.native.loads.length, loadCount + 1)
	fixture.native.init(undefined, { info: { sources: {
		tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] }, wy: false,
	} } })
	await flush()
	const request = fixture.native.sent.at(-1)
	assert.equal(request.action, 'request')
	fixture.native.emit('response', {
		requestKey: request.data.requestKey, status: true,
		result: { action: 'musicUrl', data: { url: 'https://audio.test/lx-test' } },
	})
	await flush()
	assert.equal(fixture.native.loads.length, loadCount + 2, 'Selected lx runtime must be reloaded after diagnostics')
	assert.equal(fixture.native.loads.at(-1).info.script, loadedCurrent.script)
	fixture.native.init(undefined, { info: { sources: {
		tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
	} } })
	assert.equal((await diagnostic)[0].urlResolved, true)
	const restored = selected.getValue()
	assert.equal(restored.id, loadedCurrent.id)
	assert.notEqual(restored, loadedCurrent)
	assert.equal(sources.getValue(), lxSnapshot)
	assert.equal(saved.get('music.musicApi'), savedSnapshot)
	const resumed = runtime.withSourceRuntimeLock(() => runtime.requestSourceUrl(
		restored, 'Song', 'Artist', 'mid', '128k', { platform: 'tx', timeoutMs: 5000 },
	))
	await flush()
	const resumedRequest = fixture.native.sent.at(-1)
	assert.equal(resumedRequest.generation, fixture.native.loads.at(-1).generation)
	fixture.native.emit('response', {
		requestKey: resumedRequest.data.requestKey, status: true,
		result: { action: 'musicUrl', data: { url: 'https://audio.test/resumed' } },
	})
	const resumedUrl = await resumed
	assert.equal(typeof resumedUrl === 'string' ? resumedUrl : resumedUrl.url, 'https://audio.test/resumed')
	runtime.releaseResolverRuntime()
	helper.assertSourceIdle('busy')
}
// Management screen: exercise native menu actions and their disabled/hidden affordances.
if (!process.argv.includes('--helpers-only')) {
	let labels = load('src/locales/sourceSearch.ts', {
		'@/utils/i18n': { nowLanguage: { useValue: () => 'en' } },
	}).useSourceSearchText()
	let sources = [
		{ id: 'current', name: 'Current', enabled: true, importUrl: 'https://scripts.test/source.js' },
		{ id: 'other', name: 'Other', enabled: true, srcUrl: 'https://homepage.test' },
	]
	let selected = sources[0]
	let pendingTest
	const alerts = []
	const channelResults = [
		{ id: 'tx', state: 'supported', urlResolved: true },
		{ id: 'wy', state: 'failed', urlResolved: false, error: 'WY_OFFLINE' },
		{ id: 'kg', state: 'unsupported', urlResolved: false },
		{ id: 'kw', state: 'undeclared', urlResolved: false },
		{ id: 'mg', state: 'supported', urlResolved: true },
	]
	let cursor = 0,
		tree
	const slots = [],
		calls = []
	const jsx = (type, props) => ({ type, props })
	const Screen = load('src/app/(modals)/sourceManagement.tsx', {
		'@/constants/tokens': {},
		'@expo/vector-icons': { Ionicons: 'Ionicons' },
		'@react-native-menu/menu': { MenuView: 'MenuView' },
		'@/helpers/trackPlayerIndex': {
			setMusicApiAsSelectedById: async (id) => {
				calls.push(['select/reload', id])
				selected = sources.find((source) => source.id === id)
			},
			deleteMusicApiById: (id) => {
				calls.push(['delete', id])
				sources = sources.filter((source) => source.id !== id)
			},
		},
		'@/helpers/sourceManagement': {
			describeSourceChannels: () =>
				['tx', 'wy', 'kg', 'kw', 'mg'].map((id) => ({ id, state: 'undeclared', qualitys: [] })),
			assertSourceIdle() {},
			saveSourceList: (next) => {
				calls.push(['save', Array.from(next, (source) => [source.id, source.enabled])])
				sources = next
			},
			fetchManagedSourceScript: async (url) => {
				calls.push(['fetch', url])
				return 'script'
			},
			importManagedSource: async (...args) => calls.push(['import', ...args]),
			updateManagedSource: async (...args) => calls.push(['update', ...args]),
			testSourceChannels: (id, busy) => {
				calls.push(['test', id, busy])
				pendingTest = deferred()
				return pendingTest.promise
			},
		},
		'@/hooks/useAppTheme': { useThemeColors: () => ({}) },
		'@/locales/sourceSearch': { useSourceSearchText: () => labels },
		'@/player/PlayerStore': {
			musicApiStore: { useValue: () => sources, getValue: () => sources },
			musicApiSelectedStore: { useValue: () => selected, getValue: () => selected },
		},
		'expo-document-picker': { getDocumentAsync: async (options) => {
			calls.push(['pick', options])
			return { canceled: false, assets: [{ uri: 'file:///source.js' }] }
		} },
		'expo-file-system': { File: class {
			constructor(uri) { assert.equal(uri, 'file:///source.js') }
			async text() { return 'file script' }
		} },
		'expo-router': { Stack: { Screen: 'Screen' }, router: {} },
		react: {
			useMemo: (fn) => fn(),
			useRef: (value) => (slots[cursor++] ||= { current: value }),
			useState: (value) => {
				const i = cursor++
				if (!(i in slots)) slots[i] = value
				return [
					slots[i],
					(next) => {
						slots[i] = typeof next === 'function' ? next(slots[i]) : next
					},
				]
			},
		},
		'react/jsx-runtime': { jsx, jsxs: jsx },
		'react-native': Object.fromEntries(
			[
				'ActivityIndicator',
				'Alert',
				'Pressable',
				'ScrollView',
				'Switch',
				'Text',
				'TextInput',
				'View',
			]
				.map((name) => [name, name])
				.concat([
					['StyleSheet', { create: (s) => s }],
					['Alert', { alert: (...args) => alerts.push(args) }],
				]),
		),
		'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
	}).default
	const render = () => {
		cursor = 0
		tree = Screen()
	}
	const nodes = (node) =>
		!node || typeof node !== 'object'
			? []
			: [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
	const buttons = (label) =>
		nodes(tree).filter(
			(node) => node.type === 'Pressable' && node.props.children?.props?.children === label,
		)
	const menu = (id) => {
		const index = sources.findIndex((source) => source.id === id)
		assert.ok(index >= 0, `Source ${id} must be rendered`)
		const node = nodes(tree).filter((node) => node.type === 'MenuView')[index]
		assert.ok(node, `Source ${id} must expose a native menu`)
		assert.equal(node.props.children.props.disabled, false)
		assert.equal(node.props.children.props.accessibilityLabel, `${sources[index].name}: ${labels.more}`)
		return node
	}
	const action = (id, event) => {
		const item = menu(id).props.actions.find((item) => item.id === event)
		assert.ok(item, `Menu must contain ${event} for ${id}`)
		return item
	}
	const pressAction = async (id, event) => {
		const item = action(id, event)
		assert.ok(!item.attributes?.disabled, `${event} must be enabled for ${id}`)
		assert.ok(!item.attributes?.hidden, `${event} must be visible for ${id}`)
		menu(id).props.onPressAction({ nativeEvent: { event } })
		await flush()
		render()
	}
	const toggle = async (id, value) => {
		const node = nodes(tree).find((node) => node.type === 'Switch' &&
			node.props.accessibilityLabel === `${sources.find((source) => source.id === id).name}: ${labels.enabled}`)
		assert.equal(node.props.disabled, false)
		node.props.onValueChange(value)
		await flush()
		render()
	}
	render()
	for (const id of ['current', 'other']) {
		assert.deepEqual(Array.from(menu(id).props.actions, (item) => item.id),
			['capabilities', 'select', 'reload', 'update', 'test', 'up', 'down', 'delete'])
		assert.equal(action(id, 'test').attributes.disabled, false, 'Unselected enabled sources can be tested')
	}
	assert.equal(action('current', 'select').attributes.disabled, true)
	assert.equal(action('current', 'select').state, 'on')
	assert.equal(action('other', 'select').attributes.disabled, false)
	assert.equal(action('current', 'reload').attributes.disabled, false)
	assert.equal(action('other', 'reload').attributes.disabled, true)
	assert.equal(action('current', 'up').attributes.disabled, true)
	assert.equal(action('other', 'down').attributes.disabled, true)
	assert.equal(action('other', 'update').attributes.hidden, true, 'Homepage is not an import URL')
	await pressAction('current', 'capabilities')
	const capabilityAlert = alerts.shift()
	assert.equal(capabilityAlert[0], 'Current')
	for (const name of ['channelTx', 'channelWy', 'channelKg', 'channelKw', 'channelMg'])
		assert.ok(capabilityAlert[1].includes(`${labels[name]}: ${labels.undeclared}`))
	await pressAction('current', 'reload')
	assert.deepEqual(calls.shift(), ['select/reload', 'current'])
	await pressAction('current', 'update')
	assert.deepEqual(calls.shift(), ['update', 'current', labels.busy])
	await pressAction('other', 'test')
	assert.deepEqual(calls.shift(), ['test', 'other', labels.busy])
	assert.equal(selected.id, 'current', 'Testing an unselected source must not select it')
	assert.ok(nodes(tree).some((node) => node.type === 'Text' && node.props.children === labels.testing))
	assert.equal(buttons(labels.importFile)[0].props.disabled, true)
	assert.ok(nodes(tree).filter((node) => node.type === 'Switch').every((node) => node.props.disabled))
	for (const node of nodes(tree).filter((node) => node.type === 'MenuView')) {
		assert.equal(node.props.children.props.disabled, true)
		assert.ok(node.props.actions.filter((item) => item.id !== 'capabilities').every((item) => item.attributes.disabled))
		node.props.onPressAction({ nativeEvent: { event: 'delete' } })
	}
	assert.equal(alerts.length, 0, 'Busy menus must ignore events')
	pendingTest.resolve(channelResults)
	await flush()
	render()
	const summary = [
		`${labels.channelTx}: ${labels.resolved}`,
		`${labels.channelWy}: ${labels.failed} (WY_OFFLINE)`,
		`${labels.channelKg}: ${labels.unsupported}`,
		`${labels.channelKw}: ${labels.undeclared}`,
		`${labels.channelMg}: ${labels.resolved}`,
	].join('\n')
	assert.ok(nodes(tree).some((node) => node.type === 'Text' && node.props.children === summary),
		'Each platform must show its own success, failure, unsupported or unknown result')
	const english = labels
	const chinese = load('src/locales/sourceSearch.ts', {
		'@/utils/i18n': { nowLanguage: { useValue: () => 'zh' } },
	}).useSourceSearchText()
	assert.equal(chinese.sampleNotMatched, '测试样本未匹配，不代表渠道不支持')
	for (const language of [english, chinese]) {
		labels = language
		render()
		await pressAction('other', 'test')
		assert.deepEqual(calls.shift(), ['test', 'other', labels.busy])
		pendingTest.resolve([
			{ id: 'tx', state: 'failed', failureStage: 'initialization', error: 'INIT_FAILED' },
			{ id: 'wy', state: 'failed', declaredState: 'supported', failureStage: 'matching', error: 'wy_MATCH_NOT_FOUND' },
			{ id: 'kg', state: 'unsupported' },
			{ id: 'kw', state: 'failed', error: 'UNKNOWN_ERROR' },
			{ id: 'mg', state: 'failed', failureStage: 'urlResolution', error: 'INVALID_AUDIO_URL' },
		])
		await flush()
		render()
		const expected = [
			`${labels.channelTx}: ${labels.initializationFailed} (INIT_FAILED)`,
			`${labels.channelWy}: ${labels.sampleNotMatched} (wy_MATCH_NOT_FOUND)`,
			`${labels.channelKg}: ${labels.unsupported}`,
			`${labels.channelKw}: ${labels.failed} (UNKNOWN_ERROR)`,
			`${labels.channelMg}: ${labels.urlResolutionFailed} (INVALID_AUDIO_URL)`,
		].join('\n')
		assert.ok(nodes(tree).some((node) => node.type === 'Text' && node.props.children === expected),
			'Matching, URL resolution and initialization failures need distinct localized labels, with generic fallback')
	}
	labels = english
	render()
	await toggle('current', false)
	assert.equal(sources[0].enabled, true)
	assert.ok(nodes(tree).some((node) => node.props.accessibilityRole === 'alert' &&
		[node.props.children].flat().includes(labels.disableSelected)))
	assert.equal(calls.length, 0)
	await toggle('other', false)
	assert.deepEqual(calls.shift(), ['save', [['current', true], ['other', false]]])
	assert.equal(action('other', 'test').attributes.disabled, true)
	assert.equal(action('other', 'select').attributes.disabled, true)
	assert.ok(nodes(tree).some((node) => node.type === 'Pressable' &&
		node.props.accessibilityLabel === `Other: ${labels.select}` && node.props.disabled))
	await toggle('other', true)
	assert.deepEqual(calls.shift(), ['save', [['current', true], ['other', true]]])
	await pressAction('other', 'select')
	assert.deepEqual(calls.shift(), ['select/reload', 'other'])
	assert.equal(selected.id, 'other')
	assert.equal(action('other', 'select').state, 'on')
	assert.equal(action('current', 'reload').attributes.disabled, true)
	await pressAction('current', 'down')
	assert.deepEqual(calls.shift(), ['save', [['other', true], ['current', true]]])
	assert.equal(action('current', 'down').attributes.disabled, true)
	await pressAction('current', 'up')
	assert.deepEqual(calls.shift(), ['save', [['current', true], ['other', true]]])
	nodes(tree)
		.find((node) => node.type === 'TextInput')
		.props.onChangeText(' https://scripts.test/new.js ')
	render()
	buttons(labels.importUrl)[0].props.onPress()
	await flush()
	assert.deepEqual(calls.shift(), ['fetch', 'https://scripts.test/new.js'])
	assert.deepEqual(calls.shift(), ['import', 'script', labels.busy, 'https://scripts.test/new.js'])
	render()
	assert.equal(buttons(labels.importUrl)[0].props.disabled, true)
	buttons(labels.importFile)[0].props.onPress()
	await flush()
	const picked = calls.shift()
	assert.equal(picked[0], 'pick')
	assert.equal(picked[1].copyToCacheDirectory, true)
	assert.equal(picked[1].multiple, false)
	assert.deepEqual(calls.shift(), ['import', 'file script', labels.busy])
	render()
	await pressAction('current', 'delete')
	assert.equal(action('current', 'delete').attributes.destructive, true)
	let confirmation = alerts.shift()
	assert.equal(confirmation[0], labels.delete)
	assert.equal(confirmation[1], labels.confirmDelete)
	assert.equal(confirmation[2].find((button) => button.style === 'cancel').text, labels.cancel)
	assert.equal(sources.length, 2, 'Opening confirmation must not delete the source')
	assert.equal(calls.length, 0)
	// Dismiss once, then explicitly confirm a fresh deletion dialog.
	await pressAction('current', 'delete')
	confirmation = alerts.shift()
	confirmation[2].find((button) => button.style === 'destructive').onPress()
	await flush()
	render()
	assert.deepEqual(calls.shift(), ['delete', 'current'])
	assert.deepEqual(Array.from(sources, (source) => source.id), ['other'])
	assert.equal(nodes(tree).filter((node) => node.type === 'MenuView').length, 1)
	assert.equal(calls.length, 0)
}
console.log(
	process.argv.includes('--helpers-only')
		? 'PASS: search transport, stable source import/update, isolated platform diagnostics, capability states and timeout queue release (management screen skipped)'
		: 'PASS: search/source management including isolated diagnostics and management screen',
)
