// Run real SearchList handlers against controlled playback, persistence and native UI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const jsx = (type, props) => ({ type, props })
const saved = new Map()
const calls = [],
	alerts = [],
	navigations = []
let slots,
	cursor,
	tree,
	activeQueueId = 'original',
	currentMusic,
	failure,
	pending
const react = {
	memo: (component) => component,
	createElement: (type, props, ...children) => jsx(type, { ...props, children }),
	useRef: (value) => (slots[cursor++] ||= { current: value }),
	useMemo: (factory) => factory(),
	useCallback: (fn) => fn,
}
const persistence = {
	get: (key) => saved.get(key) ?? null,
	set: (key, value) => saved.set(key, value),
	useValue: (key, fallback) => saved.get(key) ?? fallback,
}
function load(path, imports) {
	const exports = {}
	vm.runInNewContext(
		ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
				jsx: ts.JsxEmit.ReactJSX,
			},
		}).outputText,
		{
			exports,
			console,
			Error,
			require(name) {
				assert.ok(name in imports, `Unexpected import ${name}`)
				return imports[name]
			},
		},
	)
	return exports
}
const labels = load('src/locales/sourceSearch.ts', {
	'@/utils/i18n': { nowLanguage: { useValue: () => 'zh' } },
}).useSourceSearchText()
const player = {
	useCurrentMusic: () => currentMusic,
	async play(track) {
		calls.push(['play', track])
		if (failure) throw failure
	},
	async playWithReplacePlayList(track, queue) {
		calls.push(['replace', track, queue])
		if (failure) throw failure
		await pending
	},
}
const SearchList = load('src/components/SearchList.tsx', {
	react,
	'react/jsx-runtime': { jsx, jsxs: jsx },
	'@/constants/images': {},
	'@/constants/tokens': { screenPadding: { horizontal: 16 } },
	'@/helpers/trackPlayerIndex': player,
	'@/hooks/useAppTheme': { useThemeColors: () => ({}) },
	'@/styles': { useDefaultStyles: () => ({}), useUtilsStyles: () => ({}) },
	'@/utils/i18n': { t: (key) => key },
	'@/utils/mediaItem': {
		isSameMediaItem: (a, b) => a && b && a.id === b.id && a.platform === b.platform,
	},
	'@/helpers/userApi/getMusicSource': { getSingerMidBySingerName: async () => 'looked-up' },
	'@/locales/sourceSearch': { useSourceSearchText: () => labels },
	'@/store/PersistStatus': persistence,
	'@/store/queue': {
		useQueue: () => ({
			activeQueueId,
			setActiveQueueId: (id) => {
				activeQueueId = id
			},
		}),
	},
	'@react-native-menu/menu': { MenuView: 'MenuView' },
	'@shopify/flash-list': { FlashList: 'FlashList' },
	'expo-router': { router: { navigate: (target) => navigations.push(target) } },
	'react-native': {
		ActivityIndicator: 'ActivityIndicator',
		Text: 'Text',
		TouchableOpacity: 'TouchableOpacity',
		View: 'View',
		StyleSheet: { create: (styles) => styles },
		Alert: { alert: (...args) => alerts.push(args) },
	},
	'expo-image': { Image: 'Image' },
	'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
	'@rntp/player': { useIsPlaying: () => false },
	'./TracksListItem': 'TracksListItem',
}).SearchList
const nodes = (node) =>
	!node || typeof node !== 'object'
		? []
		: [
				node,
				...[node.props?.children, node.props?.ListHeaderComponent].flat(Infinity).flatMap(nodes),
			]
function screen(id, tracks) {
	const state = []
	let rendered
	let props = { id, tracks, hasMore: true, isLoading: false, onLoadMore() {} }
	return {
		render(next = {}) {
			props = { ...props, ...next }
			slots = state
			cursor = 0
			tree = SearchList(props)
			rendered = tree
			return tree
		},
		select(track) {
			const row = nodes(rendered)
				.find((node) => node.type === 'FlashList')
				.props.renderItem({ item: track })
			return row.type === 'TracksListItem' ? row.props.onTrackSelect(track) : row.props.onPress()
		},
	}
}
const menu = () => {
	const node = nodes(tree).find((node) => node.type === 'MenuView')
	assert.ok(node, 'Search results must expose a persistent native playback mode menu')
	return node
}
const choose = (mode) => menu().props.onPressAction({ nativeEvent: { event: mode } })
const a = { id: 'a', platform: 'tx', title: 'A' },
	b = { id: 'b', platform: 'tx', title: 'B' }
const artist = { id: 'artist', isArtist: true, singerMID: 'singer' }
const album = { id: 'album', searchKind: 'albums', albumMID: 'album-mid' }
const playlist = { id: 'playlist', searchKind: 'playlists' }
const results = [a, artist, album, b, playlist]
const search = screen('search:query:filter', results)
search.render()
// Default and explicit append both preserve the existing queue facade behavior.
await search.select(b)
assert.equal(calls.at(-1)[0], 'play')
assert.equal(calls.at(-1)[1], b)
assert.equal(activeQueueId, 'original')
assert.equal(alerts.length, 0)
assert.equal(menu().props.children.props.style.minHeight, 44)
assert.equal(labels.playbackAppend, '加入当前队列播放')
assert.equal(labels.playbackReplace, '以搜索结果播放')
assert.ok(nodes(menu()).some((node) => node.props.children === labels.playbackAppend))
assert.deepEqual(
	Array.from(menu().props.actions, (action) => action.id),
	['append', 'newplaylist'],
)
choose('newplaylist')
assert.equal(saved.get('search.playbackMode'), 'newplaylist')
assert.equal(calls.length, 1, 'Changing mode must not start playback')
choose('unknown')
assert.equal(
	saved.get('search.playbackMode'),
	'newplaylist',
	'Unknown native actions cannot corrupt the preference',
)
search.render()
assert.ok(nodes(menu()).some((node) => node.props.children === labels.playbackReplace))
await search.select(b)
assert.equal(calls.at(-1)[0], 'replace')
assert.equal(calls.at(-1)[1], b)
assert.deepEqual(
	Array.from(calls.at(-1)[2], (track) => track.id),
	['a', 'b'],
)
assert.notEqual(calls.at(-1)[2], results)
assert.ok(
	activeQueueId.includes('search:query:filter'),
	'Queue identity must include SearchList.id',
)
const snapshot = calls.at(-1)[2],
	firstQueueId = activeQueueId,
	count = calls.length
const c = { id: 'c', platform: 'wy' }
const prePagingSelect = nodes(tree)
	.find((node) => node.type === 'FlashList')
	.props.renderItem({ item: a }).props.onTrackSelect
search.render({ tracks: [...results, c] })
assert.equal(calls.length, count, 'Pagination cannot mutate the launched queue')
assert.deepEqual(
	Array.from(snapshot, (track) => track.id),
	['a', 'b'],
)
await prePagingSelect(a)
assert.equal(calls.length, count, 'Old response callbacks cannot reuse pre-pagination results')
await search.select(c)
assert.deepEqual(
	Array.from(calls.at(-1)[2], (track) => track.id),
	['a', 'b', 'c'],
)
assert.notEqual(activeQueueId, firstQueueId)
// Current/failed track taps must reach the facade retry path in BOTH modes.
currentMusic = b
await search.select(b)
assert.equal(calls.at(-1)[0], 'replace')
choose('append')
search.render()
await search.select(b)
assert.equal(calls.at(-1)[0], 'play')
assert.equal(navigations.length, 0)
// Another mounted search entry and a remount share persisted selection.
const home = screen('home:query', [a, b])
home.render()
choose('newplaylist')
// The other mounted entry still holds its append-mode render here.
await search.select(a)
assert.equal(calls.at(-1)[0], 'replace')
home.render()
assert.ok(nodes(menu()).some((node) => node.props.children === labels.playbackReplace))
screen('remounted', [a]).render()
assert.equal(menu().props.actions.find((action) => action.id === 'newplaylist').state, 'on')
// Artist and collection navigation never changes queue or mode.
search.render()
const beforeNavigation = calls.length,
	queueBeforeNavigation = activeQueueId
for (const item of [artist, album, playlist]) await search.select(item)
assert.equal(calls.length, beforeNavigation)
assert.equal(activeQueueId, queueBeforeNavigation)
assert.equal(saved.get('search.playbackMode'), 'newplaylist')
assert.equal(navigations[0], '/(modals)/singer')
assert.equal(navigations[1].params.kind, 'albums')
assert.equal(navigations[2].params.kind, 'playlists')
// Captured old rows cannot play a previous query/filter response.
const staleSelect = nodes(tree)
	.find((node) => node.type === 'FlashList')
	.props.renderItem({ item: a }).props.onTrackSelect
search.render({ id: 'search:new-query:filter', tracks: [c] })
const beforeStale = calls.length
await staleSelect(a)
assert.equal(calls.length, beforeStale, 'Old response handlers must not launch stale queues')
await search.select(a)
assert.equal(calls.length, beforeStale, 'A song outside the current results must not play')
// Both facade rejections are caught and surfaced without per-tap confirmation alerts.
for (const mode of ['append', 'newplaylist']) {
	choose(mode)
	search.render()
	failure = new Error(`${mode} offline`)
	await search.select(c)
	assert.equal(alerts.at(-1)[1], failure.message)
}
failure = undefined
assert.equal(alerts.length, 2)
// A rejected non-Error value must also be handled.
failure = 'plain failure'
await search.select(c)
assert.equal(alerts.at(-1)[1], 'plain failure')
failure = undefined
// A slower earlier play cannot overwrite the latest queue identity on completion.
let resolve
pending = new Promise((done) => {
	resolve = done
})
const earlier = search.select(c)
const earlierId = activeQueueId
pending = undefined
home.render()
await home.select(a)
const latestId = activeQueueId
assert.notEqual(latestId, earlierId)
resolve()
await earlier
assert.equal(activeQueueId, latestId)
console.log(
	'PASS: search append/replace modes, persisted menu, snapshot paging, navigation, retry, stale rows and errors',
)
