// Run: node scripts/check-lyric-timing.mjs
import { assert, checks, loadModule } from './native-services-fixture.mjs'

const suite = checks()
const Parser = loadModule('src/utils/lrcParser.ts', {}).default
const plain = (value) => JSON.parse(JSON.stringify(value))
const rows = (parser) => plain(parser.getLyric().map(({ time, lrc }) => [time, lrc]))

await suite.check('seconds, fractions, sorted repeated timestamps and blank lines', () => {
	const parser = new Parser({ rawLrc: '[00:20.250][00:10.25]Chorus\r\n[00:15.5]\r\n[01:02.125]End' })
	assert.deepEqual(rows(parser), [[10.25, 'Chorus'], [15.5, ''], [20.25, 'Chorus'], [62.125, 'End']])
	for (const [position, index] of [[0, -1], [10.249, -1], [10.25, 0], [15.5, 1], [62.125, 3], [21, 2], [11, 0]]) {
		assert.equal(parser.getPosition(position).index, index)
	}
})

await suite.check('whitespace between repeated time tags does not steal their lyric', () => {
	const parser = new Parser({ rawLrc: '[00:10] [00:20]\tChorus\n[00:30]Next' })
	assert.deepEqual(rows(parser), [[10, 'Chorus'], [20, 'Chorus'], [30, 'Next']])
})

await suite.check('empty timestamp on one line never borrows the next line', () => {
	assert.deepEqual(rows(new Parser({ rawLrc: '[00:10]\n[00:20]Next\n[00:30]' })), [[10, ''], [20, 'Next'], [30, '']])
})

await suite.check('packed source LRC retains distinct text after each timestamp', () => {
	assert.deepEqual(rows(new Parser({ rawLrc: '[00:10][00:20]Chorus[00:30]Next' })), [[10, 'Chorus'], [20, 'Chorus'], [30, 'Next']])
})

await suite.check('plain text and translation timestamps remain intact', () => {
	const parser = new Parser({ rawLrc: 'First\nSecond', translation: '[00:10][00:20]Translated' })
	assert.deepEqual(rows(parser), [[0, 'First'], [0, 'Second']])
	assert.deepEqual(plain(parser.getTranslationLyric().map(({ time, lrc }) => [time, lrc])), [[10, 'Translated'], [20, 'Translated']])
})

await suite.check('LRC positive offset advances, negative offset delays, in milliseconds', () => {
	// LRC offset is an advance; the user delay below intentionally has the opposite sign.
	for (const [offset, onset] of [[3000, 7], [-3000, 13]]) {
		const parser = new Parser({ rawLrc: `[offset:${offset}]\n[00:10]First\n[00:14]Second` })
		assert.equal(parser.getPosition(onset - 0.001).index, -1)
		assert.equal(parser.getPosition(onset).index, 0)
		assert.equal(parser.getLyric()[0].time + parser.getMeta().offset, onset, 'Tap-to-seek uses the same effective offset')
	}
})

await suite.check('metadata tags on the same line and offset after lyrics are recognized', () => {
	for (const rawLrc of ['[ar:Artist][offset:-3000]\n[00:10]First', '[00:10]First\n[offset:-3000]']) {
		const parser = new Parser({ rawLrc })
		assert.equal(parser.getPosition(10).index, -1)
		assert.equal(parser.getPosition(13).index, 0)
		assert.equal(parser.getLyric()[0].lrc, 'First')
	}
})

await suite.check('positive user delay combines with LRC offset without modifying raw timestamps', () => {
	const parser = new Parser({ rawLrc: '[offset:1000]\n[00:10]First\n[00:14]Second' }, undefined, { offset: 2 })
	assert.equal(parser.getPosition(10).index, -1)
	assert.equal(parser.getPosition(11).index, 0)
	assert.equal(parser.getPosition(14).index, 0)
	assert.equal(parser.getPosition(15).index, 1)
	assert.deepEqual(rows(parser), [[10, 'First'], [14, 'Second']])
})

await suite.check('malformed offset cannot poison the timeline', () => {
	const parser = new Parser({ rawLrc: '[offset:invalid]\n[00:10]First\n[00:14]Second' })
	assert.equal(parser.getPosition(0).index, -1)
	assert.equal(parser.getPosition(10).index, 0)
})

function managerRuntime() {
	class State {
		constructor(value) { this.value = value }
		getValue = () => this.value
		setValue = (value) => { this.value = value }
		useValue = () => this.value
	}
	const listeners = new Map(), settings = new Map([['lyric.delaySeconds', 2]])
	const track = { id: 'song', platform: 'tx', title: 'Song' }
	const original = new State('[00:10]First\n[00:14]Second')
	let position = 0
	const player = {
		getCurrentMusic: () => track,
		getProgress: () => ({ position, duration: 50, buffered: 40, cached: 50 }),
		isCurrentProgressEvent: (event) => event.mediaId === track.id,
		isCurrentNativeItem: (item) => item === track,
	}
	const api = loadModule('src/helpers/lyricManager.ts', {
		'@/store/PersistStatus': { get: (key) => settings.get(key) },
		'@/utils/mediaItem': { isSameMediaItem: (a, b) => a?.id === b?.id },
		'@/utils/stateMapper': { GlobalState: State },
		'@/utils/lrcParser': Parser,
		'@rntp/player': { Event: { PlaybackProgressUpdated: 'progress', MediaItemTransition: 'transition' },
			addEventListener: (name, callback) => { listeners.set(name, callback); return { remove() {} } },
			getActiveMediaItem: () => track },
		'./trackPlayerIndex': { __esModule: true, default: player, nowLyricState: original, nowTranslationLyricState: new State(null) },
	}).default
	return { api, track, original, settings,
		setPosition: (value) => { position = value },
		emit: (name, data) => listeners.get(name)(data) }
}

await suite.check('phone transition and refresh obey the first timestamp including positive user delay', async () => {
	const h = managerRuntime()
	h.emit('transition', { item: h.track })
	assert.equal(h.api.getCurrentLyric(), null, 'No first line highlight at position 0 before its timestamp')
	await h.api.refreshLyric(true)
	assert.equal(h.api.getCurrentLyric(), null, 'Cached parser must obey the same boundary')
	assert.equal(h.settings.get('lyric.delaySeconds'), 2)
})

await suite.check('phone progress uses position rather than buffer and rebuilds for delay/source changes', async () => {
	const h = managerRuntime()
	await h.api.refreshLyric()
	const emit = (position, mediaId = 'song') => h.emit('progress', { mediaId, position, duration: 50, buffered: 40 })
	emit(11.999)
	assert.equal(h.api.getCurrentLyric(), null)
	emit(12)
	assert.equal(h.api.getCurrentLyric()?.lrc, 'First')
	emit(16)
	assert.equal(h.api.getCurrentLyric()?.lrc, 'Second')
	emit(12)
	assert.equal(h.api.getCurrentLyric()?.lrc, 'First', 'Backward seek')
	emit(40, 'stale')
	assert.equal(h.api.getCurrentLyric()?.lrc, 'First')
	h.settings.set('lyric.delaySeconds', 3)
	emit(12)
	assert.equal(h.api.getCurrentLyric(), null)
	h.original.setValue('[00:05]Replacement')
	emit(8)
	assert.equal(h.api.getCurrentLyric()?.lrc, 'Replacement')
	h.setPosition(7)
	await h.api.refreshLyric()
	assert.equal(h.api.getCurrentLyric(), null)
	assert.equal(h.settings.get('lyric.delaySeconds'), 3)
})

await suite.check('Bluetooth title projection uses the real bridge and the same positive delay/offset boundaries', async () => {
	const settings = new Map([['lyric.delaySeconds', 2], ['music.bluetoothLyrics', true]])
	const track = { id: 'song', title: 'Song' }, titles = [], timers = []
	let position = 0
	const source = '[offset:-1000]\n[00:10]First\n[00:14]Second'
	const bridgeApi = loadModule('src/helpers/carPlay.ts', {
		expo: { requireOptionalNativeModule: () => ({
			setCarPlaySnapshot: async () => {}, getPendingCarPlaySelection: async () => null,
			addListener: () => ({ remove() {} }),
		}) },
		'react-native': { Platform: { OS: 'ios' }, AppState: { addEventListener: () => ({ remove() {} }) } },
		'@rntp/player': { getActiveMediaItem: () => track, updateMetadata: (_, data) => titles.push(data.title) },
		'@/helpers/trackPlayerIndex': { getPlayList: () => [], isCurrentNativeItem: (item) => item === track,
			getProgress: () => ({ position, buffered: 40 }) },
		'@/player/PlayerStore': { currentMusicStore: { getValue: () => track },
			nowLyricState: { getValue: () => source }, playListsStore: { getValue: () => [] } },
		'@/store/PersistStatus': { get: (key) => settings.get(key) },
		'@/store/getOrCreateMMKV': () => ({ addOnValueChangedListener: () => ({ remove() {} }) }),
		'@/helpers/logger': { logError: (...args) => { throw new Error(args.join(' ')) } },
		'@/utils/lrcParser': Parser,
	}, { setInterval: (fn) => { timers.push(fn); return fn }, clearInterval() {} })
	const bridge = await bridgeApi.startCarPlayBridge()
	try {
		for (const [time, expected] of [[12.999, 'Song'], [13, 'First'], [16.999, 'First'], [17, 'Second'], [13, 'First']]) {
			position = time
			timers[0]()
			assert.equal(titles.at(-1), expected)
		}
		settings.set('lyric.delaySeconds', 3)
		timers[0]()
		assert.equal(titles.at(-1), 'Song')
		assert.equal(settings.get('lyric.delaySeconds'), 3)
	} finally { bridge.dispose() }
})

await suite.check('phone scroll targets the highlighted row and tap seeks to its effective timestamp', async () => {
	const parser = new Parser({ rawLrc: '[offset:-1000]\n[00:10]First\n[00:14]Second' }, undefined, { offset: 2 })
	const lyrics = parser.getLyric(), effects = [], scrolls = [], seeks = []
	const current = parser.getPosition(17).lrc
	const lyricState = { lyrics, meta: parser.getMeta() }
	const react = {
		createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
		useMemo: (fn) => fn(), useCallback: (fn) => fn, useRef: (value) => ({ current: value }),
		useState: (value) => [value, () => {}], useEffect: (fn) => effects.push(fn),
	}
	const Lyric = loadModule('src/components/lyric/index.tsx', {
		react,
		'react-native': { StyleSheet: { create: (value) => value }, useWindowDimensions: () => ({ width: 400, fontScale: 1 }),
			View: 'View', Text: 'Text', ActivityIndicator: 'ActivityIndicator' },
		'@/constants/tokens': {}, '@/hooks/useAppTheme': { useThemeColors: () => ({}) },
		'@/helpers/lyricManager': { useLyricState: () => lyricState, getLyricState: () => lyricState,
			useCurrentLyric: () => current, getCurrentLyric: () => current },
		'@/helpers/trackPlayerIndex': { seekTo: (time) => seeks.push(time), play: async () => {} },
		'@/hooks/useDelayFalsy': () => [undefined, () => {}],
		'@/store/PersistStatus': { useValue: (_, fallback) => fallback },
		'@/locales/commentsFeature': { t: (key) => key }, '@/utils/delay': async () => {},
		'@/utils/trackUtils': { musicIsPaused: (playing) => !playing },
		'@rntp/player': { useIsPlaying: () => true },
		'react-native-gesture-handler': { FlatList: 'FlatList' }, '../../utils/rpx': (value) => value,
		'./lyricItem': 'LyricItem',
	}).default
	const tree = Lyric({})
	const find = (node) => {
		if (!node || typeof node !== 'object') return undefined
		if (node.type === 'FlatList') return node
		return node.props?.children?.flat(Infinity).map(find).find(Boolean)
	}
	const list = find(tree)
	assert(list)
	list.props.ref({ scrollToIndex: (options) => scrolls.push(options) })
	for (const effect of effects) effect()
	assert.equal(scrolls.at(-1).index, current.index)
	assert.equal(scrolls.at(-1).viewPosition, 0.5)
	for (let index = 0; index < lyrics.length; index++) {
		const row = list.props.renderItem({ item: lyrics[index], index })
		assert.equal(row.props.highlight, index === current.index)
		await row.props.onPress()
		assert.equal(seeks.at(-1), lyrics[index].time + 3)
		assert.equal(parser.getPosition(seeks.at(-1)).index, index)
	}
})

suite.finish()
