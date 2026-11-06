// Execute the actual home screen with deterministic hooks, requests and time.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const slots = [],
	effects = [],
	timers = new Map(),
	calls = []
let cursor = 0,
	tree,
	header,
	homeLoads = 0,
	loading = false,
	nextTimer = 0,
	now = 0
const tracks = [{ id: 'home', title: 'Recommended', artist: 'Local' }]
const changed = (a, b) => !a || a.length !== b.length || a.some((v, i) => v !== b[i])
const react = {
	useState(initial) {
		const i = cursor++
		if (!slots[i]) slots[i] = { value: initial }
		return [
			slots[i].value,
			(v) => {
				slots[i].value = typeof v === 'function' ? v(slots[i].value) : v
			},
		]
	},
	useRef(initial) {
		return (slots[cursor++] ||= { current: initial })
	},
	useMemo(fn, deps) {
		const i = cursor++
		if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() }
		return slots[i].value
	},
	useCallback(fn, deps) {
		return react.useMemo(() => fn, deps)
	},
	useEffect(fn, deps) {
		const i = cursor++
		if (!slots[i] || changed(slots[i].deps, deps)) {
			const previous = slots[i]
			slots[i] = { deps }
			effects.push(() => {
				previous?.cleanup?.()
				slots[i].cleanup = fn()
			})
		}
	},
}
const jsx = (type, props) => ({ type, props })
const fetchTracks = () => homeLoads++
const imports = {
	react,
	'react/jsx-runtime': { jsx, jsxs: jsx },
	'@/components/TracksList': { TracksList: 'TracksList' },
	'@/components/SearchList': { SearchList: 'SearchList' },
	'@/constants/tokens': { screenPadding: { horizontal: 16 } },
	'@/helpers/filter': { trackTitleFilter: (q) => (t) => t.title.includes(q) },
	'@/helpers/miscellaneous': { generateTracksListId: (...args) => args.join(':') },
	'@/helpers/trackPlayerIndex': { songsNumsToLoadStore: { useValue: () => 20 } },
	'@/hooks/useAppTheme': { useThemeColors: () => ({}) },
	'@/hooks/useNavigationSearch': {
		useNavigationSearch: () => {
			const [value, set] = react.useState('')
			header = set
			return value
		},
	},
	'@/store/library': {
		useTracks: () => tracks,
		useTracksLoading: () => loading,
		useLibraryStore: () => ({ fetchTracks }),
	},
	'@/styles': { useDefaultStyles: () => ({ container: { flex: 1 } }) },
	'@/utils/i18n': { t: (key) => key },
	'@/locales/sourceSearch': {
		useSourceSearchText: () => ({
			searchError: 'Error',
			empty: 'Empty',
			songSearch: 'Title or artist',
			clearSearch: 'Clear',
		}),
	},
	'@/helpers/searchAll': {
		__esModule: true,
		default: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
	},
	'react-native': Object.fromEntries(
		['ActivityIndicator', 'ScrollView', 'Text', 'TextInput', 'View', 'Pressable'].map((v) => [
			v,
			v,
		]),
	),
}
const source = readFileSync(new URL('../src/app/(tabs)/(songs)/index.tsx', import.meta.url), 'utf8')
const exports = {}
vm.runInNewContext(
	ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
		},
	}).outputText,
	{
		exports,
		AbortController,
		console,
		setTimeout(fn, delay) {
			const id = ++nextTimer
			timers.set(id, { fn, at: now + delay })
			return id
		},
		clearTimeout(id) {
			timers.delete(id)
		},
		require(name) {
			assert.ok(name in imports, `Unexpected import ${name}`)
			return imports[name]
		},
	},
)
const nodes = (n) =>
	!n || typeof n !== 'object' ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)]
const find = (type) => nodes(tree).find((n) => n.type === type)
const render = () => {
	cursor = 0
	tree = exports.default()
	while (effects.length) effects.shift()()
}
const input = (value) => {
	const onChange = find('TextInput')?.props.onChangeText || header
	onChange(value)
	render()
}
const advance = (delay = 350) => {
	now += delay
	for (const [id, { fn, at }] of [...timers]) {
		if (at > now) continue
		timers.delete(id)
		fn()
	}
}
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve()
	render()
	render()
}
render()
assert.equal(find('TracksList').props.tracks, tracks)
find('ScrollView').props.onScroll({
	nativeEvent: {
		layoutMeasurement: { height: 100 },
		contentOffset: { y: 100 },
		contentSize: { height: 200 },
	},
})
assert.equal(homeLoads, 1)
input('Remote title')
advance(349)
assert.equal(calls.length, 0, 'Home search must debounce input')
advance(1)
assert.equal(calls.length, 1, 'Home search must query online for songs outside the recommendations')
assert.ok(find('TextInput'), 'Home must always show a TextInput')
assert.equal(find('TextInput').props.style.minHeight, 44)
assert.equal(find('Pressable').props.style.minHeight, 44)
assert.equal(find('Pressable').props.style.minWidth, 44)
assert.equal(calls[0].args[2], 'songs')
calls[0].resolve({
	data: [{ id: 'remote', title: 'Remote title', artist: 'Remote artist' }],
	hasMore: true,
})
await flush()
assert.equal(find('SearchList').props.tracks[0].id, 'remote')
find('SearchList').props.onLoadMore()
find('SearchList').props.onLoadMore()
assert.equal(calls.length, 2)
assert.equal(calls[1].args[1], 2)
calls[1].reject(new Error('offline'))
await flush()
assert.equal(find('SearchList').props.error, 'Error')
find('SearchList').props.onRetry()
assert.equal(calls[2].args[1], 2)
input('Remote artist')
assert.equal(calls[2].args[3].aborted, true)
advance()
assert.equal(calls[3].args[0], 'Remote artist')
calls[2].resolve({ data: [{ id: 'stale' }], hasMore: false })
await flush()
assert.equal(find('SearchList').props.tracks.length, 0)
input('   ')
assert.equal(calls[3].args[3].aborted, true)
assert.equal(find('TracksList').props.tracks, tracks)
assert.equal(homeLoads, 1, 'Search must not change home pagination or reload recommendations')
calls[3].resolve({ data: [{ id: 'late' }], hasMore: false })
await flush()
assert.equal(find('TracksList').props.tracks, tracks)
tracks.length = 0
loading = true
render()
assert.ok(find('TextInput'), 'Input remains available while recommendations load')
assert.ok(find('ActivityIndicator'))
input('while loading')
advance()
assert.equal(calls.length, 5)
for (const slot of slots) slot?.cleanup?.()
assert.equal(calls[4].args[3].aborted, true)
console.log(
	'PASS: visible home input, online title/artist search, paging/retry/cancellation, unchanged home loading',
)
