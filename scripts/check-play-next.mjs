import { createRequire } from 'node:module'
import { createFixture, item } from './file-system-fixture.mjs'
import { assert, checks, deferred, loadModule } from './native-services-fixture.mjs'

const require = createRequire(import.meta.url), fixture = createFixture(), suite = checks()
const song = (id, platform = 'tx') => item(id, `https://audio.test/${platform}/${id}.mp3`, { platform })
function runtime() {
	const h = fixture.runtime()
	Object.assign(h.player, h.load('node_modules/@rntp/player/src/events/index.ts'))
	h.player.replaceMediaItem = (index, media) => {
		assert.notEqual(index, h.player.activeIndex)
		h.player.queue[index] = media
	}
	const facade = h.load('src/helpers/trackPlayerIndex.ts').default
	return { ...h, facade }
}

await suite.check('addNext moves existing songs by platform/id without interrupting current, including shuffle and pause', async () => {
	for (const mode of ['queue', 'shuffle']) {
		for (const paused of [false, true]) {
			const h = runtime(), a = song('a'), b = song('b'), c = song('c'), collision = song('c', 'wy')
			h.facade.addAll([c, a, b, collision])
			h.stores.repeatModeStore.setValue(mode)
			await h.facade.play(a)
			if (paused) h.facade.pause()
			const current = h.facade.getCurrentMusic(), native = h.player.queue[0]
			const commands = h.calls.player.length
			h.facade.addNext(c)
			assert.deepEqual(h.facade.getPlayList().map((s) => [s.platform, s.id]), [['tx', 'a'], ['tx', 'c'], ['tx', 'b'], ['wy', 'c']])
			assert.equal(h.facade.getNextMusic().id, 'c')
			assert.equal(h.facade.getCurrentMusic(), current); assert.equal(h.player.queue[0], native)
			assert.equal(h.player.isPlaying(), !paused)
			assert.equal(h.calls.player.length, commands, 'No play, stop, clear or source install')
			h.facade.addNext(c)
			assert.equal(h.facade.getPlayList().filter((s) => s.id === 'c' && s.platform === 'tx').length, 1)
			const queue = h.facade.getPlayList()
			h.facade.addNext(a)
			assert.equal(h.facade.getPlayList(), queue, 'Current track is a strict no-op')
		}
	}
})

await suite.check('empty queue insertion does not select current or start playback; new song is next not tail', async () => {
	const h = runtime(), a = song('a'), b = song('b'), c = song('c')
	h.facade.addNext(a)
	assert.deepEqual(h.facade.getPlayList().map((s) => s.id), ['a'])
	assert.equal(h.facade.getCurrentMusic(), null); assert.equal(h.player.queue.length, 0)
	assert.equal(h.calls.player.length, 0)
	h.facade.addAll([b]); await h.facade.play(a)
	h.facade.addNext(c)
	assert.deepEqual(h.facade.getPlayList().map((s) => s.id), ['a', 'c', 'b'])
})

await suite.check('addNext preserves Stop and pending source ownership and persists the new order', async () => {
	const h = runtime(), a = song('a'), b = song('b'), c = song('c')
	h.facade.addAll([a, b]); await h.facade.play(a); h.facade.stop()
	const commands = h.calls.player.length
	h.facade.addNext(c)
	assert.equal(h.calls.player.length, commands); assert.equal(h.player.isPlaying(), false)
	assert.equal(h.stores.playbackIntentStore.getValue(), 'stop')
	assert.deepEqual(h.persistence.get('music.play-list').map((track) => track.id), ['a', 'c', 'b'])
	const pending = deferred(), h2 = runtime()
	const selected = song('003testmid0001')
	delete selected.url
	const source = { id: 'test', getMusicUrl: async () => pending.promise }
	h2.stores.musicApiSelectedStore.setValue(source); h2.stores.musicApiStore.setValue([source])
	h2.facade.addAll([selected, b])
	const playback = h2.facade.play(selected)
	await new Promise(setImmediate)
	const token = h2.stores.trackSourceLoadingStore.getValue()
	assert(token)
	h2.facade.addNext(c)
	assert.equal(h2.stores.trackSourceLoadingStore.getValue(), token)
	assert.equal(h2.facade.getCurrentMusic().id, selected.id)
	pending.resolve('https://audio.test/current.mp3'); await playback
	assert.equal(h2.facade.getNextMusic().id, 'c')
	assert.equal(h2.player.queue[1].extras.cymusic.id, 'c')
})

await suite.check('actual TrackShortcutsMenu always offers play-next and dispatches addNext, never toggle remove/add', async () => {
	const h = runtime(), a = song('a'), b = song('b')
	h.facade.addAll([a, b]); await h.facade.play(a)
	const react = { useCallback: (fn) => fn, useMemo: (fn) => fn(), useState: (value) => [value, () => {}],
		createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }
	const { TrackShortcutsMenu } = loadModule('src/components/TrackShortcutsMenu.tsx', {
		react, 'ts-pattern': require('ts-pattern'),
		'@/helpers/trackPlayerIndex': { __esModule: true, default: h.facade },
		'@/helpers/userApi/getMusicSource': {}, '@/helpers/userApi/neteaseComments': { getCommentsPlatform: () => null },
		'@/store/library': { useFavorites: () => ({ favorites: [], toggleTrackFavorite() {} }) },
		'@/store/playList': { isInPlayList: () => true }, '@/store/queue': { useQueue: () => ({ activeQueueId: 'owned' }) },
		'@/locales/commentsFeature': { __esModule: true, default: { t: (key) => key } },
		'@/locales/playNext': { usePlayNextText: () => '下一首播放' },
		'@/locales/songInformation': { useSongInformationText: () => ({ heading: '歌曲信息' }) },
		'@/helpers/songInformation': { songInformationRoute: () => ({}) },
		'@/helpers/neteaseArtwork': { refreshTrackArtwork: async track => { refreshed.push(track.id); return true } },
		'@/utils/imageUtils': { neteaseArtworkKey: track => track.platform === 'Netease' ? track.id : null },
		'@/locales/artworkRefresh': { useArtworkRefreshText: () => ({ action: '重新获取封面' }) },
		'react-native': { Alert: { alert() { throw new Error('Unexpected alert') } } },
		'@react-native-menu/menu': { MenuView: 'MenuView' }, 'expo-router': { useRouter: () => ({}), useFocusEffect: (fn) => fn() },
	}, { React: react })
	const refreshed = []
	const artworkMenu = TrackShortcutsMenu({ track: { ...b, platform: 'Netease' } })
	assert(artworkMenu.props.actions.some(action => action.id === 'refresh-artwork'))
	await artworkMenu.props.onPressAction({ nativeEvent: { event: 'refresh-artwork' } })
	assert.deepEqual(refreshed, ['b'])
	assert.equal(h.facade.getCurrentMusic().id, 'a')
	for (const track of [a, b, song('new')]) {
		const tree = TrackShortcutsMenu({ track })
		assert.equal(tree.props.actions[0].id, 'play-next'); assert.equal(tree.props.actions[0].title, '下一首播放')
		assert(!tree.props.actions.some((a) => ['add-to-playlist', 'remove-from-playlist'].includes(a.id)))
		await tree.props.onPressAction({ nativeEvent: { event: 'play-next' } })
		assert.equal(h.facade.getCurrentMusic().id, 'a')
		if (track.id !== 'a') assert.equal(h.facade.getNextMusic().id, track.id)
	}
})

await suite.check('play-next text supports both languages without touching shared locale JSON', () => {
	let language = 'zh'
	const text = loadModule('src/locales/playNext.ts', { '@/utils/i18n': { nowLanguage: { useValue: () => language } } })
	assert.equal(text.usePlayNextText(), '下一首播放')
	language = 'en'; assert.equal(text.usePlayNextText(), 'Play next')
})

await fixture.dispose(); suite.finish()
