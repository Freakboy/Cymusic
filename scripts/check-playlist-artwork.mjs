import fs from 'node:fs'
import { assert, checks, loadModule } from './native-services-fixture.mjs'

const suite = checks()
const files = ['src/components/PlaylistListItem.tsx', 'src/components/PlaylistTracksList.tsx', 'src/app/(modals)/importPlayList.tsx']

await suite.check('playlist row, detail and preview use the shared artwork fallback with error handlers', () => {
	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8')
		assert.match(source, /usePlaylistArtwork\(/, file)
		assert.match(source, /onError=\{\w+\.onError\}/, file)
	}
})

await suite.check('missing, invalid and failed remote images fall back to a bundled image without persisting a fake cover', () => {
	const states = [], refs = []
	let index = 0, refIndex = 0
	const hook = loadModule('src/hooks/usePlaylistArtwork.ts', {
		react: {
			useState(value) {
				const at = index++
				if (!(at in states)) states[at] = value
				return [states[at], next => { states[at] = typeof next === 'function' ? next(states[at]) : next }]
			},
			useRef(value) { return refs[refIndex++] ??= { current: value } },
		},
		'@/constants/images': { unknownTrackImageUri: 'asset://default-cover' },
		'@/utils/imageUtils': loadModule('src/utils/imageUtils.ts', {}, { URL }),
	}).usePlaylistArtwork
	const render = (playlist) => { index = refIndex = 0; return hook(playlist) }
	for (const playlist of [undefined, { id: 'missing', artwork: '' }, { id: 'invalid', coverImg: 'Unknown' }]) {
		const cover = render(playlist)
		assert.equal(cover.source.uri, 'asset://default-cover')
		cover.onError()
		assert.equal(render(playlist).source.uri, 'asset://default-cover')
	}
	const playlist = { id: 'wy', coverImg: 'https://cdn.example/one.jpg', artwork: 'https://cdn.example/two.jpg' }
	const snapshot = JSON.stringify(playlist)
	let cover = render(playlist)
	assert.equal(cover.source.uri, playlist.coverImg)
	assert.equal(cover.placeholder.uri, 'asset://default-cover')
	const stale = cover.onError
	cover.onError(); cover = render(playlist)
	assert.equal(cover.source.uri, playlist.artwork)
	cover.onError(); cover = render(playlist)
	assert.equal(cover.source.uri, 'asset://default-cover')
	const updated = { ...playlist, artwork: 'https://cdn.example/new.jpg', coverImg: 'https://cdn.example/new.jpg' }
	cover = render(updated)
	stale()
	assert.equal(render(updated).source.uri, updated.artwork)
	assert.equal(JSON.stringify(playlist), snapshot)
	const local = { id: 'local', artwork: 'file:///cover.png' }
	assert.equal(render(local).source.uri, local.artwork)
})

suite.finish()
