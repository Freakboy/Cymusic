// Deterministic transport and hook contracts. --online additionally probes production endpoints.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import CryptoJS from 'crypto-js'
import axios from 'axios'

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
			AbortController,
			Error,
			console,
			setTimeout: () => 0,
			clearTimeout() {},
			require(name) {
				assert.ok(name in imports, `Unexpected import ${name}`)
				return imports[name]
			},
		},
	)
	return exports
}
const txSearch = load('src/player/sourceResolver/txSearch.ts', { 'crypto-js': CryptoJS })
let calls = [],
	responses = []
const valid = (ids = ['a']) => ({
	data: {
		code: 0,
		req_1: {
			code: 0,
			data: {
				meta: { sum: ids.length },
				body: { song: { list: ids.map((mid) => ({ mid, title: mid, singer: [] })) } },
			},
		},
	},
})
const transport = {
	post: async (...args) => {
		calls.push(args)
		const response = responses.shift()
		if (response instanceof Error) throw response
		return typeof response === 'function' ? response(...args) : response
	},
}
const imports = {
	axios: transport,
	'crypto-js': CryptoJS,
	'@/player/sourceResolver/txSearch': txSearch,
}
const searchModule = load('src/helpers/searchAll.ts', imports)
const search = searchModule.default
responses = [valid()]
assert.equal((await search(' a ')).data[0].id, 'a')
assert.match(calls[0][0], /musics\.fcg\?sign=zzc/)
assert.equal(calls[0][1].comm.ct, '19')
assert.equal(calls[0][1].req_1.param.query, 'a')
assert.equal(calls[0][2].timeout, 8000)
for (const [type, key, number, item] of [
	['songs', 'song', 0, { mid: 'mid', title: 'Song', singer: [] }],
	['artists', 'singer', 1, { singerMID: 'artist', singerName: 'Artist' }],
	['albums', 'album', 2, { albumMID: 'album', albumName: 'Album' }],
	['playlists', 'songlist', 3, { dissid: 'playlist', dissname: 'Playlist' }],
]) {
	responses = [
		{
			data: {
				code: 0,
				req_1: { code: 0, data: { meta: { sum: 41 }, body: { [key]: { list: [item] } } } },
			},
		},
	]
	assert.equal((await search('query', 2, type)).hasMore, true)
	assert.equal(calls.at(-1)[1].req_1.param.search_type, number)
	assert.equal(calls.at(-1)[1].req_1.param.page_num, 2)
}
for (const first of [
	Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
	Object.assign(new Error('unavailable'), { response: { status: 503 } }),
	{ data: { code: 2000 } },
]) {
	calls = []
	responses = [first, valid()]
	await search('a')
	assert.equal(calls.length, 2)
	assert.equal(calls[1][0], 'https://u.y.qq.com/cgi-bin/musicu.fcg')
	assert.equal(calls[0][1], calls[1][1], 'Fallback preserves query/category/page envelope')
}
for (const failure of [
	{ data: { code: 0, req_1: { code: 1000 } } },
	{ data: '<html>not JSON</html>' },
	{ data: { code: 0, req_1: { code: 0, data: {} } } },
	Object.assign(new Error('rate limited'), { response: { status: 429 } }),
	Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' }),
]) {
	calls = []
	responses = [failure, valid()]
	await assert.rejects(search('a'))
	assert.equal(calls.length, 1, 'No blind retry of business/schema/rate/cancel failures')
}
calls = []
responses = [valid([])]
assert.equal((await search('none')).data.length, 0)
assert.equal(calls.length, 1)
calls = []
responses = [
	Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
	Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
]
await assert.rejects(search('a'))
assert.equal(calls.length, 2, 'Fallback is bounded')
const controller = new AbortController()
calls = []
responses = [
	() => {
		controller.abort()
		throw Object.assign(new Error('network'), { code: 'ERR_NETWORK' })
	},
]
await assert.rejects(search('a', 1, 'songs', controller.signal), /CANCELLED/)
assert.equal(calls.length, 1, 'Abort stops fallback')
calls = []
await assert.rejects(search('a', 1, 'songs', controller.signal), /CANCELLED/)
assert.equal(calls.length, 0)
const late = new AbortController()
responses = [
	() => {
		late.abort()
		return valid()
	},
]
await assert.rejects(search('a', 1, 'songs', late.signal), /CANCELLED/)

let hotResponse, hotRequest
const hot = load('src/helpers/searchHot.ts', {
	axios: {
		get: async (...args) => {
			hotRequest = args
			return { data: hotResponse }
		},
	},
})
hotResponse = {
	code: 0,
	songlist: [
		{ data: { songmid: 'chart-mid', songname: 'Chart song', singer: [{ name: 'Artist' }] } },
	],
}
const songs = await hot.fetchSearchHot('songs')
assert.equal(songs[0].songmid, 'chart-mid')
assert.ok(hotRequest[0].includes('topid=26'))
assert.equal(songs[0].searchKind, undefined)
hotResponse = {
	code: 0,
	data: { list: [{ dissid: '123', dissname: 'Popular playlist', imgurl: 'http://image' }] },
}
const playlists = await hot.fetchSearchHot('playlists')
assert.ok(hotRequest[0].includes('sortId=5'))
assert.equal(playlists[0].searchKind, 'playlists')
assert.equal(playlists[0].artwork, 'https://image')
for (const response of [
	{ code: 1 },
	{ code: 0, subcode: 1 },
	{ code: 0, data: { list: [] } },
	{ code: 0, data: { list: [{}] } },
]) {
	hotResponse = response
	await assert.rejects(hot.fetchSearchHot('playlists'))
}

// Actual hook: independent failures/retries, hide/unmount cancellation, stale completion.
const slots = [],
	effects = [],
	requests = []
let cursor = 0
const changed = (a, b) => !a || a.some((value, index) => value !== b[index])
const react = {
	useState(initial) {
		const i = cursor++
		if (!slots[i]) slots[i] = { value: initial }
		return [
			slots[i].value,
			(value) => {
				slots[i].value = typeof value === 'function' ? value(slots[i].value) : value
			},
		]
	},
	useRef(initial) {
		return (slots[cursor++] ||= { current: initial })
	},
	useCallback(fn) {
		return fn
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
const hook = load('src/hooks/useSearchHot.ts', {
	react,
	'@/helpers/searchHot': {
		fetchSearchHot: (kind, signal) =>
			new Promise((resolve, reject) => requests.push({ kind, signal, resolve, reject })),
	},
}).useSearchHot
let sections
function render(visible = true) {
	cursor = 0
	sections = [hook('songs', visible), hook('playlists', visible)]
	while (effects.length) effects.shift()()
}
async function flush() {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}
render()
render()
assert.ok(sections.every((section) => section.loading))
requests[0].resolve(songs)
requests[1].reject(new Error('offline'))
await flush()
render()
assert.equal(sections[0].tracks[0].id, 'chart-mid')
assert.equal(sections[0].error, false)
assert.equal(sections[1].error, true)
sections[1].retry()
render()
assert.equal(requests.length, 3)
assert.equal(requests[2].kind, 'playlists')
render(false)
assert.equal(requests[2].signal.aborted, true)
requests[2].resolve([{ id: 'stale' }])
await flush()
render(false)
assert.equal(sections[1].tracks.length, 0)
render()
assert.equal(requests.length, 4)
requests[3].resolve(playlists)
await flush()
render()
assert.equal(sections[1].tracks[0].id, '123')
render(false)
render()
assert.equal(
	requests.length,
	4,
	'Successful sections survive query visibility without unnecessary reload',
)
sections[0].retry()
render()
for (const slot of slots) slot.cleanup?.()
assert.equal(requests[4].signal.aborted, true)
console.log(
	'PASS: signed search categories/pages, classified bounded fallback, cancellation; real hot endpoint parsing and independent hook retry/stale states',
)

// Actual search screen handlers: default snapshot queue, explicit append and hidden/stale rows.
slots.length = 0
effects.length = 0
react.useMemo = (factory) => factory()
const jsx = (type, props) => ({ type, props })
let inventory = [
	{ id: 'one', platform: 'tx', title: 'One' },
	{ id: 'two', platform: 'tx', title: 'Two' },
]
let savedMode = null,
	queueId = 'original',
	playbackFailure,
	blockedPlayback
const screenPlayback = [],
	screenAlerts = []
const hotEnable = new Map(), screenNavigation = []
const playlistInventory = [{ id: 'popular-list', title: 'Popular list', searchKind: 'playlists' }]
const Screen = load('src/app/(tabs)/search/index.tsx', {
	react,
	'react/jsx-runtime': { jsx, jsxs: jsx },
	'@/components/SearchList': { SearchList: 'SearchList' },
	'@/components/TracksListItem': 'TracksListItem',
	'@/constants/tokens': {},
	'@/hooks/useAppTheme': { useThemeColors: () => ({}) },
	'@/helpers/searchAll': { default: async () => ({ data: [], hasMore: false }), __esModule: true },
	'@/locales/sourceSearch': { useSourceSearchText: () => ({ playlists: 'Playlists', albums: 'Albums', prompt: 'Enter a query' }) },
	'@/locales/searchDiscovery': {
		useSearchDiscoveryText: () => ({
			songs: 'Hot songs',
			playlists: 'Hot playlists',
			failed: 'Failed',
		}),
	},
	'@/utils/i18n': { t: (key) => key },
	'@/hooks/useSearchHot': {
		useSearchHot: (kind, enabled) => { hotEnable.set(kind, enabled); return ({
			tracks: kind === 'songs' ? inventory : playlistInventory,
			loading: false,
			error: false,
			retry() {},
		}) },
	},
	'@/helpers/trackPlayerIndex': {
		async play(track) {
			screenPlayback.push(['append', track])
			if (playbackFailure) throw playbackFailure
		},
		async playWithReplacePlayList(track, queue) {
			screenPlayback.push(['replace', track, queue])
			if (playbackFailure) throw playbackFailure
			await blockedPlayback
		},
	},
	'@/store/PersistStatus': {
		get: (key) => {
			assert.equal(key, 'search.playbackMode')
			return savedMode
		},
	},
	'@/store/queue': {
		useQueue: () => ({
			setActiveQueueId: (id) => {
				queueId = id
			},
		}),
	},
	'expo-router': { router: { navigate: (route) => screenNavigation.push(route) } },
	'expo-image': { Image: 'Image' },
	'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
	'react-native': {
		Animated: { Value: class {}, View: 'Animated', spring: () => ({ start() {} }) },
		useWindowDimensions: () => ({ width: 400 }),
		StyleSheet: { create: (styles) => styles },
		Pressable: 'Pressable',
		Text: 'Text',
		TextInput: 'TextInput',
		View: 'View',
		ScrollView: 'ScrollView',
		TouchableOpacity: 'TouchableOpacity',
		ActivityIndicator: 'ActivityIndicator',
		Alert: { alert: (...args) => screenAlerts.push(args) },
	},
}).default
const nodes = (node) =>
	!node || typeof node !== 'object'
		? []
		: [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
let screenTree
const renderScreen = () => {
	cursor = 0
	screenTree = Screen()
	while (effects.length) effects.shift()()
}
const rowHandler = () =>
	nodes(screenTree).find((node) => node.type === 'TracksListItem').props.onTrackSelect
renderScreen()
assert.equal(hotEnable.get('songs'), true)
assert.equal(hotEnable.get('playlists'), false)
assert.ok(!nodes(screenTree).some((node) => node.type === 'Text' && node.props.children === 'Hot playlists'),
	'Songs category must not contain the hot playlist section')
assert.ok(
	!nodes(screenTree).some((node) => node.type === 'MenuView'),
	'Do not add an empty-query mode UI',
)
await rowHandler()(inventory[1])
assert.equal(screenPlayback.at(-1)[0], 'replace', 'Unset preference defaults hot songs to a list')
assert.equal(screenPlayback.at(-1)[1], inventory[1])
assert.deepEqual(
	Array.from(screenPlayback.at(-1)[2], (track) => track.id),
	['one', 'two'],
)
assert.notEqual(screenPlayback.at(-1)[2], inventory)
assert.notEqual(screenPlayback.at(-1)[2][0], inventory[0])
assert.ok(queueId.includes('search-hot') && queueId.includes('qq-chart-26'))
const oldQueueId = queueId,
	snapshot = screenPlayback.at(-1)[2],
	staleInventoryHandler = rowHandler()
const previousSong = inventory[0]
inventory = [{ id: 'new', platform: 'tx', title: 'New' }]
renderScreen()
const beforeStale = screenPlayback.length
await staleInventoryHandler(previousSong)
await rowHandler()(previousSong)
assert.equal(
	screenPlayback.length,
	beforeStale,
	'Old inventory callbacks and absent songs cannot play',
)
assert.deepEqual(
	Array.from(snapshot, (track) => track.id),
	['one', 'two'],
)
assert.equal(queueId, oldQueueId, 'Refreshing inventory cannot update a launched queue')
savedMode = 'append'
await rowHandler()(inventory[0])
assert.equal(
	screenPlayback.at(-1)[0],
	'append',
	'Explicit persisted append is respected without re-render',
)
assert.equal(queueId, oldQueueId)
savedMode = 'newplaylist'
await rowHandler()(inventory[0])
assert.equal(screenPlayback.at(-1)[0], 'replace')
assert.notEqual(queueId, oldQueueId)
const hiddenHandler = rowHandler(),
	inputHandler = nodes(screenTree).find((node) => node.type === 'TextInput').props.onChangeText
const beforeHidden = screenPlayback.length
inputHandler('query')
await hiddenHandler(inventory[0])
assert.equal(
	screenPlayback.length,
	beforeHidden,
	'Input intent blocks cached rows even before React renders',
)
renderScreen()
assert.ok(!nodes(screenTree).some((node) => node.type === 'TracksListItem'))
await hiddenHandler(inventory[0])
nodes(screenTree)
	.find((node) => node.type === 'TextInput')
	.props.onChangeText('')
renderScreen()
await hiddenHandler(inventory[0])
assert.equal(
	screenPlayback.length,
	beforeHidden,
	'An old hidden callback stays invalid after query is cleared',
)
await rowHandler()(inventory[0])
assert.equal(screenPlayback.length, beforeHidden + 1)
const beforeBatched = screenPlayback.length, batchedHandler = rowHandler()
const batchedInput = nodes(screenTree).find((node) => node.type === 'TextInput').props.onChangeText
batchedInput('temporary')
batchedInput('')
await batchedHandler(inventory[0])
assert.equal(screenPlayback.length, beforeBatched, 'Batched query-away-and-back still invalidates cached hot rows')
renderScreen()
for (const mode of ['append', 'newplaylist']) {
	savedMode = mode
	playbackFailure = new Error(`${mode} failed`)
	await rowHandler()(inventory[0])
	assert.equal(screenAlerts.at(-1)[1], playbackFailure.message)
}
playbackFailure = undefined
savedMode = null
let unblock
blockedPlayback = new Promise((resolve) => {
	unblock = resolve
})
const firstPlay = rowHandler()(inventory[0])
const firstPendingId = queueId
blockedPlayback = undefined
await rowHandler()(inventory[0])
const latestId = queueId
assert.notEqual(latestId, firstPendingId)
unblock()
await firstPlay
assert.equal(
	queueId,
	latestId,
	'Earlier playback completion cannot overwrite the newest queue identity',
)
console.log(
	'PASS: actual hot song handler default snapshot/explicit append, independent queue IDs, hidden/stale guards and errors',
)

const selectCategory = (label) => nodes(screenTree).find((node) => node.type === 'Pressable' &&
	nodes(node).some((child) => child.type === 'Text' && child.props.children === label)).props.onPress()
const oldSongHandler = rowHandler(), beforeCategoryPlay = screenPlayback.length
selectCategory('Playlists')
await oldSongHandler(inventory[0])
assert.equal(screenPlayback.length, beforeCategoryPlay, 'Category intent blocks old song clicks before re-render')
renderScreen()
assert.equal(hotEnable.get('songs'), false)
assert.equal(hotEnable.get('playlists'), true)
assert.ok(!nodes(screenTree).some((node) => node.type === 'TracksListItem'))
assert.ok(!nodes(screenTree).some((node) => node.type === 'Text' && node.props.children === 'Hot songs'))
const playlistHandler = nodes(screenTree).find((node) => node.type === 'TouchableOpacity').props.onPress
playlistHandler()
assert.equal(screenNavigation.at(-1).params.id, 'popular-list')
const beforeCategoryNavigation = screenNavigation.length
selectCategory('find.artists')
playlistHandler()
assert.equal(screenNavigation.length, beforeCategoryNavigation, 'Old playlist clicks are blocked during category change')
renderScreen()
assert.equal(hotEnable.get('songs'), false)
assert.equal(hotEnable.get('playlists'), false)
assert.ok(!nodes(screenTree).some((node) => node.type === 'TouchableOpacity' || node.type === 'TracksListItem'))
selectCategory('Albums')
renderScreen()
assert.ok(nodes(screenTree).some((node) => node.type === 'Text' && node.props.children === 'Enter a query'))
assert.ok(!nodes(screenTree).some((node) => node.type === 'TouchableOpacity' || node.type === 'TracksListItem'))
selectCategory('find.songs')
renderScreen()
await oldSongHandler(inventory[0])
assert.equal(screenPlayback.length, beforeCategoryPlay, 'Category-away-and-back does not revive old song callbacks')
console.log('PASS: songs/playlists/artist/album discovery separation, request gating and stale category clicks')

if (process.argv.includes('--online')) {
	const online = load('src/helpers/searchAll.ts', { ...imports, axios }).default
	for (const type of ['songs', 'artists', 'albums', 'playlists']) {
		const result = await online('周杰伦', 1, type)
		assert.ok(result.data.length > 0)
		console.log(`ONLINE PASS: signed ${type}: ${result.data.length}`)
	}
	const secondPage = await online('周杰伦', 2, 'songs')
	assert.ok(secondPage.data.length > 0)
	console.log(`ONLINE PASS: signed songs page 2: ${secondPage.data.length}`)
	const remote = load('src/helpers/searchHot.ts', { axios })
	for (const kind of ['songs', 'playlists']) {
		const tracks = await remote.fetchSearchHot(kind)
		assert.ok(tracks.length > 0)
		console.log(`ONLINE PASS: hot ${kind}: ${tracks.length}, first=${tracks[0].title}`)
	}
}
