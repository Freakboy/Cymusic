import { logInfo } from '@/helpers/logger'
import { importedLocalMusicStore, musicApiSelectedStore, qualityStore } from './PlayerStore'
import PersistStatus from '@/store/PersistStatus'
import * as FileSystem from 'expo-file-system/legacy'
import { fileUriFromPath } from '@/helpers/localFile'
import FileSystemNative from '../../modules/cymusic-native'
import { sourceId, songKey, type CacheIdentity } from './sourceIdentity'
import { invalidatePlaybackPreparation } from './preparationInvalidation'
import SHA256 from 'crypto-js/sha256'

const cacheDir = FileSystem.documentDirectory + 'musicCache/'
const cacheDirectoryPath = `${FileSystemNative.documentDirectoryPath}/musicCache`
const discovered = new Map<string, string>()
const rejectedFiles = new Set<string>()
const rejectedDownloads = new Map<string, number>()

function isRejectedFile(url: string) {
	if (rejectedFiles.has(url)) return true
	const expires = rejectedDownloads.get(url)
	if (expires === undefined) return false
	rejectedDownloads.delete(url)
	if (expires <= Date.now()) return false
	rejectedDownloads.set(url, expires)
	return true
}

/** Quarantine only a confirmed native failure; nonempty() is not codec validation. */
export function rejectCacheFile(url: string, item?: IMusic.IMusicItem) {
	if (/^https?:\/\//i.test(url) && item) {
		const identity = cacheIdentity(item)
		downloads.get(keyFor(item, identity))?.controller.abort()
		const path = getCacheFileUri(getLocalFilePath(item, identity))
		rejectedDownloads.delete(path)
		rejectedDownloads.set(path, Date.now() + 60000)
		if (rejectedDownloads.size > 128) rejectedDownloads.delete(rejectedDownloads.keys().next().value!)
	}
	if (url.startsWith(fileUriFromPath(cacheDirectoryPath) + '/') || url.startsWith(cacheDir)) {
		rejectedFiles.add(url)
		invalidatePlaybackPreparation()
	}
}

export async function isUsableCacheFile(url: string): Promise<boolean> {
	if (!url.startsWith(fileUriFromPath(cacheDirectoryPath) + '/')) return true
	if (isRejectedFile(url)) return false
	const info = await FileSystem.getInfoAsync(url)
	return info.exists && !info.isDirectory && info.size > 0
}
const downloads = new Map<
	string,
	{ promise: Promise<string>; controller: AbortController; users: Set<symbol> }
>()
let cacheGeneration = 0
let clearing: Promise<void> | null = null
let nextTemporary = 0

export function cacheIdentity(item?: IMusic.IMusicItem): CacheIdentity {
	return {
		sourceId: item?.cacheSourceId ?? sourceId(musicApiSelectedStore.getValue()),
		quality: item?.cacheQuality ?? qualityStore.getValue(),
	}
}

export const ensureDirExists = async (dirPath: string) => {
	if (!(await FileSystem.getInfoAsync(dirPath)).exists) {
		await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true })
	}
}
export const ensureCacheDirExists = () => ensureDirExists(cacheDir)
const sanitizeFilename = (str: string) => str.replace(/[/\\?%*:|"<>]/g, '-')
const keyFor = (item: IMusic.IMusicItem, identity: CacheIdentity) =>
	JSON.stringify([songKey(item), identity.sourceId, identity.quality])

export const getLocalFilePath = (
	item: IMusic.IMusicItem,
	identity = cacheIdentity(item),
): string => {
	const key = keyFor(item, identity)
	return (
		discovered.get(key) ??
		`${cacheDir}v2-${SHA256(key).toString()}.${identity.quality === 'flac' ? 'flac' : 'mp3'}`
	)
}

// Keep raw-path return values compatible with persisted imported-local records.
export const getCacheFileUri = (path: string): string =>
	fileUriFromPath(`${cacheDirectoryPath}/${path.slice(cacheDir.length)}`)

async function nonempty(path: string) {
	if (isRejectedFile(path) || isRejectedFile(getCacheFileUri(path))) return false
	const info = await FileSystem.getInfoAsync(getCacheFileUri(path))
	return info.exists && !info.isDirectory && info.size > 0
}

export async function findCachedPath(
	item: IMusic.IMusicItem,
	identity = cacheIdentity(item),
): Promise<string | undefined> {
	if (clearing) await clearing
	const generation = cacheGeneration
	const key = keyFor(item, identity)
	const format = identity.quality === 'flac' ? 'flac' : 'mp3'
	const legacyName =
		item.platform && item.id
			? `${item.platform}_${item.id}`
			: `${sanitizeFilename(item.title)}-${sanitizeFilename(item.artist)}`
	// Legacy files have no resolver platform. Never reuse one for a cross-platform fallback.
	const paths = [getLocalFilePath(item, identity)]
	let resolutionPlatform = 'tx'
	try {
		resolutionPlatform = JSON.parse(identity.sourceId)[3] ?? 'tx'
	} catch {
		// Legacy cache identities predate the JSON platform field and refer to tx.
	}
	if (resolutionPlatform === 'tx') paths.push(`${cacheDir}${legacyName}.${format}`)
	for (const path of paths) {
		// Old filenames never escaped platform/id. Never let a legacy probe traverse directories.
		if (/[\\/]/.test(path.slice(cacheDir.length))) continue
		if (await nonempty(path)) {
			if (generation !== cacheGeneration) return undefined
			discovered.set(key, path)
			return path
		}
	}
	discovered.delete(key)
	return undefined
}

export const isCached = async (item: IMusic.IMusicItem, identity = cacheIdentity(item)) =>
	!!(await findCachedPath(item, identity))

export const downloadToCache = async (
	item: IMusic.IMusicItem,
	options: { identity?: CacheIdentity; signal?: AbortSignal } = {},
): Promise<string> => {
	if (clearing) await clearing
	const identity = options.identity ?? cacheIdentity(item)
	const key = keyFor(item, identity)
	const signal = options.signal
	if (signal?.aborted) throw new Error('CACHE_CANCELLED')
	let entry = downloads.get(key)
	if (!entry || entry.controller.signal.aborted) {
		const previous = entry
		const controller = new AbortController()
		const generation = cacheGeneration
		const users = new Set<symbol>()
		const promise = (async () => {
			// A cancelled writer may still be completing its rename/cleanup.
			if (previous) await previous.promise.catch(() => {})
			if (controller.signal.aborted || generation !== cacheGeneration)
				throw new Error('CACHE_CANCELLED')
			const cached = await findCachedPath(item, identity)
			if (controller.signal.aborted || generation !== cacheGeneration)
				throw new Error('CACHE_CANCELLED')
			if (cached) return cached
			if (!/^https?:\/\//i.test(item.url || '')) throw new Error('INVALID_CACHE_URL')
			await ensureCacheDirExists()
			const destination = getLocalFilePath(item, identity)
			const temporary = `${destination}.${++nextTemporary}.${Date.now()}.part`
			const headers = { ...item.headers }
			if (item.userAgent && !Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent'))
				headers['User-Agent'] = item.userAgent
			const task = FileSystem.createDownloadResumable(item.url!, getCacheFileUri(temporary), {
				headers,
				sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
			})
			const cancel = () => {
				void task.cancelAsync().catch(() => {})
			}
			controller.signal.addEventListener('abort', cancel, { once: true })
			try {
				if (controller.signal.aborted) throw new Error('CACHE_CANCELLED')
				const result = await task.downloadAsync()
				if (result?.status !== 200 || !(await nonempty(temporary)))
					throw new Error('EMPTY_OR_FAILED_CACHE_DOWNLOAD')
				if (controller.signal.aborted || generation !== cacheGeneration)
					throw new Error('CACHE_CANCELLED')
				// Same-directory rename exposes a complete nonempty download, not partial bytes.
				await FileSystem.moveAsync({
					from: getCacheFileUri(temporary),
					to: getCacheFileUri(destination),
				})
				rejectedFiles.delete(destination)
				rejectedFiles.delete(getCacheFileUri(destination))
				rejectedDownloads.delete(getCacheFileUri(destination))
				if (controller.signal.aborted || generation !== cacheGeneration) {
					await FileSystem.deleteAsync(getCacheFileUri(destination), { idempotent: true })
					throw new Error('CACHE_CANCELLED')
				}
				return destination
			} finally {
				controller.signal.removeEventListener('abort', cancel)
				await task.cancelAsync().catch(() => {})
				await FileSystem.deleteAsync(getCacheFileUri(temporary), { idempotent: true }).catch(
					() => {},
				)
			}
		})()
		entry = { promise, controller, users }
		downloads.set(key, entry)
		const ownEntry = entry
		void promise
			.finally(() => {
				if (downloads.get(key) === ownEntry) downloads.delete(key)
			})
			.catch(() => {})
	}
	const ownEntry = entry
	const user = Symbol(key)
	ownEntry.users.add(user)
	return new Promise<string>((resolve, reject) => {
		const release = () => {
			signal?.removeEventListener('abort', abort)
			ownEntry.users.delete(user)
			if (!ownEntry.users.size) ownEntry.controller.abort()
		}
		const abort = () => {
			release()
			reject(new Error('CACHE_CANCELLED'))
		}
		signal?.addEventListener('abort', abort, { once: true })
		if (signal?.aborted) {
			abort()
			return
		}
		ownEntry.promise.then(resolve, reject).finally(release)
	})
}

export const clearCache = (): Promise<void> => {
	if (clearing) return clearing
	cacheGeneration++
	invalidatePlaybackPreparation()
	discovered.clear()
	const pending = [...downloads.values()]
	for (const entry of pending) entry.controller.abort()
	clearing = (async () => {
		await Promise.allSettled(pending.map((entry) => entry.promise))
		await FileSystem.deleteAsync(cacheDir, { idempotent: true })
		const items = importedLocalMusicStore.getValue() || []
		const updated = items.filter((item) => {
			const url = item.url || ''
			return (
				!url.startsWith(cacheDir) &&
				!url.startsWith(fileUriFromPath(cacheDirectoryPath) + '/') &&
				!url.startsWith(cacheDirectoryPath + '/')
			)
		})
		importedLocalMusicStore.setValue(updated)
		PersistStatus.set('music.importedLocalMusic', updated)
		logInfo('缓存已清理')
	})().finally(() => {
		clearing = null
	})
	return clearing
}

export { cacheDir }
