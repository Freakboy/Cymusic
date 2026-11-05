// Run: node scripts/check-player-preparation.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import SHA256 from 'crypto-js/sha256.js'

const deferred = () => {
	let resolve, reject
	const promise = new Promise((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const flush = async () => {
	for (let i = 0; i < 100; i++) await Promise.resolve()
}
const item = {
	id: '123',
	platform: 'wy',
	title: 'Song',
	artist: 'Artist',
	album: 'Album',
	duration: 200,
}
const mid = '004IArbh3ytHgR'
const source = (id, getMusicUrl = async () => 'https://audio.test/song') => ({
	id,
	name: id,
	version: '1',
	script: '',
	getMusicUrl,
})

function harness() {
	const files = new Map()
	const tasks = []
	let downloadGate,
		size = 12,
		status = 200,
		searchCount = 0,
		searchList = [],
		scriptCalls = [],
		liveRuntime
	const uri = (path) => 'file://' + path.split('/').map(encodeURIComponent).join('/')
	class GlobalState {
		constructor(value) {
			this.value = value
		}
		getValue = () => this.value
		setValue = (value) => {
			this.value = typeof value === 'function' ? value(this.value) : value
		}
	}
	const fs = {
		documentDirectory: 'file:///docs/',
		FileSystemSessionType: { FOREGROUND: 0 },
		getInfoAsync: async (path) => ({
			exists: files.has(path),
			size: files.get(path) || 0,
			isDirectory: false,
		}),
		makeDirectoryAsync: async () => {},
		deleteAsync: async (path) => {
			for (const key of files.keys())
				if (
					key === path ||
					key.startsWith(path + '/') ||
					(path.endsWith('/') && key.startsWith(path))
				)
					files.delete(key)
		},
		moveAsync: async ({ from, to }) => {
			assert.ok(files.has(from))
			files.set(to, files.get(from))
			files.delete(from)
		},
		createDownloadResumable: (url, target, options) => {
			const task = {
				url,
				target,
				options,
				cancelled: 0,
				cancelAsync: async () => {
					task.cancelled++
				},
				downloadAsync: async () => {
					if (downloadGate) await downloadGate.promise
					files.set(target, size)
					return { status }
				},
			}
			tasks.push(task)
			return task
		},
	}
	const modules = new Map()
	const overrides = {
		'crypto-js/sha256': { default: SHA256 },
		'@/utils/stateMapper': { GlobalState },
		'@/helpers/types': { MusicRepeatMode: { QUEUE: 'queue' } },
		'@/helpers/logger': { logInfo() {}, logError() {} },
		'@/store/PersistStatus': { default: { set() {} } },
		'@/utils/utils': { showToast() {} },
		'@/constants/images': { fakeAudioMp3Uri: 'file:///fake.mp3' },
		'expo-file-system/legacy': fs,
		'@/helpers/localFile': {
			fileUriFromPath: uri,
			resolveLocalFile: async (url) =>
				url?.startsWith('file://') ? { status: 'resolved', fileUri: url } : { status: 'nonlocal' },
		},
		'../../modules/cymusic-native': { default: { documentDirectoryPath: '/docs' } },
		axios: {
			default: {
				post: async () => {
					searchCount++
					return {
						data: { code: 0, req_1: { code: 0, data: { body: { song: { list: searchList } } } } },
					}
				},
			},
		},
		'@/helpers/userApi/lxMusicSourceAdapter': {
			isLxMusicScript: () => false,
			disposeLxMusicScript: () => {
				liveRuntime = null
			},
			reloadLxMusicScript: async (api) => {
				const runtime = Symbol(api.id)
				liveRuntime = runtime
				return {
					...api,
					getMusicUrl: async (...args) => {
						assert.equal(liveRuntime, runtime, 'stale lx closure')
						scriptCalls.push([api.id, ...args])
						return api.getMusicUrl(...args)
					},
				}
			},
		},
	}
	for (const value of Object.values(overrides)) if ('default' in value) value.__esModule = true
	function load(path) {
		if (modules.has(path)) return modules.get(path)
		const exports = {}
		modules.set(path, exports)
		const code = ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		}).outputText
		vm.runInNewContext(
			code,
			{
				exports,
				URL,
				AbortController,
				setTimeout,
				clearTimeout,
				console,
				require(name) {
					if (name in overrides) return overrides[name]
					const resolved = name.startsWith('@/')
						? 'src/' + name.slice(2)
						: new URL(name, 'file:///' + path).pathname.slice(1)
					return load(resolved + '.ts')
				},
			},
			{ filename: path },
		)
		return exports
	}
	const stores = load('src/player/PlayerStore.ts')
	stores.musicApiSelectedStore.setValue(source('selected'))
	const cache = load('src/player/CacheManager.ts')
	const resolver = load('src/player/MusicSourceResolver.ts')
	return {
		load,
		files,
		tasks,
		stores,
		cache,
		resolver,
		uri,
		gate(value) {
			downloadGate = value
		},
		size(value) {
			size = value
		},
		status(value) {
			status = value
		},
		search(list) {
			searchList = list
		},
		get searchCount() {
			return searchCount
		},
		scriptCalls,
	}
}

// A shared download survives one consumer cancelling; headers and nonempty atomic commit.
{
	const h = harness(),
		gate = deferred(),
		abort = new AbortController()
	h.gate(gate)
	const track = {
		...item,
		url: 'https://audio.test/a',
		headers: { Referer: 'test' },
		userAgent: 'agent',
	}
	const a = h.cache.downloadToCache(track, { signal: abort.signal })
	const b = h.cache.downloadToCache(track)
	await flush()
	assert.equal(h.tasks.length, 1)
	assert.equal(await h.cache.isCached(item), false)
	assert.equal(h.tasks[0].options.headers.Referer, 'test')
	assert.equal(h.tasks[0].options.headers['User-Agent'], 'agent')
	abort.abort()
	await assert.rejects(a, /CACHE_CANCELLED/)
	assert.equal(h.tasks[0].cancelled, 0)
	gate.resolve()
	const path = await b
	assert.equal(await h.cache.findCachedPath(item), path)
	assert.ok([...h.files.keys()].every((path) => !path.endsWith('.part')))
	h.stores.qualityStore.setValue('320k')
	assert.equal(await h.cache.isCached(item), false)
	h.stores.qualityStore.setValue('128k')
	h.stores.musicApiSelectedStore.setValue(source('other'))
	assert.equal(await h.cache.isCached(item), false)
	console.log(
		'PASS download deduplication, shared cancellation, headers, atomic visibility and identity',
	)
}

for (const [size, status] of [
	[0, 200],
	[12, 403],
]) {
	const h = harness()
	h.size(size)
	h.status(status)
	await assert.rejects(
		h.cache.downloadToCache({ ...item, url: 'https://audio.test/a' }),
		/EMPTY_OR_FAILED/,
	)
	assert.equal(h.files.size, 0)
}

// clearCache fences a writer whose native cancellation arrives too late.
{
	const h = harness(),
		gate = deferred()
	h.gate(gate)
	const downloading = h.cache.downloadToCache({ ...item, url: 'https://audio.test/a' })
	await flush()
	const rejected = assert.rejects(downloading, /CACHE_CANCELLED/)
	const clearing = h.cache.clearCache()
	await flush()
	assert.ok(h.tasks[0].cancelled > 0)
	gate.resolve()
	await rejected
	await clearing
	assert.equal(h.files.size, 0)
	const legacy = 'file:///docs/musicCache/wy_123.mp3'
	h.files.set(legacy, 0)
	assert.equal(await h.cache.isCached(item), false)
	h.files.set(legacy, 12)
	assert.equal(await h.cache.findCachedPath(item), legacy)
	assert.equal(h.cache.getLocalFilePath(item), legacy)
	assert.equal(h.cache.getCacheFileUri(legacy), legacy)
	console.log('PASS empty/HTTP failure rejection, clear-vs-download fencing and legacy lookup')
}

// Strict cross-platform matching: no platform ID passthrough, ambiguity/version/duration rejection.
{
	const h = harness(),
		qq = h.load('src/player/sourceResolver/qqMatch.ts')
	const candidate = {
		mid,
		title: item.title,
		artist: item.artist,
		album: item.album,
		duration: 201,
	}
	assert.equal(qq.selectQQMatch(item, [candidate]), mid)
	for (const variant of [
		{ title: 'Song Live' },
		{ album: 'Other' },
		{ duration: 210 },
		{ artist: 'Other' },
	]) {
		assert.equal(qq.selectQQMatch(item, [{ ...candidate, ...variant }]), null)
	}
	assert.equal(qq.selectQQMatch(item, [candidate, { ...candidate, mid: '00000000000000' }]), null)
	h.search([
		{ mid, title: 'Song', singer: [{ name: 'Artist' }], album: { title: 'Album' }, interval: 200 },
	])
	assert.equal(await qq.resolveQQMid(item), mid)
	assert.equal(await qq.resolveQQMid(item), mid)
	assert.equal(h.searchCount, 1)
	const calls = []
	h.stores.musicApiSelectedStore.setValue(
		source('selected', async (...args) => {
			calls.push(args)
			return 'https://audio.test/a'
		}),
	)
	const result = await h.resolver.resolveSource(item)
	assert.equal(result.url, 'https://audio.test/a')
	assert.equal(calls[0][2], mid)
	h.search([])
	await h.resolver.resolveSource({ ...item, id: 'bad', title: 'Unmatched' })
	assert.equal(calls.length, 1)
	console.log('PASS strict QQ matching, cached mapping, and no Netease-ID passthrough')
}

// Legacy library records reuse either valid QQ mid without requiring searchable metadata.
{
	const h = harness(),
		qq = h.load('src/player/sourceResolver/qqMatch.ts')
	for (const platform of [undefined, '', 'QQ', 'tx', 'qqmusic']) {
		for (const ids of [{ id: mid }, { id: '123', songmid: mid }, { id: mid, songmid: 'invalid' }]) {
			assert.equal(
				await qq.resolveQQMid({
					...item,
					...ids,
					platform,
					artist: 'Unknown Artist',
					album: 'Unknown Album',
					duration: 0,
				}),
				mid,
			)
		}
	}
	assert.equal(h.searchCount, 0)
	const calls = []
	h.stores.musicApiSelectedStore.setValue(
		source('legacy', async (...args) => {
			calls.push(args)
			return 'https://audio.test/legacy'
		}),
	)
	const prepared = await h.resolver.prepareNextTrack(
		{
			...item,
			platform: undefined,
			id: mid,
			artist: 'Unknown Artist',
			album: 'Unknown Album',
			duration: 0,
		},
		'legacy-token',
	)
	assert.ok(prepared.track.url.startsWith('file:///'))
	assert.equal(calls[0][2], mid)
	assert.equal(h.tasks.length, 1)
	assert.equal(h.searchCount, 0)
	console.log('PASS legacy QQ mid passthrough and full preparation without metadata search')
}

// Placeholder metadata supplies no match evidence; explicit Netease identities never bypass search.
{
	const h = harness(),
		qq = h.load('src/player/sourceResolver/qqMatch.ts')
	const candidate = { mid, title: 'Song', artist: 'Artist', album: 'Album', duration: 200 }
	for (const album of ['Unknown Album', ' UNKNOWN album ', 'Unknown', '未知专辑', '', undefined]) {
		const incomplete = { ...item, album, duration: 0 }
		assert.equal(qq.selectQQMatch(incomplete, [candidate]), mid)
		assert.equal(
			qq.selectQQMatch(incomplete, [candidate, { ...candidate, mid: '00300000000000' }]),
			null,
		)
		assert.equal(qq.selectQQMatch(incomplete, [{ ...candidate, artist: 'Other' }]), null)
		assert.equal(qq.selectQQMatch(incomplete, [{ ...candidate, title: 'Song Live' }]), null)
	}
	for (const artist of ['Unknown Artist', 'Unknown', '未知歌手', '未知艺术家', '', undefined]) {
		assert.equal(qq.selectQQMatch({ ...item, artist }, [{ ...candidate, artist }]), null)
	}
	assert.equal(
		qq.selectQQMatch({ ...item, title: 'Unknown Title' }, [
			{ ...candidate, title: 'Unknown Title' },
		]),
		null,
	)
	h.search([
		{ mid, title: 'Song', singer: [{ name: 'Artist' }], album: { title: 'Album' }, interval: 200 },
	])
	for (const platform of ['Netease', 'wy']) {
		assert.equal(
			await qq.resolveQQMid({
				...item,
				platform,
				songmid: '00300000000000',
				album: 'Unknown Album',
				duration: 0,
			}),
			mid,
		)
		assert.equal(
			await qq.resolveQQMid({ ...item, platform, id: '00300000000000', songmid: '00300000000000' }),
			mid,
		)
	}
	assert.equal(h.searchCount, 4)
	const calls = []
	h.stores.musicApiSelectedStore.setValue(
		source('netease', async (...args) => {
			calls.push(args)
			return 'https://audio.test/matched'
		}),
	)
	await h.resolver.resolveSource({ ...item, platform: 'Netease', id: '12345678901234' })
	assert.equal(calls[0][2], mid)
	assert.equal(h.searchCount, 5)
	h.search([])
	await assert.rejects(
		qq.resolveQQMid({ ...item, platform: 'wy', id: '98765432109876' }),
		/QQ_MATCH_NOT_FOUND/,
	)
	await h.resolver.resolveSource({ ...item, platform: 'wy', id: '98765432109876' })
	assert.equal(calls.length, 1)
	console.log('PASS placeholder handling, strict ambiguity rejection and explicit Netease matching')
}

// A replacement waits for a cancelled native writer, and clearing cannot deadlock it.
{
	const h = harness(),
		gate = deferred(),
		controller = new AbortController()
	h.gate(gate)
	const track = { ...item, url: 'https://audio.test/a' }
	const first = h.cache.downloadToCache(track, { signal: controller.signal })
	await flush()
	controller.abort()
	await assert.rejects(first, /CACHE_CANCELLED/)
	const replacement = h.cache.downloadToCache(track)
	const rejected = assert.rejects(replacement, /CACHE_CANCELLED/)
	const clearing = h.cache.clearCache()
	gate.resolve()
	await rejected
	await clearing
	assert.equal(h.files.size, 0)
	console.log('PASS cancelled-writer replacement racing cache clear')
}

// Only one next slot. Preference changes invalidate even when changed back.
{
	const h = harness(),
		gate = deferred()
	h.gate(gate)
	const track = { ...item, url: 'https://audio.test/a', headers: { Cookie: 'token' } }
	const a = h.resolver.prepareNextTrack(track, 'queue-token')
	assert.equal(h.resolver.prepareNextTrack(track, 'queue-token'), a)
	await flush()
	h.stores.qualityStore.setValue('320k')
	h.stores.qualityStore.setValue('128k')
	gate.resolve()
	assert.equal(await a, null)
	await flush()
	const b = await h.resolver.prepareNextTrack(track, 'queue-token')
	assert.ok(b.track.url.startsWith('file:///'))
	assert.equal(b.track.headers.Cookie, 'token')
	assert.equal(b.mediaItem.url.headers.Cookie, 'token')
	assert.equal(b.mediaItem.extras.cymusic.placeholder, false)
	assert.equal(b.mediaItem.extras.cymusic.preparedGeneration, b.generation)
	assert.equal(h.resolver.isPreparedNextTrackValid(b), true)
	const c = await h.resolver.prepareNextTrack({ ...track, id: '456' }, 'queue-token')
	assert.equal(h.resolver.isPreparedNextTrackValid(b), false)
	assert.equal(h.resolver.isPreparedNextTrackValid(c), true)
	h.resolver.setCurrentStreamPriority(true)
	assert.equal(h.resolver.isPreparedNextTrackValid(c), false)
	assert.equal(await h.resolver.prepareNextTrack(track, 'queue-token'), null)
	h.resolver.setCurrentStreamPriority(false)
	const d = await h.resolver.prepareNextTrack(track, 'queue-token')
	await h.cache.clearCache()
	assert.equal(h.resolver.isPreparedNextTrackValid(d), false)
	console.log(
		'PASS full local preparation, metadata projection, single slot, generation, preferences, stream priority and clear invalidation',
	)
}

// The current request cancels next-file work; actual quality and plugin headers survive fallback.
{
	const h = harness(),
		gate = deferred()
	h.gate(gate)
	const preparing = h.resolver.prepareNextTrack(
		{ ...item, url: 'https://audio.test/next' },
		'next-token',
	)
	await flush()
	await h.resolver.resolveSource({ ...item, id: 'current', url: 'https://audio.test/current' })
	assert.equal(await preparing, null)
	assert.ok(h.tasks[0].cancelled > 0)
	const calls = []
	h.stores.qualityStore.setValue('flac')
	h.stores.musicApiSelectedStore.setValue(
		source('object-result', async (_title, _artist, _mid, quality) => {
			calls.push(quality)
			return quality === 'flac'
				? ''
				: {
						url: 'https://audio.test/current',
						headers: { Referer: 'source' },
						userAgent: 'source-agent',
					}
		}),
	)
	const resolved = await h.resolver.resolveSource({ ...item, platform: 'tx', id: mid })
	assert.deepEqual(calls, ['flac', '320k'])
	assert.equal(resolved.cacheIdentity.quality, '320k')
	assert.equal(resolved.headers.Referer, 'source')
	assert.equal(resolved.userAgent, 'source-agent')
	assert.equal(h.stores.qualityStore.getValue(), 'flac')
	assert.equal(await preparing, null)
	assert.ok(h.tasks[0].cancelled > 0)
	gate.resolve()
	await flush()
	assert.equal(h.files.size, 0)
	console.log('PASS current request priority, real fallback quality and object-source headers')
}

// Singleton scheduler keeps ownership until the real promise settles; current work jumps preloads.
{
	const h = harness(),
		lock = h.resolver.withSourceRuntimeLock,
		gate = deferred(),
		order = []
	const first = lock(async () => {
		order.push('first')
		await gate.promise
		order.push('settled')
	}, 'preload')
	const preload = lock(async () => {
		order.push('preload')
	}, 'preload')
	const current = lock(async () => {
		order.push('current')
	}, 'current')
	await flush()
	assert.deepEqual(order, ['first'])
	gate.resolve()
	await Promise.all([first, preload, current])
	assert.deepEqual(order, ['first', 'settled', 'current', 'preload'])
	const selected = {
		...source('lx-one', async () => {
			throw new Error('unavailable')
		}),
		scriptType: 'lxmusic',
	}
	const fallback = { ...source('lx-two'), scriptType: 'lxmusic' }
	h.stores.musicApiSelectedStore.setValue(selected)
	h.stores.musicApiStore.setValue([selected, fallback])
	const result = await h.resolver.resolveSource({ ...item, id: mid, platform: 'tx' })
	assert.equal(result.url, 'https://audio.test/song')
	assert.deepEqual(
		h.scriptCalls.map((args) => args[0]),
		['lx-one', 'lx-two'],
	)
	await assert.rejects(
		h.stores.musicApiSelectedStore.getValue().getMusicUrl('Song', 'Artist', mid, '128k'),
		/unavailable/,
	)
	console.log(
		'PASS current-priority serial runtime scheduler, fallback and selected lx runtime restoration',
	)
}

console.log('All player preparation checks passed')
