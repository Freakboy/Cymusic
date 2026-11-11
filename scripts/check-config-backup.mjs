import fs from 'node:fs'
import { assert, checks, flush, loadModule } from './native-services-fixture.mjs'

const { check, finish } = checks()
const plain = value => JSON.parse(JSON.stringify(value))
const track = (extra = {}) => ({ id: '2010', platform: 'Netease', title: 'Song', artist: 'Artist',
	album: 'Album', duration: 180, artwork: 'https://example.com/cover.jpg', ...extra })
const list = (extra = {}) => ({ id: 'remote:Netease:42', platform: 'Netease', name: 'List', title: 'List',
	artist: 'User', artwork: '', songs: [track()], ...extra })
const source = (extra = {}) => ({ id: 'source-1', name: 'Source', author: 'Author', version: '1',
	script: 'globalThis.backupScriptExecuted = true; throw new Error("MUST NOT RUN")',
	scriptType: 'cymusic', srcUrl: '', ...extra })
const backup = (extra = {}) => ({ schema: 'cymusic.config-backup', version: 1,
	settings: { 'app.language': 'en', 'music.quality': '320k', 'music.autoCacheLocal': false },
	localSettings: { 'setting.basic.maxDownload': 3, 'setting.lyric.detailFontSize': 25 },
	sources: [source()], playlists: [list()], favorites: [track()], ...extra })

function fixture() {
	const persisted = new Map([['music.progress', 99], ['music.play-list', [track({ id: 'queue-old' })]],
		['music.musicItem', track({ id: 'current-old' })], ['music.selectedMusicApi', source()],
		['music.importedLocalMusic', [track({ id: 'local-old', platform: 'local', url: 'file:///local.mp3' })]]])
	const writes = []
	const state = value => ({ getValue: () => value, setValue: next => { value = next } })
	const stores = {
		musicApiStore: state([source({ enabled: true, isSelected: true, getMusicUrl() { throw new Error('executed') } })]),
		musicApiSelectedStore: state(source()), playListsStore: state([list()]),
		qualityStore: state('128k'), autoCacheLocalStore: state(true), preloadNextTrackStore: state(false),
		isCachedIconVisibleStore: state(true), songsNumsToLoadStore: state(100),
	}
	let favorites = [track()]
	let localDisk = { setting: { basic: { maxDownload: '4', downloadPath: 'file:///private', autoPlayWhenAppStart: false },
		lyric: { detailFontSize: 22 }, webdav: { username: 'secret', password: 'secret' } },
		status: { music: { progress: 99 } } }
	let localMemory = plain(localDisk)
	const pathGet = key => key.split('.').reduce((value, part) => value?.[part], localMemory)
	let busy = false
	let failKey
	let failStorage = false
	let picker = { canceled: true }
	let pickedJson = JSON.stringify(backup())
	let info = { exists: true, isDirectory: false, size: pickedJson.length }
	let platform = 'ios'
	let shareMode = 'success'
	let shareCallbacks
	let writeFailure = false
	const calls = []
	const helper = loadModule('src/helpers/configBackup.ts', {
		'@/store/PersistStatus': { get: key => persisted.get(key) ?? null, set: (key, value) => {
			if (key === failKey) { failKey = undefined; throw new Error('disk failure') }
			writes.push([key, value]); if (value === undefined) persisted.delete(key); else persisted.set(key, value)
		} },
		'@/store/config': { get: key => key ? pathGet(key) : localMemory, setup: async () => {
			localMemory = plain(localDisk); calls.push(['Config.setup'])
		} },
		'@/helpers/storage': { setStorage: async (key, value) => {
			assert.equal(key, 'local-config')
			if (failStorage) { failStorage = false; throw new Error('local storage failure') }
			localDisk = plain(value); calls.push(['setStorage'])
		} },
		'@/player/PlayerStore': stores,
		'@/store/library': { useLibraryStore: { getState: () => ({ favorites }), setState: next => { favorites = next.favorites } } },
		'@/utils/i18n': { changeLanguage: value => calls.push(['language', value]) },
		'@/hooks/useAppTheme': { setThemeMode: value => calls.push(['theme', value]) },
		'@/helpers/sourceManagement': { assertSourceIdle: message => { if (busy) throw new Error(message) } },
		'@/player/sourceResolver/runtime': { withSourceRuntimeLock: async callback => { calls.push(['lock']); return callback() },
			releaseResolverRuntime: () => calls.push(['release']) },
		'expo-file-system/legacy': { cacheDirectory: 'file:///cache/', getInfoAsync: async () => info,
			readAsStringAsync: async uri => { calls.push(['read', uri]); return pickedJson },
			writeAsStringAsync: async (uri, json) => { calls.push(['write', uri, json]); if (writeFailure) throw new Error('write failure') },
			deleteAsync: async (uri, options) => { calls.push(['delete', uri, options]) } },
		'expo-document-picker': { getDocumentAsync: async options => { calls.push(['pick', options]); return picker } },
		'react-native': { Platform: { get OS() { return platform } }, ActionSheetIOS: {
			showShareActionSheetWithOptions: (options, failure, success) => {
				calls.push(['share', options.url, options])
				shareCallbacks = { failure, success }
				if (shareMode === 'error') failure(new Error('share failure'))
				else if (shareMode === 'throw') throw new Error('native throw')
				else if (shareMode !== 'pending') success(shareMode === 'success', 'fixture.activity')
			},
		} },
	}, { URL, TextEncoder, Error })
	return { helper, persisted, stores, writes, calls,
		get favorites() { return favorites }, get localMemory() { return localMemory }, get localDisk() { return localDisk },
		set busy(value) { busy = value }, set failKey(value) { failKey = value }, set failStorage(value) { failStorage = value },
		set picker(value) { picker = value }, set pickedJson(value) { pickedJson = value }, set info(value) { info = value },
		set platform(value) { platform = value }, set shareMode(value) { shareMode = value },
		get shareCallbacks() { return shareCallbacks }, set writeFailure(value) { writeFailure = value },
		set localMemory(value) { localMemory = value },
	}
}

await check('export whitelists both settings stores; excludes runtime, URLs, headers, caches and device files', () => {
	const f = fixture()
	f.persisted.set('app.language', 'zh')
	f.persisted.set('app.themeMode', 'dark')
	f.persisted.set('music.progress', 88)
	f.stores.playListsStore.setValue([list({ customCover: true, coverImg: 'file:///private/cover.jpg',
		remoteBinding: { platform: 'Netease', remoteId: '42', sourceUrl: '42', lastImportedAt: 99,
			remoteSongKeys: ['Netease:2010', 'QQ:2010'] },
		songs: [track({ url: 'https://secret.test/stream?token=SECRET', headers: { Authorization: 'SECRET' },
			source: { flac: { url: 'file:///cache/music.mp3' } }, $localLyric: 'file:///lyric',
			verifiedArtwork: 'https://example.com/cover.jpg', localAdded: true }),
			track({ id: '/private/local.mp3', platform: 'local' }), track({ id: 'local:1', platform: 'local' })] })])
	f.stores.musicApiStore.setValue([source({ enabled: true, isSelected: true, getMusicUrl: () => 'runtime',
		importUrl: 'file:///source.js', script: 'const apiKey = "PRIVATE_KEY";' })])
	const json = f.helper.serializeConfigBackup()
	const result = JSON.parse(json)
	assert.equal(result.settings['app.themeMode'], 'dark')
	assert.equal(result.localSettings['setting.basic.maxDownload'], 4)
	assert.equal(result.localSettings['setting.lyric.detailFontSize'], 22)
	assert.equal(result.playlists[0].songs.length, 1)
	assert.equal(result.playlists[0].songs[0].localAdded, true)
	assert.equal(result.playlists[0].songs[0].verifiedArtwork, 'https://example.com/cover.jpg')
	assert.equal(result.playlists[0].coverImg, '')
	assert.deepEqual(result.playlists[0].remoteBinding.remoteSongKeys, ['Netease:2010', 'QQ:2010'])
	assert.equal(result.sources[0].script, 'const apiKey = "PRIVATE_KEY";')
	for (const value of ['SECRET', 'file://', 'getMusicUrl', 'enabled', 'isSelected', 'downloadPath', 'webdav',
		'autoPlayWhenAppStart', 'music.progress', 'music.play-list', 'music.musicItem', 'status']) assert.ok(!json.includes(value), value)
	assert.equal(f.writes.length, 0)
	assert.ok(f.helper.parseConfigBackup(json))
})

await check('preview validates without persisting, running scripts or changing live stores', () => {
	const f = fixture()
	const old = f.stores.musicApiStore.getValue()
	const result = f.helper.parseConfigBackup(JSON.stringify(backup()))
	assert.deepEqual(plain(f.helper.configBackupPreview(result)), { settings: 3, localSettings: 2,
		sources: 1, playlists: 1, songs: 1, favorites: 1 })
	assert.equal(result.sources[0].enabled, false)
	assert.equal(result.sources[0].isSelected, false)
	assert.equal(result.sources[0].getMusicUrl, undefined)
	assert.equal(f.stores.musicApiStore.getValue(), old)
	assert.equal(f.writes.length, 0)
	assert.equal(f.calls.length, 0)
})

await check('schema/version, unknown keys, pollution keys and wrong scalar types are rejected before writes', () => {
	const f = fixture()
	const bad = [null, [], {}, backup({ version: 2 }), backup({ schema: 'other' }), backup({ settings: [] }),
		backup({ localSettings: undefined }), backup({ sources: {} }), backup({ playlists: 'list' }),
		backup({ settings: { 'music.progress': 10 } }), backup({ settings: { 'music.preloadNextTrack': 'yes' } }),
		backup({ settings: { 'music.quality': 'hires' } }), backup({ settings: { 'music.songsNumsToLoad': 1.5 } }),
		backup({ localSettings: { 'setting.basic.downloadPath': 'file:///private' } }),
		backup({ localSettings: { 'setting.basic.autoPlayWhenAppStart': true } }),
		backup({ localSettings: { 'setting.lyric.fontSize': '22' } }),
		backup({ settings: JSON.parse('{"__proto__":{"polluted":true}}') }),
		backup({ sources: [source({ enabled: true })] }), backup({ sources: [source({ script: {} })] }),
		backup({ sources: [source({ scriptType: 'unknown' })] }),
		backup({ favorites: [track({ url: 'https://stream.test' })] }),
		backup({ favorites: [track({ id: 'file:///private/song.mp3' })] }),
		backup({ favorites: [track({ platform: 'local' })] }),
		backup({ favorites: [track({ artwork: 'file:///private/cover.jpg' })] }),
		backup({ favorites: [track({ artwork: 'https://user:pass@example.com/cover' })] }),
		backup({ favorites: [track({ title: {} })] }), backup({ favorites: [track({ duration: -1 })] }),
		backup({ sources: [source(), source()] }), backup({ playlists: [list(), list()] }),
	]
	for (const value of bad) assert.throws(() => f.helper.parseConfigBackup(JSON.stringify(value)))
	assert.throws(() => f.helper.parseConfigBackup('{bad json'))
	assert.equal(f.writes.length, 0)
	assert.equal(f.calls.length, 0)
	assert.equal({}.polluted, undefined)
})

await check('byte, collection, metadata and script limits are enforced, with a bounded 2000-song backup accepted', () => {
	const f = fixture()
	const limits = f.helper.CONFIG_BACKUP_LIMITS
	for (const value of [backup({ sources: Array.from({ length: limits.sources + 1 }, (_, i) => source({ id: `s${i}` })) }),
		backup({ playlists: Array.from({ length: limits.playlists + 1 }, (_, i) => list({ id: `l${i}`, songs: [] })) }),
		backup({ favorites: Array(limits.tracks + 1).fill(track()) }),
		backup({ favorites: Array(limits.tracks).fill(track()) }),
		backup({ sources: [source({ script: 'x'.repeat(limits.script + 1) })] }),
		backup({ favorites: [track({ title: 'x'.repeat(1025) })] }),
		backup({ settings: { 'music.songsNumsToLoad': 2001 } }),
		backup({ localSettings: { 'setting.basic.maxDownload': 17 } }),
	]) assert.throws(() => f.helper.parseConfigBackup(JSON.stringify(value)))
	assert.throws(() => f.helper.parseConfigBackup(' '.repeat(f.helper.CONFIG_BACKUP_MAX_BYTES + 1)))
	assert.throws(() => f.helper.parseConfigBackup(JSON.stringify(backup({ sources: Array.from({ length: 12 },
		(_, i) => source({ id: `source${i}`, script: '中'.repeat(400000) })) }))))
	assert.equal(f.helper.parseConfigBackup(JSON.stringify(backup({ playlists: [list({ songs: Array(2000).fill(track()) })] }))).playlists[0].songs.length, 2000)
})

await check('confirmed apply replaces collections, synchronizes both storage systems, disables sources, leaves queue/current/local untouched', async () => {
	const f = fixture()
	const queue = f.persisted.get('music.play-list')
	const current = f.persisted.get('music.musicItem')
	const local = f.persisted.get('music.importedLocalMusic')
	const result = f.helper.parseConfigBackup(JSON.stringify(backup({ settings: { 'app.language': 'en', 'app.themeMode': 'light',
		'music.quality': 'flac', 'music.preloadNextTrack': true, 'music.autoCacheLocal': false,
		'music.isCachedIconVisible': false, 'music.songsNumsToLoad': 200 } })))
	await f.helper.applyConfigBackup(result, 'busy')
	assert.equal(f.persisted.get('music.selectedMusicApi'), undefined)
	assert.equal(f.stores.musicApiSelectedStore.getValue(), null)
	assert.equal(f.stores.musicApiStore.getValue()[0].enabled, false)
	assert.equal(f.stores.musicApiStore.getValue()[0].getMusicUrl, undefined)
	assert.deepEqual(plain(f.stores.musicApiStore.getValue()), plain(f.persisted.get('music.musicApi')))
	assert.deepEqual(plain(f.stores.playListsStore.getValue()), plain(f.persisted.get('music.playLists')))
	assert.deepEqual(plain(f.favorites), plain(f.persisted.get('music.favorites')))
	assert.equal(f.stores.qualityStore.getValue(), 'flac')
	assert.equal(f.stores.preloadNextTrackStore.getValue(), true)
	assert.equal(f.stores.autoCacheLocalStore.getValue(), false)
	assert.equal(f.stores.isCachedIconVisibleStore.getValue(), false)
	assert.equal(f.stores.songsNumsToLoadStore.getValue(), 200)
	assert.equal(f.localMemory.setting.basic.maxDownload, 3)
	assert.equal(f.localMemory.setting.lyric.detailFontSize, 25)
	assert.deepEqual(f.localMemory, f.localDisk)
	assert.equal(f.localMemory.setting.basic.downloadPath, 'file:///private')
	assert.equal(f.localMemory.setting.webdav.password, 'secret')
	assert.equal(f.persisted.get('music.play-list'), queue)
	assert.equal(f.persisted.get('music.musicItem'), current)
	assert.equal(f.persisted.get('music.importedLocalMusic'), local)
	assert.equal(f.persisted.get('music.progress'), 99)
	assert.deepEqual(f.calls.filter(([type]) => ['language', 'theme'].includes(type)), [['language', 'en'], ['theme', 'light']])
	assert.ok(f.calls.every(([type]) => ['lock', 'setStorage', 'Config.setup', 'release', 'language', 'theme'].includes(type)))
	// Simulate a later collection save and a later Config.set: imported values must be the live source of truth.
	f.persisted.set('music.playLists', f.stores.playListsStore.getValue())
	const laterConfig = plain(f.localMemory)
	laterConfig.setting.basic.maxHistoryLen = 50
	assert.equal(laterConfig.setting.lyric.detailFontSize, 25)
	assert.ok(f.helper.parseConfigBackup(f.helper.serializeConfigBackup()))
})

await check('invalid input and source busy cannot apply; write failure rolls back before publishing collection stores', async () => {
	const f = fixture()
	const old = f.stores.playListsStore.getValue()
	await assert.rejects(f.helper.applyConfigBackup(backup({ settings: { 'music.progress': 9 } }), 'busy'))
	assert.equal(f.writes.length, 0)
	f.busy = true
	await assert.rejects(f.helper.applyConfigBackup(backup(), 'busy'), /busy/)
	assert.equal(f.writes.length, 0)
	f.busy = false
	const before = plain([...f.persisted])
	const localBefore = plain(f.localMemory)
	f.failKey = 'music.playLists'
	await assert.rejects(f.helper.applyConfigBackup(backup(), 'busy'), /disk failure/)
	assert.deepEqual(plain([...f.persisted]).sort(), before.sort())
	assert.deepEqual(f.localMemory, localBefore)
	assert.equal(f.stores.playListsStore.getValue(), old)
	f.failStorage = true
	await assert.rejects(f.helper.applyConfigBackup(backup(), 'busy'), /local storage failure/)
	assert.equal(f.stores.playListsStore.getValue(), old)
	f.localMemory = null
	assert.throws(() => f.helper.serializeConfigBackup(), /initialized/)
	await assert.rejects(f.helper.applyConfigBackup(backup(), 'busy'), /initialized/)
})

await check('document picker cancel is passive; copied JSON is size-checked before read and preview does not apply', async () => {
	const f = fixture()
	assert.equal(await f.helper.pickConfigBackup(), null)
	assert.equal(f.writes.length, 0)
	f.picker = { canceled: false, assets: [{ uri: 'file:///cache/picked.json', size: 100 }] }
	assert.ok(await f.helper.pickConfigBackup())
	assert.deepEqual(plain(f.calls.find(([type]) => type === 'pick')[1]), { type: ['application/json', 'text/plain'],
		copyToCacheDirectory: true, multiple: false })
	assert.equal(f.writes.length, 0)
	const reads = () => f.calls.filter(([type]) => type === 'read').length
	const before = reads()
	f.info = { exists: true, isDirectory: false, size: f.helper.CONFIG_BACKUP_MAX_BYTES + 1 }
	await assert.rejects(f.helper.pickConfigBackup())
	assert.equal(reads(), before)
	f.picker = { canceled: false, assets: [{ uri: 'file:///large.json', size: f.helper.CONFIG_BACKUP_MAX_BYTES + 1 }] }
	await assert.rejects(f.helper.pickConfigBackup())
	assert.equal(reads(), before)
	f.picker = { canceled: false, assets: [{ uri: 'file:///missing.json' }] }
	f.info = { exists: false }
	await assert.rejects(f.helper.pickConfigBackup())
	f.info = { exists: true, isDirectory: false, size: 5 }
	f.pickedJson = '{bad}'
	await assert.rejects(f.helper.pickConfigBackup())
	assert.equal(f.writes.length, 0)
})

await check('iOS shares a validated local JSON file; success, cancellation, callback error and native throw all clean up', async () => {
	for (const mode of ['success', 'cancel', 'error', 'throw']) {
		const f = fixture()
		f.shareMode = mode
		if (mode === 'error' || mode === 'throw') await assert.rejects(f.helper.shareConfigBackup(), /share failure|native throw/)
		else assert.equal(await f.helper.shareConfigBackup(), mode === 'success', 'cancel is false, never reported as success')
		const write = f.calls.find(([type]) => type === 'write')
		const share = f.calls.find(([type]) => type === 'share')
		const remove = f.calls.find(([type]) => type === 'delete')
		assert.match(write[1], /^file:\/\/\/cache\/cymusic-config-\d+\.json$/)
		assert.ok(f.helper.parseConfigBackup(write[2]))
		assert.equal(share[1], write[1])
		assert.deepEqual(plain(share[2]), { url: write[1], subject: 'CyMusic configuration backup' })
		assert.equal(share[2].message, undefined, 'file attachment, never a JSON text message')
		assert.equal(remove[1], write[1])
		assert.deepEqual(plain(remove[2]), { idempotent: true })
		assert.equal(f.writes.length, 0)
	}
})

await check('sensitive session file survives until the native callback; file failures and non-iOS export fail safely', async () => {
	for (const mode of ['success', 'cancel', 'error']) {
		const f = fixture()
		f.shareMode = 'pending'
		let settled = false
		const pending = f.helper.shareConfigBackup()
		const observed = pending.then(value => { settled = true; return value }, error => { settled = true; throw error })
		await flush()
		assert.ok(f.shareCallbacks)
		assert.equal(settled, false)
		assert.equal(f.calls.some(([type]) => type === 'delete'), false)
		if (mode === 'error') {
			const rejected = assert.rejects(observed, /callback failed/)
			f.shareCallbacks.failure(new Error('callback failed'))
			await rejected
		} else {
			f.shareCallbacks.success(mode === 'success', 'fixture.activity')
			assert.equal(await observed, mode === 'success')
		}
		assert.equal(f.calls.filter(([type]) => type === 'delete').length, 1)
	}
	const failed = fixture()
	failed.writeFailure = true
	await assert.rejects(failed.helper.shareConfigBackup(), /write failure/)
	assert.equal(failed.calls.some(([type]) => type === 'share'), false)
	assert.equal(failed.calls.filter(([type]) => type === 'delete').length, 1)
	for (const platform of ['android', 'web']) {
		const f = fixture()
		f.platform = platform
		await assert.rejects(f.helper.shareConfigBackup(), error => error.message === f.helper.CONFIG_BACKUP_EXPORT_UNSUPPORTED)
		assert.equal(f.calls.length, 0, 'unsupported platform neither writes a file nor falls back to text sharing')
	}
})

await check('settings UI keeps two grouped rows, explicit destructive preview confirmation and sensitive export warning', () => {
	const ui = fs.readFileSync('src/app/(modals)/settingModal.tsx', 'utf8')
	assert.match(ui, /title: backupText.section/)
	assert.match(ui, /id: 'exportConfig'.*type: 'link'/)
	assert.match(ui, /id: 'importConfig'.*type: 'link'/)
	assert.match(ui, /Alert.alert\(backupText.exportTitle, backupText.exportWarning/)
	assert.match(ui, /configBackupPreview\(backup\)/)
	assert.match(ui, /text: backupText.confirm, style: 'destructive', onPress:/)
	assert.match(ui, /applyConfigBackup\(backup, backupText.busy\)/)
	const texts = fs.readFileSync('src/locales/configBackup.ts', 'utf8')
	for (const word of ['密钥', '敏感', '禁用', '不会自动播放', 'API keys', 'disabled', 'No playback or downloads']) assert.ok(texts.includes(word))
	const helper = fs.readFileSync('src/helpers/configBackup.ts', 'utf8')
	for (const forbidden of ['new Function', 'eval(', 'importManagedSource(', 'loadResolverSource(',
		'setPlayList(', 'addAll(', 'download(', 'play(']) assert.ok(!helper.includes(forbidden), forbidden)
})

function settingsFixture(f) {
	const alerts = []
	const slots = []
	let index = 0
	const react = {
		createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
		useMemo: callback => callback(),
		useState(initial) {
			const key = index++
			slots[key] ??= { value: initial }
			return [slots[key].value, value => { slots[key].value = value }]
		},
		useRef(initial) { return slots[index++] ??= { current: initial } },
	}
	const value = initial => ({ useValue: () => initial })
	const texts = loadModule('src/locales/configBackup.ts', { '@/utils/i18n': { nowLanguage: { getValue: () => 'en' } } })
	const module = loadModule('src/app/(modals)/settingModal.tsx', {
		react, '@/constants/tokens': {}, '@/helpers/logger': { logInfo() {}, logError() {} },
		'@/helpers/trackPlayerIndex': { __esModule: true, default: {}, autoCacheLocalStore: value(false),
			isCachedIconVisibleStore: value(true), nowApiState: value('正常'), songsNumsToLoadStore: value(100),
			useCurrentQuality: () => ['128k', () => {}] },
		'@/hooks/useAppTheme': { useThemeColors: () => ({}), useThemeMode: () => ({ themeMode: 'system', setThemeMode() {} }) },
		'@/store/PersistStatus': { useValue: (_key, fallback) => fallback },
		'@/player/PlayerStore': { musicApiSelectedStore: value(null) },
		'@/utils/i18n': { __esModule: true, default: { t: key => key }, changeLanguage() {}, nowLanguage: value('en') },
		'@/utils/utils': { showToast() {} }, '@react-native-menu/menu': { MenuView: 'Menu' },
		'expo-constants': { expoConfig: { version: 'test' } }, 'expo-router': { useRouter: () => ({ push() {} }) },
		'@/helpers/releaseVersion': { isNewerRelease: () => false },
		'react-native': { ActivityIndicator: 'Spinner', Image: 'Image', Linking: {}, Platform: { OS: 'ios' },
			ScrollView: 'Scroll', StyleSheet: { create: styles => styles }, Switch: 'Switch', Text: 'Text',
			TouchableOpacity: 'Button', View: 'View', Alert: { alert: (...args) => alerts.push(args) } },
		'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0 }) },
		'react-native-toast-message': { __esModule: true, default: 'Toast', BaseToast: 'BaseToast', ErrorToast: 'ErrorToast' },
		'@/assets/144.png': 1, '@/helpers/configBackup': f.helper, '@/locales/configBackup': texts,
	}, { Error })
	const all = node => !node || typeof node !== 'object' ? [] : [node,
		...(node.props?.children ?? []).flat(Infinity).flatMap(all)]
	return { alerts, render() { index = 0; return module.default() },
		button(tree, action) { return all(tree).find(node => node.type === 'Button'
			&& node.props.accessibilityLabel === texts.configBackupText()[action]) },
	}
}

await check('rendered settings require preview confirmation; cancel is passive, repeat presses deduplicate and only confirm applies', async () => {
	const f = fixture()
	f.picker = { canceled: false, assets: [{ uri: 'file:///cache/picked.json' }] }
	const ui = settingsFixture(f)
	const button = ui.button(ui.render(), 'import')
	button.props.onPress()
	button.props.onPress()
	await flush()
	assert.equal(f.calls.filter(([type]) => type === 'pick').length, 1)
	assert.equal(ui.alerts.length, 1)
	assert.equal(f.writes.length, 0)
	assert.match(ui.alerts[0][1], /3 MMKV settings · 2 local-config settings/)
	assert.ok(ui.button(ui.render(), 'import').props.disabled)
	ui.alerts[0][2].find(action => action.style === 'cancel').onPress()
	assert.equal(f.writes.length, 0)
	assert.equal(ui.button(ui.render(), 'import').props.disabled, false)
	ui.button(ui.render(), 'import').props.onPress()
	await flush()
	assert.equal(f.writes.length, 0)
	ui.alerts[1][2].find(action => action.style === 'destructive').onPress()
	await flush()
	await flush()
	assert.ok(f.writes.length > 0)
	assert.equal(f.stores.musicApiSelectedStore.getValue(), null)
	assert.equal(ui.alerts[2][0], 'Configuration imported')
	assert.equal(ui.button(ui.render(), 'import').props.disabled, false)
})

await check('rendered export warns about secrets before file sharing, and cancellation never serializes or shares', async () => {
	const f = fixture()
	const ui = settingsFixture(f)
	ui.button(ui.render(), 'export').props.onPress()
	assert.equal(f.calls.length, 0)
	assert.match(ui.alerts[0][1], /API keys or other secrets/)
	ui.alerts[0][2].find(action => action.style === 'cancel').onPress()
	assert.equal(f.calls.length, 0)
	ui.button(ui.render(), 'export').props.onPress()
	ui.alerts[1][2].find(action => action.text === 'Continue sharing').onPress()
	await flush()
	assert.ok(f.calls.some(([type]) => type === 'share'))
	assert.equal(f.writes.length, 0)
})

await check('rendered export cancellation stays silent and non-iOS export shows the explicit unsupported message', async () => {
	for (const platform of ['ios', 'android']) {
		const f = fixture()
		f.platform = platform
		f.shareMode = 'cancel'
		const ui = settingsFixture(f)
		ui.button(ui.render(), 'export').props.onPress()
		ui.alerts[0][2].find(action => action.text === 'Continue sharing').onPress()
		await flush()
		await flush()
		if (platform === 'ios') assert.equal(ui.alerts.length, 1, 'native cancel produces no success or error alert')
		else {
			assert.equal(ui.alerts.length, 2)
			assert.match(ui.alerts[1][1], /iOS-only.*Android export is deferred/)
			assert.equal(f.calls.length, 0)
		}
		assert.equal(ui.button(ui.render(), 'export').props.disabled, false)
	}
})

finish()
