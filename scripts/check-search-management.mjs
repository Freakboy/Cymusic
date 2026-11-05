// Run: node scripts/check-search-management.mjs
// Execute real TypeScript with controlled hooks, network, stores and time.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

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
		tree,
		options
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
	const navigation = {
		setOptions(value) {
			options = value.headerSearchBarOptions
		},
	}
	const jsx = (type, props) => ({ type, props })
	let Screen = load(
		'src/app/(tabs)/search/index.tsx',
		{
			react,
			'react/jsx-runtime': { jsx, jsxs: jsx },
			'@/components/SearchList': { SearchList: 'SearchList' },
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
			'expo-router': { useNavigation: () => navigation },
			'@/utils/i18n': { t: (key) => key },
			'react-native': {
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
	const labels = { albums: 'Albums', playlists: 'Playlists', retry: 'Retry', searchError: 'Error' }
	const render = () => {
		cursor = 0
		tree = Screen()
		while (effects.length) effects.shift()()
	}
	const nodes = (node) => {
		if (!node || typeof node !== 'object') return []
		return [node, ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child))]
	}
	const list = () => nodes(tree).find((node) => node.type === 'SearchList').props
	const input = (value) => {
		options.onChangeText({ nativeEvent: { text: value } })
		render()
	}
	render()
	input('a')
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
	const artist = nodes(tree).filter((node) => node.type === 'Pressable')[1]
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
	options.onChangeText({ nativeEvent: { text: 'temporary' } })
	options.onChangeText({ nativeEvent: { text: 'revisit' } })
	render()
	timers.advance(350)
	assert.equal(calls.length, 7)
	assert.equal(calls[6].args[0], 'revisit')
	input('unmount')
	for (const slot of slots) slot?.cleanup?.()
	timers.advance(350)
	assert.equal(calls.length, 7)

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

// Source operations: metadata-only lx import, current-only test, serial lock and timeout.
{
	const timers = clock()
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
	const adapter = load('src/helpers/userApi/lxMusicSourceAdapter.ts', {
		'@/components/utils/nativeModules/userApi': {},
		buffer: { Buffer },
		'../logger': {},
	})
	const factory = load('src/helpers/userApi/importMusicSource.ts', {
		'./lxMusicSourceAdapter': adapter,
	})
	const reloaded = [],
		requests = []
	let response = '',
		httpStatus = 200
	// Share the production queue with simulated playback, rather than running tasks inline.
	const runtime = load('src/player/sourceResolver/runtime.ts', {
		'@/helpers/userApi/lxMusicSourceAdapter': {},
	})
	const helper = load(
		'src/helpers/sourceManagement.ts',
		{
			'@/player/MusicSourceResolver': runtime,
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
			'@/store/PersistStatus': { set: (key, value) => saved.set(key, value) },
		},
		timers,
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
	const messages = { busy: 'busy', currentOnly: 'current only' }
	await assert.rejects(helper.testCurrentSource('other', messages), /current only/)
	resolving.setValue('track')
	await assert.rejects(helper.testCurrentSource('current', messages), /busy/)
	resolving.setValue(null)
	const request = deferred()
	const playback = deferred()
	let resolverCalls = 0
	const playing = runtime.withSourceRuntimeLock(() => playback.promise)
	selected.setValue({
		id: 'current',
		getMusicUrl: () => {
			resolverCalls++
			return request.promise
		},
	})
	const result = helper.testCurrentSource('current', messages)
	await flush()
	assert.equal(resolverCalls, 0, 'Testing must wait for the active playback resolver')
	playback.resolve()
	await playing
	await flush()
	assert.equal(resolverCalls, 1)
	await assert.rejects(helper.testCurrentSource('current', messages), /busy/)
	timers.advance(15000)
	await assert.rejects(result, /timeout/)
	assert.throws(() => helper.assertSourceIdle('busy'), /busy/)
	let nextPlayback = false
	const queued = runtime.withSourceRuntimeLock(async () => {
		nextPlayback = true
	})
	await flush()
	assert.equal(nextPlayback, false, 'UI timeout must not release the runtime lock')
	request.resolve('https://audio.test/song.mp3')
	await queued
	await flush()
	assert.equal(nextPlayback, true)
	helper.assertSourceIdle('busy')
	selected.setValue({ id: 'current', getMusicUrl: async () => 'file:///not-a-remote-url' })
	await assert.rejects(helper.testCurrentSource('current', messages), /Invalid audio URL/)
	selected.setValue({ id: 'current', getMusicUrl: async () => 'https://audio.test/song.mp3' })
	await helper.testCurrentSource('current', messages)
	assert.equal(selected.getValue().id, 'current')
	for (const changed of ['selection', 'loading']) {
		const blocked = deferred()
		const holding = runtime.withSourceRuntimeLock(() => blocked.promise)
		let called = false
		selected.setValue({
			id: 'current',
			getMusicUrl: async () => {
				called = true
				return 'https://audio.test/song.mp3'
			},
		})
		const waiting = helper.testCurrentSource('current', messages)
		if (changed === 'selection') selected.setValue({ id: 'other' })
		else resolving.setValue('playback')
		const rejected = assert.rejects(waiting, /busy/)
		blocked.resolve()
		await holding
		await rejected
		assert.equal(
			called,
			false,
			'Queued tests must recheck selection and playback loading under the lock',
		)
		resolving.setValue(null)
		helper.assertSourceIdle('busy')
	}
}
// Management screen: exercise actual buttons, including disabled affordances.
{
	const labels = load('src/locales/sourceSearch.ts', {
		'@/utils/i18n': { nowLanguage: { useValue: () => 'en' } },
	}).useSourceSearchText()
	const sources = [
		{ id: 'current', enabled: true, importUrl: 'https://scripts.test/source.js' },
		{ id: 'other', enabled: true, srcUrl: 'https://homepage.test' },
	]
	let cursor = 0,
		tree
	const slots = [],
		calls = []
	const jsx = (type, props) => ({ type, props })
	const Screen = load('src/app/(modals)/sourceManagement.tsx', {
		'@/constants/tokens': {},
		'@/helpers/trackPlayerIndex': {
			setMusicApiAsSelectedById: async (id) => calls.push(['reload', id]),
		},
		'@/helpers/sourceManagement': {
			assertSourceIdle() {},
			fetchManagedSourceScript: async (url) => {
				calls.push(['fetch', url])
				return 'script'
			},
			importManagedSource: async (...args) => calls.push(['import', ...args]),
			updateManagedSource: async (...args) => calls.push(['update', ...args]),
			testCurrentSource: async (id) => calls.push(['test', id]),
		},
		'@/hooks/useAppTheme': { useThemeColors: () => ({}) },
		'@/locales/sourceSearch': { useSourceSearchText: () => labels },
		'@/player/PlayerStore': {
			musicApiStore: { useValue: () => sources },
			musicApiSelectedStore: { useValue: () => sources[0] },
		},
		'expo-document-picker': {},
		'expo-file-system': {},
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
				.concat([['StyleSheet', { create: (s) => s }]]),
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
	render()
	assert.deepEqual(
		buttons(labels.test).map((node) => node.props.disabled),
		[false, true],
	)
	assert.deepEqual(
		buttons(labels.reload).map((node) => node.props.disabled),
		[false, true],
	)
	assert.equal(buttons(labels.update).length, 1, 'Homepage-only sources must not offer URL updates')
	buttons(labels.reload)[0].props.onPress()
	await flush()
	assert.deepEqual(calls.shift(), ['reload', 'current'])
	buttons(labels.update)[0].props.onPress()
	await flush()
	assert.deepEqual(calls.shift(), ['update', 'current', labels.busy])
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
}
console.log(
	'PASS: search transport and screens, stable metadata import, URL updates and failure preservation, management buttons, current-only resolver test and shared timeout lock',
)
