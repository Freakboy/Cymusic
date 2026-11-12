import * as FileSystem from 'expo-file-system/legacy'
import * as DocumentPicker from 'expo-document-picker'
import { ActionSheetIOS, Platform } from 'react-native'
import PersistStatus from '@/store/PersistStatus'
import Config from '@/store/config'
import { setStorage } from '@/helpers/storage'
import * as stores from '@/player/PlayerStore'
import { useLibraryStore } from '@/store/library'
import { changeLanguage } from '@/utils/i18n'
import { setThemeMode } from '@/hooks/useAppTheme'
import { assertSourceIdle } from '@/helpers/sourceManagement'
import { releaseResolverRuntime, withSourceRuntimeLock } from '@/player/sourceResolver/runtime'

export const CONFIG_BACKUP_SCHEMA = 'cymusic.config-backup'
export const CONFIG_BACKUP_EXPORT_UNSUPPORTED = 'CONFIG_BACKUP_EXPORT_IOS_ONLY'
export const CONFIG_BACKUP_MAX_BYTES = 10 * 1024 * 1024
export const CONFIG_BACKUP_LIMITS = { playlists: 200, tracks: 20000, sources: 100, script: 512 * 1024 }
const settingsRules = {
	'app.language': ['zh', 'en'], 'app.themeMode': ['system', 'light', 'dark'],
	'music.quality': ['128k', '320k', 'flac'],
	'music.autoCacheLocal': 'boolean', 'music.preloadNextTrack': 'boolean',
	'music.bluetoothLyrics': 'boolean', 'music.preciseSeeking': 'boolean',
	'music.isCachedIconVisible': 'boolean', 'music.songsNumsToLoad': [1, 2000],
	'lyric.showTranslation': 'boolean', 'lyric.displayMode': ['original', 'bilingual', 'translation'],
	'lyric.detailFontSize': [0, 3], 'lyric.delaySeconds': [-30, 30],
	'search.playbackMode': ['append', 'newplaylist'],
} as const
// local-config is a separate storage system. Only portable preferences, never status.*,
// downloadPath/background, WebDAV credentials or automatic startup actions.
const localRules = {
	'setting.basic.useCelluarNetworkPlay': 'boolean', 'setting.basic.useCelluarNetworkDownload': 'boolean',
	'setting.basic.maxDownload': [1, 16], 'setting.basic.notInterrupt': 'boolean',
	'setting.basic.tempRemoteDuck': ['暂停', '降低音量'], 'setting.basic.autoStopWhenError': 'boolean',
	'setting.basic.maxCacheSize': [0, 102400],
	'setting.basic.defaultPlayQuality': ['128k', '320k', 'flac'],
	'setting.basic.defaultDownloadQuality': ['128k', '320k', 'flac'],
	'setting.basic.playQualityOrder': ['asc', 'desc'], 'setting.basic.downloadQualityOrder': ['asc', 'desc'],
	'setting.basic.musicDetailDefault': ['album', 'lyric'], 'setting.basic.musicDetailAwake': 'boolean',
	'setting.basic.maxHistoryLen': [0, 10000], 'setting.basic.associateLyricType': ['input', 'search'],
	'setting.basic.showExitOnNotification': 'boolean', 'setting.basic.musicOrderInLocalSheet': ['start', 'end'],
	'setting.basic.tryChangeSourceWhenPlayFail': 'boolean',
	'setting.basic.debug.errorLog': 'boolean', 'setting.basic.debug.traceLog': 'boolean', 'setting.basic.debug.devLog': 'boolean',
	'setting.lyric.showStatusBarLyric': 'boolean', 'setting.lyric.topPercent': [0, 100],
	'setting.lyric.leftPercent': [0, 100], 'setting.lyric.widthPercent': [0, 100],
	'setting.lyric.align': [0, 2], 'setting.lyric.fontSize': [10, 80], 'setting.lyric.detailFontSize': [10, 80],
	'setting.lyric.autoSearchLyric': 'boolean', 'setting.theme.backgroundOpacity': [0, 1],
	'setting.theme.backgroundBlur': [0, 100], 'setting.theme.followSystem': 'boolean',
	'setting.backup.resumeMode': ['append', 'overwrite'],
} as const
type LocalKey = keyof typeof localRules
type SettingKey = keyof typeof settingsRules
type Settings = Partial<Record<SettingKey, string | number | boolean>>
export type ConfigBackup = {
	schema: typeof CONFIG_BACKUP_SCHEMA
	version: 1
	settings: Settings
	localSettings: Partial<Record<LocalKey, string | number | boolean>>
	sources: IMusic.MusicApi[]
	playlists: IMusic.PlayList[]
	favorites: IMusic.IMusicItem[]
}

function invalid(): never { throw new Error('Invalid or unsupported configuration backup') }
// UTF-8 byte count including replacement of lone surrogates; no RN global/polyfill required.
function utf8Bytes(value: string): number {
	let bytes = 0
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code < 0x80) bytes++
		else if (code < 0x800) bytes += 2
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
			&& value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
		else bytes += 3
	}
	return bytes
}
export type ConfigBackupExportStage = 'collect' | 'validate' | 'cache' | 'write' | 'share' | 'cleanup'
function exportFailure(stage: ConfigBackupExportStage): Error {
	// Never include native error messages, payloads, paths, scripts or credentials.
	return new Error(`CONFIG_BACKUP_EXPORT_${stage.toUpperCase()}`)
}
export function configBackupExportStage(error: unknown): ConfigBackupExportStage | null {
	const message = error instanceof Error ? error.message : ''
	const stage = message.match(/^CONFIG_BACKUP_EXPORT_(COLLECT|VALIDATE|CACHE|WRITE|SHARE|CLEANUP)$/)?.[1]
	return stage ? stage.toLowerCase() as ConfigBackupExportStage : null
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
	return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: readonly string[], strict: boolean) {
	if (strict && Object.keys(value).some(key => !allowed.includes(key))) invalid()
}
function text(value: unknown, max = 1024): string {
	if (value === undefined) return ''
	if (typeof value !== 'string' || value.length > max) return invalid()
	return value
}
function identifier(value: unknown): string {
	const id = text(value, 256)
	if (!id || !/^[\w:.-]+$/.test(id)) return invalid()
	return id
}
function http(value: unknown, strict: boolean): string {
	const uri = text(value, 4096)
	if (!uri) return ''
	try {
		const url = new URL(uri)
		if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return uri
	} catch { /* Never migrate device-local paths or malformed URLs. */ }
	if (strict) invalid()
	return ''
}
function array(value: unknown, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) return invalid()
	return value
}
function boolean(value: unknown): boolean {
	if (typeof value !== 'boolean') return invalid()
	return value
}
function number(value: unknown, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return invalid()
	return value
}

const songFields = ['id', 'platform', 'title', 'artist', 'album', 'duration', 'artwork', 'verifiedArtwork',
	'songmid', 'songId', 'albummid', 'albumid', 'strMediaMid', 'localAdded']
function song(value: unknown, strict: boolean): IMusic.IMusicItem | null {
	const raw = object(value)
	keys(raw, songFields, strict)
	// Local songs cannot play on another device. Do not export their path-based identities.
	if (!strict && (typeof raw.platform === 'string' && /^(local|file|本地)$/i.test(raw.platform)
		|| typeof raw.id === 'string' && !/^[\w:.-]+$/.test(raw.id))) return null
	const platform = identifier(raw.platform)
	if (/^(local|file|本地)$/i.test(platform)) return invalid()
	const result: IMusic.IMusicItem = {
		id: identifier(raw.id), platform, title: text(raw.title), artist: text(raw.artist), album: text(raw.album),
		duration: raw.duration === undefined ? 0 : number(raw.duration, 0, 604800), artwork: http(raw.artwork, strict),
	}
	for (const key of ['songmid', 'albummid', 'strMediaMid'] as const)
		if (raw[key] !== undefined) result[key] = identifier(raw[key])
	for (const key of ['songId', 'albumid'] as const) {
		if (raw[key] !== undefined) result[key] = typeof raw[key] === 'number'
			? number(raw[key], 0, Number.MAX_SAFE_INTEGER) : identifier(raw[key])
		if (typeof result[key] === 'number' && !Number.isSafeInteger(result[key])) invalid()
	}
	if (raw.localAdded !== undefined) result.localAdded = boolean(raw.localAdded)
	const verified = http(raw.verifiedArtwork, strict)
	if (verified && verified === result.artwork) result.verifiedArtwork = verified
	return result
}

function outboundSong(value: unknown): IMusic.IMusicItem | null {
	try {
		const raw = { ...object(value) }
		for (const key of ['id', 'songmid', 'albummid', 'strMediaMid'])
			if (typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0) raw[key] = String(raw[key])
		if (Array.isArray(raw.artist)) raw.artist = raw.artist.map(item =>
			typeof item === 'string' ? item : typeof item?.name === 'string' ? item.name : '').filter(Boolean).join(', ')
		for (const key of ['title', 'artist', 'album', 'artwork', 'verifiedArtwork'])
			if (raw[key] === null) delete raw[key]
		if (raw.duration === null) delete raw.duration
		return song(raw, false)
	} catch { return null } // One corrupt record must not destroy all collections.
}

function normalize(value: unknown, strict: boolean): ConfigBackup {
	const raw = object(value)
	keys(raw, ['schema', 'version', 'settings', 'localSettings', 'sources', 'playlists', 'favorites'], strict)
	if (raw.schema !== CONFIG_BACKUP_SCHEMA || raw.version !== 1) invalid()
	const prefs = object(raw.settings)
	keys(prefs, Object.keys(settingsRules), strict)
	const settings: Settings = {}
	for (const key of Object.keys(settingsRules) as SettingKey[]) {
		try {
		const value = prefs[key]
		if (value === undefined) continue
		const rule = settingsRules[key]
		if (rule === 'boolean') settings[key] = boolean(value)
		else if (typeof rule[0] === 'number') {
			settings[key] = number(value, rule[0], rule[1] as number)
			if (['music.songsNumsToLoad', 'lyric.detailFontSize'].includes(key) && !Number.isInteger(value)) invalid()
		} else {
			if (!(rule as readonly unknown[]).includes(value)) invalid()
			settings[key] = value as string
		}
		} catch (error) { if (strict) throw error; delete settings[key] }
	}
	const localPrefs = object(raw.localSettings)
	keys(localPrefs, Object.keys(localRules), strict)
	const localSettings: ConfigBackup['localSettings'] = {}
	for (const key of Object.keys(localRules) as LocalKey[]) {
		try {
		const value = localPrefs[key]
		if (value === undefined) continue
		const rule = localRules[key]
		if (rule === 'boolean') localSettings[key] = boolean(value)
		else if (typeof rule[0] === 'number') localSettings[key] = number(value, rule[0], rule[1] as number)
		else {
			if (!(rule as readonly unknown[]).includes(value)) invalid()
			localSettings[key] = value as string
		}
		} catch (error) { if (strict) throw error; delete localSettings[key] }
	}
	let totalTracks = 0
	const tracks = (value: unknown) => {
		const items = array(value, CONFIG_BACKUP_LIMITS.tracks)
		totalTracks += items.length
		if (totalTracks > CONFIG_BACKUP_LIMITS.tracks) invalid()
		return items.map(item => strict ? song(item, true) : outboundSong(item)).filter((item): item is IMusic.IMusicItem => !!item)
	}
	const playlists = array(raw.playlists, CONFIG_BACKUP_LIMITS.playlists).map(value => {
		const item = object(value)
		keys(item, ['id', 'platform', 'artist', 'title', 'name', 'description', 'artwork', 'coverImg',
			'customName', 'customCover', 'remoteBinding', 'songs'], strict)
		const result: IMusic.PlayList = {
			id: identifier(item.id), platform: text(item.platform, 256), artist: text(item.artist),
			title: text(item.title), name: text(item.name), description: text(item.description, 10000),
			artwork: http(item.artwork, strict), coverImg: http(item.coverImg, strict), songs: tracks(!strict && item.songs == null ? [] : item.songs),
		}
		if (item.customName !== undefined) result.customName = boolean(item.customName)
		if (item.customCover !== undefined && result.coverImg) result.customCover = boolean(item.customCover)
		if (item.remoteBinding !== undefined) {
			const binding = object(item.remoteBinding)
			keys(binding, ['platform', 'remoteId', 'sourceUrl', 'remoteSongKeys', 'lastImportedAt'], strict)
			if (!['QQ', 'Netease'].includes(String(binding.platform))) invalid()
			const remoteId = identifier(binding.remoteId)
			if (!/^\d+$/.test(remoteId)) invalid()
			result.remoteBinding = { platform: binding.platform as 'QQ' | 'Netease', remoteId,
				sourceUrl: binding.sourceUrl === remoteId ? remoteId : http(binding.sourceUrl, strict) || remoteId, lastImportedAt: 0 }
			// Snapshot keys retain platform identity and deletion semantics, never infer QQ IDs.
			if (binding.remoteSongKeys !== undefined) result.remoteBinding.remoteSongKeys =
				array(binding.remoteSongKeys, CONFIG_BACKUP_LIMITS.tracks).map(identifier)
		}
		return result
	})
	const sources = array(raw.sources, CONFIG_BACKUP_LIMITS.sources).map(value => {
		const item = object(value)
		keys(item, ['id', 'name', 'author', 'version', 'script', 'scriptType', 'srcUrl', 'importUrl'], strict)
		if (item.scriptType !== undefined && !['cymusic', 'lxmusic'].includes(String(item.scriptType))) invalid()
		const script = text(item.script, CONFIG_BACKUP_LIMITS.script)
		if (!script.trim() || utf8Bytes(script) > CONFIG_BACKUP_LIMITS.script) invalid()
		return { id: identifier(item.id), name: text(item.name), author: text(item.author), version: text(item.version),
			script, scriptType: item.scriptType as 'cymusic' | 'lxmusic' | undefined,
			srcUrl: http(item.srcUrl, strict), importUrl: http(item.importUrl, strict),
			enabled: false, isSelected: false, getMusicUrl: undefined }
	})
	for (const items of [playlists, sources]) if (new Set(items.map(item => item.id)).size !== items.length) invalid()
	return { schema: CONFIG_BACKUP_SCHEMA, version: 1, settings, localSettings, sources, playlists, favorites: tracks(raw.favorites) }
}

/** Strict inbound whitelist; nothing is evaluated, requested or written during preview. */
export function parseConfigBackup(json: string): ConfigBackup {
	if (typeof json !== 'string' || json.length > CONFIG_BACKUP_MAX_BYTES
		|| utf8Bytes(json) > CONFIG_BACKUP_MAX_BYTES) invalid()
	return normalize(JSON.parse(json), true)
}
function portable(backup: ConfigBackup) {
	return { ...backup, sources: backup.sources.map(source => ({ id: source.id, name: source.name,
		author: source.author, version: source.version, script: source.script, scriptType: source.scriptType,
		srcUrl: source.srcUrl, importUrl: source.importUrl })) }
}
export function serializeConfigBackup(): string {
	let stage: ConfigBackupExportStage = 'collect'
	try {
	if (Config.get() === null) throw new Error('Configuration is not initialized')
	const settings: Settings = {}
	for (const key of Object.keys(settingsRules) as SettingKey[]) {
		const value = PersistStatus.get(key)
		if (value !== null) settings[key] = value
	}
	const localSettings: ConfigBackup['localSettings'] = {}
	for (const key of Object.keys(localRules) as LocalKey[]) {
		const value = Config.get(key)
		if (value !== undefined && value !== null) localSettings[key] =
			key === 'setting.basic.maxDownload' && typeof value === 'string' ? Number(value) : value as string | number | boolean
	}
	const backup = normalize({ schema: CONFIG_BACKUP_SCHEMA, version: 1, settings, localSettings,
		sources: stores.musicApiStore.getValue() ?? PersistStatus.get('music.musicApi') ?? [],
		playlists: stores.playListsStore.getValue() ?? PersistStatus.get('music.playLists') ?? [],
		favorites: useLibraryStore.getState().favorites }, false)
	stage = 'validate'
	const json = JSON.stringify(portable(backup), null, 2)
	parseConfigBackup(json)
	return json
	} catch { throw exportFailure(stage) }
}
export function configBackupPreview(backup: ConfigBackup) {
	return { settings: Object.keys(backup.settings).length, localSettings: Object.keys(backup.localSettings).length, sources: backup.sources.length,
		playlists: backup.playlists.length, songs: backup.playlists.reduce((sum, list) => sum + list.songs.length, 0),
		favorites: backup.favorites.length }
}

/** Replace collections only after UI confirmation. Synchronize live stores, not just disk. */
export async function applyConfigBackup(input: ConfigBackup, busyMessage: string): Promise<void> {
	const backup = parseConfigBackup(JSON.stringify(portable(input)))
	assertSourceIdle(busyMessage)
	await withSourceRuntimeLock(async () => {
		assertSourceIdle(busyMessage)
		const oldConfig = Config.get()
		if (oldConfig === null) throw new Error('Configuration is not initialized')
		const nextConfig = JSON.parse(JSON.stringify(oldConfig))
		for (const [key, value] of Object.entries(backup.localSettings)) {
			const parts = key.split('.')
			let parent = nextConfig
			for (const part of parts.slice(0, -1)) parent = parent[part] ??= {}
			parent[parts[parts.length - 1]] = value
		}
		const entries: [Parameters<typeof PersistStatus.set>[0], any][] = [
			...Object.entries(backup.settings) as [SettingKey, string | number | boolean][],
			['music.musicApi', backup.sources], ['music.selectedMusicApi', undefined],
			['music.playLists', backup.playlists], ['music.favorites', backup.favorites],
		]
		const previous = entries.map(([key]) => [key, PersistStatus.get(key) ?? undefined] as const)
		try {
			await setStorage('local-config', nextConfig)
			await Config.setup() // Refresh in-memory Config before any later Config.set can overwrite the import.
			for (const [key, value] of entries) PersistStatus.set(key, value)
		} catch (error) {
			await setStorage('local-config', oldConfig)
			await Config.setup()
			for (const [key, value] of previous) PersistStatus.set(key, value)
			throw error
		}
		stores.musicApiSelectedStore.setValue(null)
		releaseResolverRuntime()
		stores.musicApiStore.setValue(backup.sources)
		stores.playListsStore.setValue(backup.playlists)
		useLibraryStore.setState({ favorites: backup.favorites })
		const prefs = backup.settings
		const bindings = {
			'music.quality': stores.qualityStore, 'music.autoCacheLocal': stores.autoCacheLocalStore,
			'music.preloadNextTrack': stores.preloadNextTrackStore,
			'music.isCachedIconVisible': stores.isCachedIconVisibleStore,
			'music.songsNumsToLoad': stores.songsNumsToLoadStore,
		}
		for (const key of Object.keys(bindings) as (keyof typeof bindings)[])
			if (prefs[key] !== undefined) (bindings[key].setValue as (value: unknown) => void)(prefs[key])
		if (prefs['app.language'] !== undefined) changeLanguage(prefs['app.language'] as string)
		if (prefs['app.themeMode'] !== undefined) setThemeMode(prefs['app.themeMode'] as 'system' | 'light' | 'dark')
	})
}

export async function pickConfigBackup(): Promise<ConfigBackup | null> {
	const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain'],
		copyToCacheDirectory: true, multiple: false })
	if (result.canceled) return null
	const asset = result.assets[0]
	if (!asset || asset.size !== undefined && (!Number.isSafeInteger(asset.size)
		|| asset.size < 0 || asset.size > CONFIG_BACKUP_MAX_BYTES)) invalid()
	const info = await FileSystem.getInfoAsync(asset.uri)
	if (!info.exists || info.isDirectory || !Number.isSafeInteger(info.size)
		|| info.size < 0 || info.size > CONFIG_BACKUP_MAX_BYTES) invalid()
	return parseConfigBackup(await FileSystem.readAsStringAsync(asset.uri))
}
export async function shareConfigBackup(): Promise<boolean> {
	if (Platform.OS !== 'ios') throw new Error(CONFIG_BACKUP_EXPORT_UNSUPPORTED)
	if (!FileSystem.cacheDirectory) throw exportFailure('cache')
	const uri = `${FileSystem.cacheDirectory}cymusic-config-${Date.now()}.json`
	const json = serializeConfigBackup()
	let stage: ConfigBackupExportStage = 'write'
	let failure: Error | undefined
	let completed = false
	try {
		await FileSystem.writeAsStringAsync(uri, json)
		stage = 'share'
		// RN loads this local file as a share attachment, not as JSON text. Keep the
		// session file until either native completion callback (including cancel).
		completed = await new Promise<boolean>((resolve, reject) => {
			ActionSheetIOS.showShareActionSheetWithOptions({ url: uri, subject: 'CyMusic configuration backup' },
				reject, completed => resolve(completed))
		})
	} catch {
		failure = exportFailure(stage)
	} finally {
		try { await FileSystem.deleteAsync(uri, { idempotent: true }) }
		catch { failure ??= exportFailure('cleanup') }
	}
	if (failure) throw failure
	return completed
}
