import { fakeAudioMp3Uri } from '@/constants/images'
import { resolveLocalFile } from '@/helpers/localFile'
import { logError } from '@/helpers/logger'
import { showToast } from '@/utils/utils'
import { cacheIdentity, findCachedPath, getCacheFileUri, downloadToCache, rejectCacheFile, isUsableCacheFile } from './CacheManager'
import {
	musicApiSelectedStore,
	musicApiStore,
	nowApiState,
	qualityStore,
	preloadNextTrackStore,
} from './PlayerStore'
import { sourceId, songKey, type CacheIdentity } from './sourceIdentity'
import {
	RESOLUTION_PLATFORMS,
	resolvePlatformMusicInfo,
	supportsPlatform,
} from './sourceResolver/platforms'
import {
	isLxSource,
	loadResolverSource,
	releaseResolverRuntime,
	requestSourceUrl,
	withSourceRuntimeLock,
} from './sourceResolver/runtime'
import type { Track } from './types'
import { toMediaItem, type MediaItemPlaybackOptions } from './mediaItem'
import { onPreparationInvalidated } from './preparationInvalidation'

export { withSourceRuntimeLock } from './sourceResolver/runtime'
export type ResolveSourceRequestType = 'current' | 'preload'
export type SourceResult = {
	url: string
	wasCached: boolean
	headers?: Record<string, string>
	userAgent?: string
	cacheIdentity?: CacheIdentity
}
type ResolveSourceOptions = { requestType?: ResolveSourceRequestType; signal?: AbortSignal; fresh?: boolean }
const failures = new Map<string, Map<string, number>>()
const FAILURE_LIMIT = 128
const REJECTED_URL_LIMIT = 16
const REMOTE_REJECTION_TTL_MS = 60000

function getFailures(item: IMusic.IMusicItem) {
	const key = songKey(item)
	const rejected = failures.get(key)
	if (!rejected) return undefined
	const now = Date.now()
	for (const [url, expires] of rejected) if (expires <= now) rejected.delete(url)
	// Keep the bounded failure marker so later selection still resolves instead of reusing item.url.
	failures.delete(key)
	failures.set(key, rejected)
	return rejected
}

/** Only pass a URL for a confirmed playback failure, never for duration === 0. */
export function invalidateSource(item: IMusic.IMusicItem, rejectedUrl?: string) {
	const key = songKey(item)
	const rejected = getFailures(item) ?? new Map<string, number>()
	if (rejectedUrl) {
		rejected.delete(rejectedUrl)
		rejected.set(rejectedUrl, /^https?:\/\//i.test(rejectedUrl) ? Date.now() + REMOTE_REJECTION_TTL_MS : Infinity)
		if (rejected.size > REJECTED_URL_LIMIT) rejected.delete(rejected.keys().next().value!)
		rejectCacheFile(rejectedUrl, item)
	}
	failures.set(key, rejected)
	if (failures.size > FAILURE_LIMIT) failures.delete(failures.keys().next().value!)
	cancelPreparedNextTrack()
}

export type PreparedNextTrack = {
	generation: number
	key: string
	track: Track
	cacheIdentity: CacheIdentity
	mediaItem: ReturnType<typeof toMediaItem>
}
let generation = 0
let preparation: {
	controller: AbortController
	promise: Promise<PreparedNextTrack | null>
	key: string
} | null = null
let prepared: PreparedNextTrack | null = null
let currentRequests = 0
let currentStreamHasPriority = false
const isUnavailable = (item: IMusic.IMusicItem) => !!item.unavailable || String(item.id).startsWith('unavailable:')

/** Set while the current remote stream is loading/buffering; clear once output is stable. */
export function setCurrentStreamPriority(priority: boolean) {
	currentStreamHasPriority = priority
	if (priority) cancelPreparedNextTrack()
}

export function cancelPreparedNextTrack() {
	generation++
	preparation?.controller.abort()
	preparation = null
	prepared = null
}
onPreparationInvalidated(cancelPreparedNextTrack)

const preferenceKey = () =>
	JSON.stringify([
		sourceId(musicApiSelectedStore.getValue()),
		qualityStore.getValue(),
		(musicApiStore.getValue() || [])
			.filter((api) => api.enabled !== false)
			.map((api) => sourceId(api)),
	])
const preparationKey = (item: IMusic.IMusicItem) => JSON.stringify([songKey(item), preferenceKey()])

export function isPreparedNextTrackValid(value: PreparedNextTrack): boolean {
	return (
		prepared === value &&
		value.generation === generation &&
		value.key === preparationKey(value.track as IMusic.IMusicItem) &&
		preloadNextTrackStore.getValue()
	)
}

/** One slot only. The caller must wait for current output/buffering before starting. */
export function prepareNextTrack(
	item: IMusic.IMusicItem,
	token: string,
	playbackOptions?: MediaItemPlaybackOptions,
): Promise<PreparedNextTrack | null> {
	if (isUnavailable(item)) {
		cancelPreparedNextTrack()
		return Promise.resolve(null)
	}
	const key = JSON.stringify([
		preparationKey(item),
		token,
		playbackOptions?.preciseSeeking === true,
	])
	if (preparation?.key === key) return preparation.promise
	cancelPreparedNextTrack()
	if (currentRequests || currentStreamHasPriority || !preloadNextTrackStore.getValue())
		return Promise.resolve(null)
	const ownGeneration = generation
	const controller = new AbortController()
	const preferences = preferenceKey()
	const valid = () =>
		!controller.signal.aborted &&
		generation === ownGeneration &&
		preferences === preferenceKey() &&
		preloadNextTrackStore.getValue()
	const promise = (async () => {
		try {
			const source = await resolveSource(item, {
				requestType: 'preload',
				signal: controller.signal,
			})
			if (!valid() || source.url === fakeAudioMp3Uri) return null
			// A downloaded manifest is not a self-contained local audio track.
			if (
				item.isLiveStream ||
				/\.(m3u8|mpd)(?:[?#]|$)/i.test(source.url) ||
				/mpegurl|dash\+xml/i.test(item.contentType || '')
			)
				return null
			const identity = source.cacheIdentity ?? cacheIdentity(item)
			let url = source.url
			if (source.wasCached) url = getCacheFileUri(url)
			else if (/^https?:\/\//i.test(url)) {
				const path = await downloadToCache(
					{ ...item, ...source },
					{ identity, signal: controller.signal },
				)
				url = getCacheFileUri(path)
			}
			if (!valid() || !url.startsWith('file://')) return null
			const track: Track = {
				...item,
				url,
				headers: source.headers,
				userAgent: source.userAgent,
				cacheSourceId: identity.sourceId,
				cacheQuality: identity.quality,
			}
			const value: PreparedNextTrack = {
				generation: ownGeneration,
				key: preparationKey(item),
				track,
				cacheIdentity: identity,
				mediaItem: toMediaItem(track, token, false, {
					...playbackOptions,
					preparedGeneration: ownGeneration,
				}),
			}
			prepared = value
			return value
		} catch {
			return null
		}
	})()
	preparation = { controller, promise, key }
	void promise.then((value) => {
		if (!value && preparation?.promise === promise) preparation = null
	})
	return promise
}

// Compatibility for existing callers; preparation includes a complete disk download.
export const preloadTrack = (item: IMusic.IMusicItem) => prepareNextTrack(item, 'preload')
export const preloadSource = preloadTrack
export const getPreloadedUrl = (item: IMusic.IMusicItem) =>
	prepared &&
	isPreparedNextTrackValid(prepared) &&
	songKey(prepared.track as IMusic.IMusicItem) === songKey(item)
		? prepared.track.url
		: undefined

function assertActive(signal: AbortSignal) {
	if (signal.aborted) throw new Error('SOURCE_CANCELLED')
}

async function resolveUncached(
	item: IMusic.IMusicItem,
	requestType: ResolveSourceRequestType,
	signal: AbortSignal,
	fresh: boolean,
	explicitRetry: boolean,
): Promise<SourceResult> {
	const selected = musicApiSelectedStore.getValue()
	if (!selected) throw new Error('请先导入音源')
	assertActive(signal)
	return withSourceRuntimeLock(async () => {
		assertActive(signal)
		const apis = [
			selected,
			...(musicApiStore.getValue() || []).filter((api) => api.id !== selected.id),
		].filter((api) => api.enabled !== false)
		const qualities: IMusic.IQualityKey[] = ['flac', '320k', '128k']
		const requestedQuality = qualityStore.getValue()
		let touchedRuntime = false
		try {
			for (const platform of RESOLUTION_PLATFORMS) {
				const candidates: { api: IMusic.MusicApi; loaded: IMusic.MusicApi; qualities: IMusic.IQualityKey[] }[] = []
				// Check every source's quality fallback before this platform needs the network.
				for (const api of apis) {
					assertActive(signal)
					let loaded: IMusic.MusicApi
					try {
						if (isLxSource(api)) touchedRuntime = true
						loaded = await loadResolverSource(api)
					} catch {
						continue
					}
					if (!supportsPlatform(loaded, platform)) continue
					const capability = loaded.sources?.[platform]
					const allowedQualities = qualities.slice(Math.max(0, qualities.indexOf(requestedQuality))).filter(quality => !capability || !capability.qualitys || capability.qualitys.includes(quality))
					for (const quality of allowedQualities) {
						assertActive(signal)
						const identity = { sourceId: sourceId(api, platform), quality }
						const cached = await findCachedPath(item, identity)
						assertActive(signal)
						if (cached) return { url: cached, wasCached: true, cacheIdentity: identity }
					}
					if (allowedQualities.length) candidates.push({ api, loaded, qualities: allowedQualities })
				}
				if (!candidates.length) continue
				let musicInfo: Awaited<ReturnType<typeof resolvePlatformMusicInfo>>
				try {
					musicInfo = await resolvePlatformMusicInfo(item, platform, signal, fresh)
				} catch (error) {
					if (signal.aborted) throw error
					continue
				}
				for (const { api, loaded: candidate, qualities: allowedQualities } of candidates) {
					assertActive(signal)
					let loaded = candidate
					// The cache pass may have replaced the native singleton with another source.
					if (isLxSource(api)) {
						try {
							loaded = await loadResolverSource(api)
						} catch {
							continue
						}
					}
					for (const quality of allowedQualities) {
						const identity = { sourceId: sourceId(api, platform), quality }
						try {
							const result = await requestSourceUrl(
								loaded,
								item.title,
								item.artist,
								platform === 'tx' ? String(musicInfo.songmid) : '',
								quality,
								{
									platform,
									musicInfo,
									requestKey: `${requestType}_${Date.now()}_${Math.random()}`,
									requestType,
									timeoutMs: requestType === 'current' ? 5000 : 12000,
									signal,
								},
							)
							assertActive(signal)
							const source = typeof result === 'string' ? { url: result } : result
							// Explicit retry may retry a stable provider URL; local quarantine stays intact.
							if (source && /^https?:\/\/\S+$/i.test(source.url) &&
								(explicitRetry || !getFailures(item)?.has(source.url)))
								return {
									url: source.url,
									headers: source.headers,
									userAgent: source.userAgent,
									wasCached: false,
									cacheIdentity: identity,
								}
						} catch (error) {
							if (signal.aborted) throw error
						}
					}
				}
			}
			throw new Error('无法获取可播放音源')
		} finally {
			// Fallback closures belong to a runtime. Restore the selected closure before unlocking.
			if (touchedRuntime) {
				const latest = musicApiSelectedStore.getValue()
				if (latest && isLxSource(latest)) {
					try {
						const restored = await loadResolverSource(latest)
						if (musicApiSelectedStore.getValue() === latest)
							musicApiSelectedStore.setValue(restored)
					} catch {
						releaseResolverRuntime()
					}
				} else releaseResolverRuntime()
			}
		}
	}, requestType)
}

export async function resolveSource(
	item: IMusic.IMusicItem,
	options: ResolveSourceOptions = {},
): Promise<SourceResult> {
	const requestType = options.requestType ?? 'current'
	const isCurrent = requestType === 'current'
	const previousFailures = getFailures(item)
	const fresh = options.fresh === true || previousFailures !== undefined
	const rejected = (url?: string) => !!url && getFailures(item)?.has(url) === true
	if (isCurrent) {
		currentRequests++
		cancelPreparedNextTrack()
	}
	const controller = new AbortController()
	const abort = () => controller.abort()
	options.signal?.addEventListener('abort', abort, { once: true })
	if (options.signal?.aborted) abort()
	let timer: ReturnType<typeof setTimeout> | undefined
	let timedOut = false
	try {
		const result = await Promise.race([
			(async () => {
				assertActive(controller.signal)
				if (isUnavailable(item)) {
					if (isCurrent) showToast('歌曲不可用', '该歌曲暂不可播放', 'error')
					throw new Error('歌曲不可用')
				}
				const local = await resolveLocalFile(rejected(item.url) || item.url === fakeAudioMp3Uri ? undefined : item.url)
				assertActive(controller.signal)
				if (local.status === 'resolved' && await isUsableCacheFile(local.fileUri)) {
					assertActive(controller.signal)
					return {
						url: local.fileUri,
						wasCached: false,
						headers: item.headers,
						userAgent: item.userAgent,
					}
				}
				if (local.status === 'unresolved') throw new Error('本地文件不存在，请重新缓存或导入')
				if (local.status === 'resolved') item = { ...item, url: undefined }
				if (fresh) item = { ...item, url: undefined, headers: undefined, userAgent: undefined,
					cacheSourceId: undefined, cacheQuality: undefined }
				const identity = cacheIdentity(item)
				const cached = await findCachedPath(item, identity)
				assertActive(controller.signal)
				if (cached && !rejected(getCacheFileUri(cached)))
					return {
						url: cached,
						wasCached: true,
						cacheIdentity: identity,
						headers: item.headers,
						userAgent: item.userAgent,
					}
				if (!fresh && item.url && item.url !== 'Unknown' && item.url !== fakeAudioMp3Uri && !item.url.includes('fake'))
					return {
						url: item.url,
						wasCached: false,
						headers: item.headers,
						userAgent: item.userAgent,
						cacheIdentity: item.cacheSourceId && item.cacheQuality ? { sourceId: item.cacheSourceId, quality: item.cacheQuality } : undefined,
					}
				return resolveUncached(item, requestType, controller.signal, fresh, options.fresh === true)
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => {
						timedOut = true
						reject(new Error('音源请求超时'))
						controller.abort()
					},
					isCurrent ? 30000 : 45000,
				)
			}),
			new Promise<never>((_, reject) => {
				controller.signal.addEventListener('abort', () => reject(new Error('SOURCE_CANCELLED')), {
					once: true,
				})
			}),
		])
		assertActive(controller.signal)
		if (isCurrent) nowApiState.setValue('正常')
		return result
	} catch (error) {
		if (!controller.signal.aborted || timedOut) invalidateSource(item)
		if (isCurrent && !isUnavailable(item) && (!controller.signal.aborted || timedOut)) {
			nowApiState.setValue('异常')
			logError('获取音源失败', error)
			showToast('获取音源失败', error instanceof Error ? error.message : String(error), 'error')
		}
		throw error
	} finally {
		if (timer) clearTimeout(timer)
		options.signal?.removeEventListener('abort', abort)
		if (isCurrent) currentRequests--
	}
}
