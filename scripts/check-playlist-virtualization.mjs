// Production screen -> playlist -> list -> row, with a bounded virtualizer/native seam.
// This checks the scroll contract, not native FlashList layout or device frame rate.
import { assert, loadModule, flush } from './native-services-fixture.mjs'
import { createFixture } from './file-system-fixture.mjs'

const songs = Array.from({ length: 2400 }, (_, index) => ({
	id: String(Math.floor(index / 2)),
	platform: index % 2 ? 'tx' : 'wy',
	title: `Song ${index}`,
	artist: 'Artist',
	url: 'Unknown',
	...(index === 2399 ? { unavailable: true } : {}),
}))
const playlist = { id: 'remote', title: 'Large playlist', songs, coverImg: 'https://example.com/cover' }
const calls = { cache: [], replace: [], deletes: [], refresh: [], navigate: [], selected: [] }
let currentMusic, activeQueueId, playing = false, windowStart = 0, rowRenders = 0
const effects = []
const react = {
	memo: (component) => component,
	useMemo: (compute) => compute(),
	useCallback: (callback) => callback,
	useRef: (value) => ({ current: value }),
	useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
	useEffect: (effect) => effects.push(effect),
	createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } }),
}
const native = Object.fromEntries([
	'View', 'ScrollView', 'Text', 'TouchableOpacity', 'TouchableHighlight', 'ActivityIndicator',
].map((name) => [name, name]))
native.StyleSheet = { create: (value) => value }
native.Alert = { alert() {} }
const facade = {
	useCurrentMusic: () => currentMusic,
	isCached: async (track) => { calls.cache.push(track); return false },
	playWithReplacePlayList: async (...args) => calls.replace.push(args),
	deleteSongFromStoredPlayList: (...args) => calls.deletes.push(args),
	setRepeatMode() {},
}
const playerModule = {
	__esModule: true, default: facade,
	playListsStore: { useValue: () => [playlist] },
	isCachedIconVisibleStore: { useValue: () => true },
	MusicRepeatMode: { QUEUE: 'queue', SHUFFLE: 'shuffle' },
	repeatModeStore: { setValue() {} },
}
const router = { navigate: (...args) => calls.navigate.push(args), replace() {} }
const styles = { container: { flex: 1 }, text: {}, itemSeparator: {} }
const common = {
	react,
	'react-native': native,
	'expo-image': { Image: 'Image' },
	'expo-router': { router, Redirect: 'Redirect', useLocalSearchParams: () => ({ name: playlist.id }) },
	'@/constants/images': { unknownTrackImageUri: 'unknown' },
	'@/constants/tokens': { fontSize: { lg: 24 }, screenPadding: { horizontal: 16 } },
	'@/helpers/trackPlayerIndex': playerModule,
	'@/styles': { useDefaultStyles: () => styles, useUtilsStyles: () => styles },
	'@/hooks/useAppTheme': { useThemeColors: () => ({}) },
}
const load = (path, mocks = {}) => loadModule(path, { ...common, ...mocks }, { React: react })
const media = load('src/utils/mediaItem.ts', {
	'@/constants/commonConst': {}, '@/store/mediaExtra': {},
})
const Row = load('src/components/TracksListItem.tsx', {
	'@/hooks/useTrackArtwork': { useTrackArtwork: (track) => ({ source: { uri: track.artwork || 'unknown' }, onError() {}, onLoad() {} }) },
	'@/components/TrackShortcutsMenu': { TrackShortcutsMenu: 'TrackShortcutsMenu' },
	'@/utils/imageUtils': { getThumbnailArtwork: (value) => value },
	'@/utils/rpx': (value) => value,
	'@expo/vector-icons': { Entypo: 'Icon', Ionicons: 'Icon' },
	'react-native-loader-kit': 'Loader',
	'./utils/StopPropagation': { StopPropagation: 'StopPropagation' },
}).default
const { QueueControls } = load('src/components/QueueControls.tsx', {
	'@/utils/i18n': { t: (key) => key },
	'@expo/vector-icons': { Ionicons: 'Icon' },
	'lodash.shuffle': (tracks) => [...tracks].reverse(),
	'react-native-gesture-handler': { TouchableOpacity: 'TouchableOpacity' },
})
const { TracksList } = load('src/components/TracksList.tsx', {
	'@/components/TracksListItem': { __esModule: true, default: (props) => { rowRenders++; return Row(props) } },
	'@/utils/mediaItem': media,
	'@/store/queue': { useQueue: () => ({ activeQueueId, setActiveQueueId: (id) => { activeQueueId = id } }) },
	'@rntp/player': { useIsPlaying: () => playing },
	'@shopify/flash-list': { FlashList: 'FlashList' },
	'./QueueControls': { QueueControls },
})
const { PlaylistTracksList } = load('src/components/PlaylistTracksList.tsx', {
	'@/hooks/usePlaylistArtwork': { usePlaylistArtwork: () => ({ source: { uri: playlist.coverImg }, onError() {} }) },
	'@/helpers/miscellaneous': { generateTracksListId: (title) => title },
	'./TracksList': { TracksList }, './QueueControls': { QueueControls },
})
const Screen = load('src/app/(tabs)/favorites/[name].tsx', {
	'@/components/PlaylistTracksList': { PlaylistTracksList },
	'@/helpers/remotePlaylistStore': { refreshRemotePlaylist: async (id) => { calls.refresh.push(id); return playlist } },
	'@/helpers/userApi/remotePlaylist': { getPlaylistReference: () => ({ provider: 'wy' }), remotePlaylistId: () => playlist.id },
}).default

// Interpret actual JSX recursively. Only FlashList chooses a viewport window; eager
// data.map rows in any production component still execute and break the row bound.
function render(node, ancestors = []) {
	if (Array.isArray(node)) return node.map((child) => render(child, ancestors))
	if (!node || typeof node !== 'object') return node
	if (typeof node.type === 'function') return render(node.type(node.props), ancestors)
	if (node.type === 'FlashList') {
		assert(!ancestors.includes('ScrollView'), 'FlashList must not have a parent ScrollView')
		assert.equal(node.props.scrollEnabled, true, 'Detail FlashList must own scrolling')
		const children = [node.props.ListHeaderComponent]
		for (let index = windowStart; index < Math.min(windowStart + 12, node.props.data.length); index++) {
			children.push(node.props.renderItem({ item: node.props.data[index], index, target: 'Cell' }))
		}
		return { ...node, props: { ...node.props, children: render(children, [...ancestors, node.type]) } }
	}
	return { ...node, props: { ...node.props, children: render(node.props.children, [...ancestors, node.type]) } }
}
const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes) : !node || typeof node !== 'object'
	? [] : [node, ...nodes(node.props?.children)]
const find = (tree, type) => nodes(tree).find((node) => node.type === type)
const all = (tree, type) => nodes(tree).filter((node) => node.type === type)
const run = async (element = react.createElement(Screen)) => {
	rowRenders = 0
	calls.cache.length = 0
	const tree = render(element)
	const cleanups = effects.splice(0).map((effect) => effect())
	await flush()
	assert(rowRenders <= 12, `Only viewport rows may render, got ${rowRenders}`)
	assert.equal(calls.cache.length, 12, 'Only the 12 viewport rows execute their real cache effects')
	cleanups.forEach((cleanup) => cleanup?.())
	return tree
}

let tree = await run()
let list = find(tree, 'FlashList')
assert.equal(all(tree, 'FlashList').length, 1)
assert.equal(list.props.data, songs, 'Full queue remains data, not mounted rows')
assert.equal(list.props.contentInsetAdjustmentBehavior, 'automatic')
assert.equal(Object.assign({}, ...[list.props.style].flat()).flex, 1)
assert.equal(list.props.contentContainerStyle.paddingBottom, 128)
assert.equal(find(tree, 'Image').props.source.uri, playlist.coverImg)
assert.equal(find(tree, 'Image').props.style.height, '100%')
assert.equal(all(tree, 'TouchableOpacity').length, 3, 'Refresh, play and shuffle remain in header')
await find(tree, 'TouchableOpacity').props.onPress()
assert.deepEqual(calls.refresh, [playlist.id])
const keys = songs.map(list.props.keyExtractor)
assert.equal(new Set(keys).size, songs.length, 'Keys include platform even for unavailable tracks')
assert.notEqual(list.props.keyExtractor({ id: 'same' }), list.props.keyExtractor({ id: 'same', platform: 'wy' }))

// Jump directly to the final viewport, then press a real row. No preceding rows render.
windowStart = 2388
tree = await run()
const pressed = songs[2398]
await all(tree, 'TouchableHighlight')[10].props.onPress()
assert.equal(calls.replace.length, 1)
assert.equal(calls.replace[0][0], pressed)
assert.equal(calls.replace[0][1], songs)
assert.equal(activeQueueId, playlist.title)
assert.equal(rowRenders, 12)
const menu = all(tree, 'TrackShortcutsMenu')[10]
menu.props.onDeleteTrack(pressed.id)
assert.equal(calls.deletes[0][0], playlist)
assert.equal(calls.deletes[0][1], pressed, 'Deletion retains platform for colliding IDs')

// Same active queue, other platform with the same ID must still select the song.
currentMusic = songs[2399]
playing = true
tree = await run()
await all(tree, 'TouchableHighlight')[10].props.onPress()
assert.equal(calls.replace.length, 2)
assert.equal(calls.replace[1][0], pressed)
await all(tree, 'TouchableHighlight')[11].props.onPress()
assert.deepEqual(calls.navigate, [['/player']])
assert.equal(calls.replace.length, 2)

tree = await run(react.createElement(PlaylistTracksList, {
	playlist, tracks: songs, scrollEnabled: true, isMultiSelectMode: true,
	selectedTracks: new Set([pressed.id]),
	onToggleSelection: (id) => calls.selected.push(id),
}))
all(tree, 'TouchableHighlight')[10].props.onPress()
assert.deepEqual(calls.selected, [pressed.id])
assert.equal(calls.replace.length, 2, 'Multi-selection must not replace queue')

// Other callers, including localMusic, retain the old non-scrolling default.
const legacy = PlaylistTracksList({ playlist, tracks: songs })
assert.equal(TracksList(legacy.props).props.scrollEnabled, false)

// Exercise the real playback facade as well as the UI call boundary. Native audio
// and source resolution are controlled, but business queue/indexing are production.
const fixture = createFixture()
try {
	const sourceCalls = []
	const queueOwner = {}
	const h = fixture.runtime({ moduleOverrides: {
		react,
		'@/store/playList': queueOwner,
		'@/player/MusicSourceResolver': {
			resolveSource: async (track) => {
				sourceCalls.push(track)
				return { url: `https://example.com/${track.platform}/${track.id}.mp3`, wasCached: false }
			},
			prepareNextTrack: async () => null,
			cancelPreparedNextTrack() {},
			isPreparedNextTrackValid: () => false,
			setCurrentStreamPriority() {},
			withSourceRuntimeLock: (action) => action(),
		},
		'@/helpers/carPlay': { startCarPlayBridge: async () => {} },
	} })
	Object.assign(queueOwner, h.load('src/store/playList.ts'))
	const player = h.load('src/helpers/trackPlayerIndex.ts').default
	const selected = songs[1800]
	await player.playWithReplacePlayList(selected, songs)
	assert.equal(player.getPlayList().length, 2400)
	assert.deepEqual(Array.from(player.getPlayList(), (track) => [track.platform, track.id]),
		songs.map((track) => [track.platform, track.id]), 'Business queue preserves imported order and unavailable rows')
	assert.equal(player.getCurrentMusic().id, selected.id)
	assert.equal(player.getCurrentMusic().platform, selected.platform)
	assert.equal(sourceCalls.length, 1, 'Selecting a large queue resolves only the selected song')
	assert.equal(h.player.queue.length, 2, 'Native queue holds current audio and a placeholder')
	await player.skipToNext()
	assert.equal(player.getCurrentMusic().id, songs[1801].id)
	assert.equal(player.getCurrentMusic().platform, songs[1801].platform)
	await player.skipToPrevious()
	assert.equal(player.getCurrentMusic().id, selected.id)
	assert.equal(player.getCurrentMusic().platform, selected.platform)
	assert.equal(rowRenders, 12, 'Business queue selection does not render queue rows')
} finally {
	await fixture.dispose()
}
console.log('PASS: actual detail tree has one scrolling FlashList, bounded rows/cache checks, header, platform keys/deletion, full queue selection and legacy defaults')
