import { fakeAudioMp3Uri } from '@/constants/images'
import { resolveLocalFile } from '@/helpers/localFile'
import { logError } from '@/helpers/logger'
import { showToast } from '@/utils/utils'
import { cacheIdentity, findCachedPath, getCacheFileUri, downloadToCache } from './CacheManager'
import {
	musicApiSelectedStore,
	musicApiStore,
	nowApiState,
	qualityStore,
	preloadNextTrackStore,
} from './PlayerStore'
import { sourceId, songKey, type CacheIdentity } from './sourceIdentity'
import { resolveQQMid } from './sourceResolver/qqMatch'
import {
	isLxSource,
	loadResolverSource,
	releaseResolverRuntime,
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
type ResolveSourceOptions = { requestType?: ResolveSourceRequestType; signal?: AbortSignal }

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
		(musicApiStore.getValue() || []).filter((api) => api.enabled !== false).map(sourceId),
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
): Promise<SourceResult> {
	const selected = musicApiSelectedStore.getValue()
	if (!selected) throw new Error('请先导入音源')
	const mid = await resolveQQMid(item, signal)
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
			for (const api of apis) {
				assertActive(signal)
				let loaded: IMusic.MusicApi
				try {
					if (isLxSource(api)) touchedRuntime = true
					loaded = await loadResolverSource(api)
				} catch {
					continue
				}
				for (const quality of qualities.slice(Math.max(0, qualities.indexOf(requestedQuality)))) {
					assertActive(signal)
					const identity = { sourceId: sourceId(api), quality }
					const cached = await findCachedPath(item, identity)
					assertActive(signal)
					if (cached) return { url: cached, wasCached: true, cacheIdentity: identity }
					try {
						const result = await loaded.getMusicUrl(item.title, item.artist, mid, quality, {
							requestKey: `${requestType}_${Date.now()}_${Math.random()}`,
							requestType,
							timeoutMs: requestType === 'current' ? 5000 : 12000,
							signal,
						})
						assertActive(signal)
						const source = typeof result === 'string' ? { url: result } : result
						if (source && /^https?:\/\/\S+$/i.test(source.url))
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
			throw new Error('无法获取可播放音源')
		} finally {
			// Fallback closures belong to a runtime. Restore the selected closure before unlocking.
			if (touchedRuntime) {
				const latest = musicApiSelectedStore.getValue()
				if (latest && isLxSource(latest)) {
					const restored = await loadResolverSource(latest)
					if (musicApiSelectedStore.getValue() === latest) musicApiSelectedStore.setValue(restored)
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
		assertActive(controller.signal)
		const local = await resolveLocalFile(item.url)
		assertActive(controller.signal)
		if (local.status === 'resolved')
			return {
				url: local.fileUri,
				wasCached: false,
				headers: item.headers,
				userAgent: item.userAgent,
			}
		if (local.status !== 'nonlocal') throw new Error('本地文件不存在，请重新缓存或导入')
		const identity = cacheIdentity(item)
		const cached = await findCachedPath(item, identity)
		assertActive(controller.signal)
		if (cached)
			return {
				url: cached,
				wasCached: true,
				cacheIdentity: identity,
				headers: item.headers,
				userAgent: item.userAgent,
			}
		if (item.url && item.url !== 'Unknown' && !item.url.includes('fake'))
			return {
				url: item.url,
				wasCached: false,
				headers: item.headers,
				userAgent: item.userAgent,
				cacheIdentity: identity,
			}
		const result = await Promise.race([
			resolveUncached(item, requestType, controller.signal),
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
		if (isCurrent && (!controller.signal.aborted || timedOut)) {
			nowApiState.setValue('异常')
			logError('获取音源失败', error)
			showToast('获取音源失败', error instanceof Error ? error.message : String(error), 'error')
		}
		return { url: fakeAudioMp3Uri, wasCached: false }
	} finally {
		if (timer) clearTimeout(timer)
		options.signal?.removeEventListener('abort', abort)
		if (isCurrent) currentRequests--
	}
}
