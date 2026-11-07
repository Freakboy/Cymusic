// Real facade + synchronous native seam. No source/transport mutation is permitted by a repair.
import fs from 'node:fs'
import ts from 'typescript'
import { createFixture, item } from './file-system-fixture.mjs'
import { assert, checks, deferred, loadModule } from './native-services-fixture.mjs'
import { fakeClock } from './request-fixture.mjs'

const suite = checks()
const fixture = createFixture()
const artwork = 'https://p2.music.126.net/confirmed/109951170012345678.jpg'
const song = (id = '2010', platform = 'Netease') => item(id, `https://audio.example/${id}.mp3`, {
	platform, artwork: '', headers: { Authorization: 'source-secret' }, userAgent: 'source-agent',
	cacheSourceId: 'cache-source-hash', cacheQuality: 'flac',
})
function runtime() {
	const sources = []
	let resolveSource = track => ({
		url: track.url, headers: track.headers, userAgent: track.userAgent, wasCached: false,
		cacheIdentity: { sourceId: track.cacheSourceId, quality: track.cacheQuality },
	})
	const h = fixture.runtime({ moduleOverrides: {
		'@/player/MusicSourceResolver': {
			resolveSource: async track => { sources.push(track); return resolveSource(track) },
			prepareNextTrack: async () => null, cancelPreparedNextTrack() {},
			isPreparedNextTrackValid: () => false, setCurrentStreamPriority() {},
			withSourceRuntimeLock: action => action(),
		},
	} })
	Object.assign(h.player, h.load('node_modules/@rntp/player/src/events/index.ts'))
	h.player.replaceMediaItem = (index, track) => { h.calls.player.push(['replace', index, track]); h.player.queue[index] = track }
	return { ...h, sources, facade: h.load('src/helpers/trackPlayerIndex.ts').default,
		setResolver: resolver => { resolveSource = resolver },
	}
}

function artworkBatch(h) {
	const clock = fakeClock()
	const helper = loadModule('src/helpers/neteaseArtwork.ts', {
		'@/player/PlayerStore': h.stores, '@/store/PersistStatus': h.persistence,
		'@/store/playList': { getPlayList: h.facade.getPlayList, setPlayList: tracks => {
			const queue = h.facade.getPlayList()
			queue.splice(0, queue.length, ...tracks)
			h.persistence.set('music.play-list', tracks)
		} },
		'@/utils/imageUtils': h.load('src/utils/imageUtils.ts'), './userApi/remotePlaylist': {},
	}, { ...clock, URL })
	return { ...helper, clock }
}

for (const timing of ['early', 'late', 'none']) {
	await suite.check(`pending B retains confirmed artwork through source resolution with helper flush ${timing}`, async () => {
		const h = runtime()
		const a = song(), b = song('2011', 'wy')
		await h.facade.play(a)
		h.player.progress.position = 8.75
		const old = h.player.queue[0], oldToken = old.extras.cymusic.token
		const pending = deferred()
		h.setResolver(() => pending.promise)
		const playback = h.facade.play(b)
		assert.equal(h.facade.getCurrentMusic().id, b.id)
		const loading = h.stores.trackSourceLoadingStore.getValue()
		assert.ok(loading)
		const batch = artworkBatch(h)
		if (timing !== 'none') batch.updateTrackArtwork(b, artwork)
		const commands = h.calls.player.length
		assert.equal(h.facade.updateCurrentArtwork({ id: b.id, platform: '163' }, artwork), false, 'not yet published to native A')
		assert.equal(h.calls.player.length, commands)
		assert.equal(h.player.queue[0], old)
		assert.equal(h.player.queue[0].extras.cymusic.token, oldToken)
		assert.equal(h.player.progress.position, 8.75)
		assert.equal(h.stores.trackSourceLoadingStore.getValue(), loading)
		if (timing === 'early') {
			batch.clock.advance(250)
			assert.equal(h.facade.getCurrentMusic().artwork, artwork)
			assert.equal(h.player.queue[0].artworkUrl, undefined)
		}
		pending.resolve({ url: 'https://audio.example/resolved-B.flac', wasCached: false,
			headers: { Authorization: 'resolved-B' }, userAgent: 'resolved-agent',
			cacheIdentity: { sourceId: 'resolved-cache', quality: '320k' },
		})
		await playback
		const native = h.player.queue[0], current = h.facade.getCurrentMusic()
		assert.equal(native.artworkUrl, artwork)
		assert.equal(current.artwork, artwork)
		assert.equal(h.persistence.get('music.musicItem').artwork, artwork)
		assert.equal(native.url.uri, 'https://audio.example/resolved-B.flac')
		assert.equal(native.url.headers.Authorization, 'resolved-B')
		assert.equal(current.userAgent, 'resolved-agent')
		assert.equal(current.cacheSourceId, 'resolved-cache')
		assert.equal(current.cacheQuality, '320k')
		assert.notEqual(native.extras.cymusic.token, oldToken)
		assert.equal(native.extras.cymusic.id, b.id)
		assert.equal(h.stores.trackSourceLoadingStore.getValue(), null)
		assert.equal(h.player.progress.position, 0, 'only the selected B load resets progress')
		assert.equal(h.sources.length, 2)
		assert.deepEqual(h.calls.player.slice(commands).map(call => call[0]), ['items', 'play'])
		if (timing === 'late') {
			h.player.progress.position = 1.25
			batch.clock.advance(250)
			assert.equal(h.player.queue[0], native)
			assert.equal(h.facade.getCurrentMusic().artwork, artwork)
			assert.equal(h.player.progress.position, 1.25)
			assert.equal(h.calls.player.length, commands + 2)
		}
	})
}

await suite.check('pending confirmations reject foreign selection and late source completions before merging', async () => {
	const h = runtime()
	await h.facade.play(song('2009'))
	const native = h.player.queue[0]
	const a = song(), b = song('2011')
	const first = deferred(), second = deferred()
	h.setResolver(track => track.id === a.id ? first.promise : second.promise)
	const playA = h.facade.play(a)
	assert.equal(h.facade.updateCurrentArtwork(b, 'https://example.com/foreign-B.jpg'), false)
	const playB = h.facade.play(b)
	assert.equal(h.facade.updateCurrentArtwork(a, 'https://example.com/foreign-A.jpg'), false)
	assert.equal(h.facade.updateCurrentArtwork(b, artwork), false)
	first.resolve({ url: a.url, wasCached: false })
	await playA
	assert.equal(h.player.queue[0], native)
	assert.equal(h.facade.getCurrentMusic().id, b.id)
	second.resolve({ url: b.url, wasCached: false })
	await playB
	assert.equal(h.player.queue[0].artworkUrl, artwork)
	h.setResolver(track => ({ url: track.url, wasCached: false }))
	await h.facade.play(a)
	assert.equal(h.player.queue[0].artworkUrl, undefined, 'foreign callback was never retained for A')
})

await suite.check('superseded same-ID source cannot consume pending artwork or replace the newer loading token', async () => {
	const h = runtime()
	await h.facade.play(song())
	const oldNative = h.player.queue[0], b = song('2011')
	const first = deferred(), latest = deferred()
	let requests = 0
	h.setResolver(() => ++requests === 1 ? first.promise : latest.promise)
	const oldPlay = h.facade.play(b)
	const oldLoading = h.stores.trackSourceLoadingStore.getValue()
	assert.equal(h.facade.updateCurrentArtwork(b, artwork), false)
	const newPlay = h.facade.play(b, true)
	const newLoading = h.stores.trackSourceLoadingStore.getValue()
	assert.notEqual(newLoading, oldLoading)
	first.resolve({ url: 'https://audio.example/obsolete.mp3', wasCached: false })
	await oldPlay
	assert.equal(h.player.queue[0], oldNative)
	assert.equal(h.stores.trackSourceLoadingStore.getValue(), newLoading)
	latest.resolve({ url: 'https://audio.example/latest.mp3', wasCached: false })
	await newPlay
	assert.equal(h.player.queue[0].url, 'https://audio.example/latest.mp3')
	assert.equal(h.player.queue[0].artworkUrl, artwork)
	assert.equal(h.facade.getCurrentMusic().artwork, artwork)
	assert.equal(h.stores.trackSourceLoadingStore.getValue(), null)
})

await suite.check('pending confirmed artwork is bounded to 128 identities', async () => {
	const h = runtime()
	await h.facade.play(song())
	const pending = deferred(), playbacks = []
	h.setResolver(() => pending.promise)
	for (let index = 0; index < 129; index++) {
		const selected = song(String(5000 + index))
		playbacks.push(h.facade.play(selected))
		assert.equal(h.facade.updateCurrentArtwork(selected, `https://example.com/${selected.id}.jpg`), false)
	}
	pending.resolve({ url: 'https://audio.example/resolved.mp3', wasCached: false })
	await Promise.all(playbacks)
	assert.equal(h.player.queue[0].artworkUrl, 'https://example.com/5128.jpg')
	await h.facade.play(song('5000'))
	assert.equal(h.player.queue[0].artworkUrl, undefined, 'oldest unconsumed entry was evicted')
	await h.facade.play(song('5001'))
	assert.equal(h.player.queue[0].artworkUrl, 'https://example.com/5001.jpg', 'recent same-song confirmation is retained')
})

await suite.check('confirmed native artwork updates metadata only, preserving progress, headers, cache identity and token', async () => {
	const h = runtime()
	await h.facade.play(song())
	h.player.progress.position = 8.75
	const before = h.player.queue[0]
	const token = before.extras.cymusic.token
	const url = JSON.stringify(before.url)
	const extras = JSON.stringify(before.extras)
	const calls = h.calls.player.length
	const writes = h.calls.writes.length
	assert.equal(h.facade.updateCurrentArtwork({ id: 2010, platform: 'wy' }, artwork), true)
	assert.deepEqual(h.calls.player.slice(calls), [['metadata', 0, { artworkUrl: artwork }]])
	assert.equal(h.player.queue.length, 2)
	assert.equal(h.player.activeIndex, 0)
	assert.equal(JSON.stringify(h.player.queue[0].url), url)
	assert.equal(JSON.stringify(h.player.queue[0].extras), extras)
	assert.equal(h.player.queue[0].extras.cymusic.token, token)
	assert.equal(h.player.progress.position, 8.75)
	assert.equal(h.sources.length, 1)
	const current = h.facade.getCurrentMusic()
	assert.equal(current.artwork, artwork)
	assert.equal(current.headers.Authorization, 'source-secret')
	assert.equal(current.cacheSourceId, 'cache-source-hash')
	assert.equal(current.cacheQuality, 'flac')
	assert.deepEqual(h.calls.writes.slice(writes).map(write => write.key), ['music.musicItem'])
	assert.equal(h.persistence.get('music.musicItem').artwork, artwork)
	// Normal resume retains the queue; forced recovery must read the updated JS source snapshot.
	h.facade.pause()
	const items = h.calls.player.filter(call => call[0] === 'items').length
	await h.facade.play()
	assert.equal(h.calls.player.filter(call => call[0] === 'items').length, items)
	assert.equal(h.player.progress.position, 8.75)
	h.player.state = 'error'
	await h.facade.play()
	assert.equal(h.player.queue[0].artworkUrl, artwork)
	assert.notEqual(h.player.queue[0].extras.cymusic.token, token)
	assert.equal(h.facade.getCurrentMusic().headers.Authorization, 'source-secret')
	assert.equal(h.sources.length, 1)
})

await suite.check('late A cannot update B or QQ with the same ID; A -> B -> A accepts the same-song image without old token reuse', async () => {
	const h = runtime()
	const a = song(), b = song('2011')
	await h.facade.play(a)
	const old = h.player.queue[0]
	await h.facade.play(b)
	const calls = h.calls.player.length
	assert.equal(h.facade.updateCurrentArtwork(a, artwork), false)
	assert.equal(h.calls.player.length, calls)
	assert.equal(h.facade.getCurrentMusic().id, '2011')
	assert.equal(h.persistence.get('music.musicItem').id, '2011')
	await h.facade.play(song('2010', 'QQ'))
	assert.equal(h.facade.updateCurrentArtwork(a, artwork), false)
	await h.facade.play(a)
	const token = h.player.queue[0].extras.cymusic.token
	assert.notEqual(token, old.extras.cymusic.token)
	assert.equal(h.facade.updateCurrentArtwork({ id: a.id, platform: 'netease' }, artwork), true)
	assert.equal(h.player.queue[0].extras.cymusic.token, token)
	assert.equal(h.facade.isCurrentNativeItem(old), false)
})

await suite.check('missing/unsafe ID, foreign native ownership, placeholder and pending source never publish metadata', async () => {
	const h = runtime()
	await h.facade.play(song())
	const calls = h.calls.player.length
	for (const id of [undefined, '', NaN, Number.MAX_SAFE_INTEGER + 1]) {
		assert.equal(h.facade.updateCurrentArtwork({ id, platform: 'wy' }, artwork), false)
	}
	const owned = h.player.queue[0]
	h.player.queue[0] = { ...owned, extras: { ...owned.extras, cymusic: { ...owned.extras.cymusic, token: 'foreign' } } }
	assert.equal(h.facade.updateCurrentArtwork(song(), artwork), false)
	h.player.queue[0] = owned
	h.player.activeIndex = 1
	assert.equal(h.facade.updateCurrentArtwork(song(), artwork), false)
	h.player.activeIndex = 0
	h.stores.currentMusicStore.setValue(song('2011'))
	assert.equal(h.facade.updateCurrentArtwork(song('2011'), artwork), false)
	assert.equal(h.calls.player.length, calls)
})

await suite.check('native metadata failure does not publish success or change current artwork', async () => {
	const h = runtime()
	await h.facade.play(song())
	const before = h.facade.getCurrentMusic()
	h.player.updateMetadata = () => { throw new Error('native unavailable') }
	assert.equal(h.facade.updateCurrentArtwork(song(), artwork), false)
	assert.equal(h.facade.getCurrentMusic(), before)
	assert.equal(h.persistence.get('music.musicItem').artwork, '')
	h.player.state = 'error'
	await h.facade.play()
	assert.equal(h.player.queue[0].artworkUrl, undefined, 'native failure never becomes pending confirmed metadata')
	assert.equal(h.facade.getCurrentMusic().artwork, '')
})

await suite.check('main/Floating Image wiring uses hook source and completion callbacks; main opts into full resolution', () => {
	for (const file of ['src/app/player.tsx', 'src/components/FloatingPlayer.tsx']) {
		const source = fs.readFileSync(file, 'utf8')
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
		const hooks = [], images = []
		const visit = node => {
			if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useTrackArtwork') hooks.push(node)
			if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(tree) === 'Image') images.push(node)
			ts.forEachChild(node, visit)
		}
		visit(tree)
		assert.equal(hooks.length, 1)
		const hook = hooks[0]
		assert.equal(hook.parent.parent.parent.parent.kind, ts.SyntaxKind.Block, 'hook runs at component scope')
		assert.match(hook.arguments[1].getText(tree), /^!!current/)
		assert.match(hook.arguments[2].getText(tree), /onConfirmed: myTrackPlayer.updateCurrentArtwork/)
		if (file.includes('/app/')) assert.match(hook.arguments[2].getText(tree), /fullSize: true/)
		assert.ok(images.some(image => ['source={artwork.source}', 'onError={artwork.onError}', 'onLoad={artwork.onLoad}']
			.every(prop => image.getText(tree).includes(prop))))
	}
})

await suite.check('Floating hooks run with no track and pass lastTrack as noncurrent across fake256 UI renders', () => {
	let current = null, last = null
	const hooks = []
	const react = {
		memo: component => component, useMemo: compute => compute(), useCallback: callback => callback,
		useRef: value => ({ current: value }), useEffect() {},
		createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
	}
	const { FloatingPlayer } = loadModule('src/components/FloatingPlayer.tsx', {
		react,
		'@/components/PlayerControls': { PlayPauseButton: 'Play', SkipToNextButton: 'Next' },
		'@/helpers/trackPlayerIndex': { __esModule: true, default: { useCurrentMusic: () => current, updateCurrentArtwork() {} }, trackSourceLoadingStore: { useValue: () => null } },
		'@/constants/tokens': {}, '@/hooks/useAppTheme': { useAppTheme: () => ({}), useThemeColors: () => ({}) },
		'@/hooks/useLastActiveTrack': { useLastActiveTrack: () => last },
		'@/hooks/useTrackArtwork': { useTrackArtwork: (...args) => { hooks.push(args); return { source: { uri: 'asset:default' }, onLoad() {}, onError() {} } } },
		'@/styles': { useDefaultStyles: () => ({}) }, 'expo-blur': { BlurView: 'Blur' },
		'expo-haptics': {}, 'expo-router': { useRouter: () => ({}) },
		'react-native': { StyleSheet: { create: value => value }, TouchableOpacity: 'Touch', View: 'View' },
		'expo-image': { Image: 'Image' },
		'react-native-reanimated': { __esModule: true, default: { View: 'AnimatedView' }, useAnimatedStyle: fn => fn(), useSharedValue: value => ({ value }), withTiming: value => value },
		'./MovingText': { MovingText: 'Text' },
	})
	assert.equal(FloatingPlayer({}), null)
	assert.equal(hooks.length, 1)
	for (let index = 0; index < 256; index++) {
		last = song(String(index + 1))
		current = index % 2 ? last : null
		assert.ok(FloatingPlayer({}))
		assert.equal(hooks.at(-1)[0], last)
		assert.equal(hooks.at(-1)[1], !!current)
	}
})

await fixture.dispose()
suite.finish()
