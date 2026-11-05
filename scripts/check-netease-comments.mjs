// node scripts/check-netease-comments.mjs [--live]
import { assert, checks, deferred, flush, loadModule } from './native-services-fixture.mjs'
import { fakeClock } from './request-fixture.mjs'

const { check, finish } = checks()
const path = 'src/helpers/userApi/neteaseComments.ts'
const comment = (id) => ({
	commentId: id,
	content: `comment ${id}`,
	user: { nickname: 'reader', avatarUrl: 'http://example.com/a.jpg' },
	timeStr: '2021-04-10',
	likedCount: 5,
})
function fixture(data, options = {}) {
	const clock = fakeClock()
	const calls = []
	const api = loadModule(
		path,
		{},
		{
			...clock,
			fetch: async (url, init) => {
				calls.push({ url, init })
				return { ok: true, json: async () => data, ...options }
			},
		},
	)
	return { ...api, clock, calls }
}

await check('platform contract includes QQ/tx/default and Netease/wy only', () => {
	const f = fixture()
	for (const value of [undefined, '', 'QQ', 'tx']) assert.equal(f.getCommentsPlatform(value), 'QQ')
	for (const value of ['Netease', 'wy']) assert.equal(f.getCommentsPlatform(value), 'Netease')
	assert.equal(f.getCommentsPlatform('local'), undefined)
})

for (const mode of ['hot', 'latest']) {
	await check(
		`${mode} uses its own list, real offset, server continuation and normalized fields`,
		async () => {
			const f = fixture({
				code: 200,
				total: 500,
				hasMore: false,
				more: false,
				hotComments: [comment(1)],
				comments: [comment(2)],
			})
			const result = await f.getNeteaseComments('186016', mode, 3)
			assert.equal(result.comments[0].id, mode === 'hot' ? '1' : '2')
			assert.equal(result.comments[0].avatar, 'https://example.com/a.jpg')
			assert.equal(result.comments[0].text, mode === 'hot' ? 'comment 1' : 'comment 2')
			assert.equal(result.hasMore, false)
			assert.match(f.calls[0].url, /limit=20&offset=40$/)
			assert.match(f.calls[0].url, mode === 'hot' ? /\/hotcomments\// : /\/comments\//)
			assert.equal(f.calls[0].init.credentials, 'omit')
			assert.equal(f.clock.pending, 0)
		},
	)
}

await check('only an explicit valid empty response is an empty success', async () => {
	const f = fixture({ code: 200, total: 0, more: false, comments: [] })
	assert.equal((await f.getNeteaseComments('1', 'latest')).comments.length, 0)
	for (const data of [
		null,
		{ code: 301 },
		{ code: 200 },
		{ code: 200, total: 1, more: true, comments: [] },
		{ code: 200, total: 1, more: false, comments: [{ content: 'no id' }] },
		{ code: 200, total: 0, comments: [] },
	]) {
		const bad = fixture(data)
		await assert.rejects(bad.getNeteaseComments('1', 'latest'), bad.NeteaseCommentsError)
		assert.equal(bad.clock.pending, 0)
	}
})

await check('invalid IDs/pages never request; HTTP, JSON and timeout failures reject', async () => {
	const f = fixture()
	for (const [id, page] of [
		['qq-mid', 1],
		['0', 1],
		['1', 0],
		['1', 1.5],
	]) {
		await assert.rejects(f.getNeteaseComments(id, 'hot', page))
	}
	assert.equal(f.calls.length, 0)
	for (const options of [
		{ ok: false, status: 403 },
		{
			json: async () => {
				throw new Error('not JSON')
			},
		},
	]) {
		const bad = fixture(null, options)
		await assert.rejects(bad.getNeteaseComments('1', 'hot'), bad.NeteaseCommentsError)
		assert.equal(bad.clock.pending, 0)
	}
	const clock = fakeClock()
	const api = loadModule(
		path,
		{},
		{
			...clock,
			fetch: (_url, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('aborted')))
				}),
		},
	)
	const pending = assert.rejects(api.getNeteaseComments('1', 'hot'), api.NeteaseCommentsError)
	clock.advance(15000)
	await pending
	assert.equal(clock.pending, 0)
})

// Drive the real screen handlers to exercise request guards across both providers.
function screenFixture() {
	const slots = [],
		effects = [],
		calls = []
	let cursor = 0,
		tree
	const params = { platform: 'Netease', id: '186016' }
	const react = {
		createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
		useState(initial) {
			const i = cursor++
			slots[i] ??= { value: initial }
			return [
				slots[i].value,
				(value) => {
					slots[i].value = typeof value === 'function' ? value(slots[i].value) : value
				},
			]
		},
		useRef(initial) {
			return (slots[cursor++] ??= { current: initial })
		},
		useMemo(fn, deps) {
			const i = cursor++
			if (!slots[i] || deps.some((d, j) => d !== slots[i].deps[j])) slots[i] = { value: fn(), deps }
			return slots[i].value
		},
		useCallback(fn, deps) {
			return react.useMemo(() => fn, deps)
		},
		useEffect(fn, deps) {
			const i = cursor++,
				old = slots[i]
			if (!old || deps.some((d, j) => d !== old.deps[j])) {
				slots[i] = { deps }
				effects.push(() => {
					old?.cleanup?.()
					slots[i].cleanup = fn()
				})
			}
		},
	}
	const request = (provider, mode, page) => {
		const task = deferred()
		calls.push({ provider, mode, page, ...task })
		return task.promise
	}
	const Screen = loadModule('src/app/(modals)/comments.tsx', {
		react,
		'@/constants/tokens': { screenPadding: { horizontal: 16 } },
		'@/hooks/useAppTheme': { useThemeColors: () => ({}) },
		'@/locales/commentsFeature': { t: (key) => key },
		'expo-router': { useLocalSearchParams: () => params },
		'react-native': {
			View: 'View',
			Text: 'Text',
			Image: 'Image',
			ActivityIndicator: 'Spinner',
			FlatList: 'List',
			StyleSheet: { create: (s) => s },
		},
		'@/helpers/userApi/neteaseComments': {
			getCommentsPlatform: fixture().getCommentsPlatform,
			getNeteaseComments: (_id, mode, page) => request('Netease', mode, page),
		},
		'@/components/utils/musicSdk/tx/comment': {
			getHotComment: (_song, page) => request('QQ', 'hot', page),
			getComment: (_song, page) => request('QQ', 'latest', page),
		},
	}).default
	function nodes(node = tree) {
		if (!node || typeof node !== 'object') return []
		if (Array.isArray(node)) return node.flatMap(nodes)
		return [node, ...nodes(node.props?.children)]
	}
	return {
		calls,
		params,
		render() {
			cursor = 0
			tree = Screen()
			while (effects.length) effects.shift()()
		},
		list: () => nodes().find((n) => n.type === 'List')?.props,
		press(key) {
			const node = nodes().find(
				(n) => n.type === 'Text' && n.props.children.includes(`commentsFeature.${key}`),
			)
			assert.ok(node, key)
			node.props.onPress()
		},
		unmount() {
			for (const slot of slots) slot?.cleanup?.()
		},
	}
}

await check(
	'screen blocks duplicate pagination, keeps failed page retry, rejects stale mode/platform/unmount results',
	async () => {
		const f = screenFixture()
		f.render()
		f.calls[0].resolve({ comments: [{ id: 'a' }], hasMore: true })
		await flush()
		f.render()
		f.list().onEndReached()
		f.list().onEndReached()
		assert.equal(f.calls.length, 2)
		assert.equal(f.calls[1].page, 2)
		f.calls[1].reject(new Error('restricted'))
		await flush()
		f.render()
		f.list().onEndReached()
		assert.equal(f.calls.length, 2)
		// Footer elements are passed as props, so invoke its retry directly.
		f.list().ListFooterComponent.props.children[1].props.onPress()
		assert.equal(f.calls[2].page, 2)
		f.press('latest')
		f.render()
		f.calls[3].resolve({ comments: [{ id: 'latest' }], hasMore: false })
		f.calls[2].resolve({ comments: [{ id: 'stale-hot' }], hasMore: true })
		await flush()
		f.render()
		assert.equal(f.list().data[0].id, 'latest')
		f.press('hot')
		f.render()
		f.params.platform = 'QQ'
		f.params.id = 'qq-mid'
		f.render()
		assert.equal(f.calls[5].provider, 'QQ')
		f.calls[5].resolve({ comments: [{ id: 'qq' }], maxPage: 1 })
		f.calls[4].resolve({ comments: [{ id: 'stale-netease' }], hasMore: true })
		await flush()
		f.render()
		assert.equal(f.list().data[0].id, 'qq')
		f.press('latest')
		f.render()
		f.unmount()
		f.calls[6].resolve({ comments: [{ id: 'after-unmount' }], maxPage: 1 })
		await flush()
		f.render()
		assert.equal(f.list(), undefined)
	},
)

if (process.argv.includes('--live')) {
	await check(
		'LIVE anonymous NetEase endpoints return distinct pages for hot and latest',
		async () => {
			const api = loadModule(path, {}, { fetch })
			for (const mode of ['hot', 'latest']) {
				const a = await api.getNeteaseComments('186016', mode, 1)
				const b = await api.getNeteaseComments('186016', mode, 2)
				assert.ok(a.comments.length && b.comments.length && a.hasMore)
				assert.notDeepEqual(
					a.comments.map((c) => c.id),
					b.comments.map((c) => c.id),
				)
				console.log(
					`${mode}: pages=${a.comments.length}/${b.comments.length}, first=${a.comments[0].id}, date=${a.comments[0].timeStr}`,
				)
			}
		},
	)
}

finish()
