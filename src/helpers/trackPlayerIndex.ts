import { sortIndexSymbol, timeStampSymbol } from '@/constants/commonConst'
import { SoundAsset } from '@/constants/constant'
import Config from '@/store/config'
import delay from '@/utils/delay'
import { isSameMediaItem, mergeProps, sortByTimestampAndIndex } from '@/utils/mediaItem'
import * as FileSystem from 'expo-file-system/legacy'
import { produce } from 'immer'
import shuffle from 'lodash.shuffle'
import FileSystemNative from '../../modules/cymusic-native'
import ReactNativeTrackPlayer, {
	Event,
	PlaybackState,
	type MediaItem,
	type PlaybackProgressUpdatedEvent,
	usePlaybackState,
	useProgress,
} from '@rntp/player'
import type { Track } from '@/player/types'
import { getNativeTrackIdentity, toMediaItem } from '@/player/mediaItem'
import { neteaseArtworkKey, usableArtwork } from '@/utils/imageUtils'

import { MusicRepeatMode } from '@/helpers/types'
import PersistStatus from '@/store/PersistStatus'
import {
	getMusicIndex,
	getPlayList,
	getPlayListMusicAt,
	isInPlayList,
	isPlayListEmpty,
	setPlayList,
	usePlayList,
} from '@/store/playList'
import { createMediaIndexMap } from '@/utils/mediaIndexMap'
import { Alert, AppState, Image } from 'react-native'

import { myGetLyric } from '@/helpers/userApi/getMusicSource'
import { fetchSourceLyric, mergeSourceLyric, normalizeSourceLyric } from './sourceLyric'
import type { SourceLyric } from './sourceLyric'
import type { SourceMusicApi } from './userApi/importMusicSource'
import { resolveQQMid } from '@/player/sourceResolver/qqMatch'
import { sourceId } from '@/player/sourceIdentity'

import { fakeAudioMp3Uri } from '@/constants/images'
import { nowLanguage } from '@/utils/i18n'
import { showToast } from '@/utils/utils'
import { resolveLocalFile } from './localFile'
import { logError, logInfo } from './logger'
import { disposeLxMusicScript, isLxMusicScript, reloadLxMusicScript } from './userApi/lxMusicSourceAdapter'

import {
	currentMusicStore,
	playListsStore,
	repeatModeStore,
	qualityStore,
	musicApiStore,
	musicApiSelectedStore,
	nowApiState,
	autoCacheLocalStore,
	preloadNextTrackStore,
	isCachedIconVisibleStore,
	songsNumsToLoadStore,
	importedLocalMusicStore,
	nowLyricState,
	nowTranslationLyricState,
	lyricsStatusStore,
	trackSkipLoadingStore,
	trackSourceLoadingStore,
	playbackIntentStore,
} from '@/player/PlayerStore'

import {
	isCached,
	downloadToCache,
	clearCache,
	getCacheFileUri,
	ensureDirExists,
} from '@/player/CacheManager'

import {
	resolveSource, prepareNextTrack, cancelPreparedNextTrack, isPreparedNextTrackValid,
	setCurrentStreamPriority, withSourceRuntimeLock, type PreparedNextTrack,
} from '@/player/MusicSourceResolver'
import { onPreparationInvalidated } from '@/player/preparationInvalidation'

const NEXT_TRACK_PRELOAD_DELAY_MS = 8000
const createTrackSourceLoadingToken = (musicItem: IMusic.IMusicItem) =>
	`track_source_${musicItem.id}_${Date.now().toString(36)}_${Math.random()
		.toString(36)
		.slice(2, 8)}`

export {
	playListsStore,
	repeatModeStore,
	qualityStore,
	musicApiStore,
	musicApiSelectedStore,
	nowApiState,
	autoCacheLocalStore,
	preloadNextTrackStore,
	isCachedIconVisibleStore,
	songsNumsToLoadStore,
	importedLocalMusicStore,
	nowLyricState,
	nowTranslationLyricState,
	lyricsStatusStore,
	trackSkipLoadingStore,
	trackSourceLoadingStore,
	playbackIntentStore,
}

export function useCurrentQuality() {
	const currentQuality = qualityStore.useValue()
	const setCurrentQuality = (newQuality: IMusic.IQualityKey) => {
		setQuality(newQuality)
	}
	return [currentQuality, setCurrentQuality] as const
}

let currentIndex = -1

let playerSubscriptions: { remove(): void }[] = []
let controlRevision = 0
let activeTrackSkip: symbol | null = null
let nativeQueue: {
	token: string
	track: Track
	startedAt: number
	handoffConsumed: boolean
} | null = null
let installedNext: { ownerToken: string; value: PreparedNextTrack } | null = null
let prepareTimer: ReturnType<typeof setTimeout> | null = null
let prepareRevision = 0
let sourceRevision = 0
let lyricsSequence = 0
let retryLyrics: (() => Promise<void>) | null = null

function retirePreparedSlot() {
	if (prepareTimer !== null) clearTimeout(prepareTimer)
	prepareTimer = null
	prepareRevision++
	const installed = installedNext
	installedNext = null
	cancelPreparedNextTrack()
	if (installed && nativeQueue?.token === installed.ownerToken &&
		isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem()) &&
		ReactNativeTrackPlayer.getQueue().length === 2) {
		try {
			ReactNativeTrackPlayer.replaceMediaItem(1, toMediaItem(getFakeNextTrack(), nativeQueue.token, true))
		} catch (error) {
			logError('恢复下一首占位失败', error)
		}
	}
}

function invalidatePreparedSlot() {
	if (!adoptPreparedTransition(ReactNativeTrackPlayer.getActiveMediaItem(), ReactNativeTrackPlayer.getActiveMediaItemIndex())) {
		retirePreparedSlot()
	}
}

function schedulePreparedSlot() {
	if (prepareTimer !== null || installedNext || !nativeQueue ||
		!preloadNextTrackStore.getValue() || playbackIntentStore.getValue() === 'stop' ||
		trackSourceLoadingStore.getValue() !== null ||
		!isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem()) ||
		ReactNativeTrackPlayer.getPlaybackState() !== PlaybackState.Ready) return
	const ownerToken = nativeQueue.token
	const revision = prepareRevision
	const next = getPlayListMusicAt(currentIndex + (repeatModeStore.getValue() === MusicRepeatMode.SINGLE ? 0 : 1))
	if (!next) return
	prepareTimer = setTimeout(async () => {
		if (revision !== prepareRevision || nativeQueue?.token !== ownerToken) return
		try {
			const value = await prepareNextTrack(next, createTrackSourceLoadingToken(next), {
				preciseSeeking: PersistStatus.get('music.preciseSeeking') === true,
			})
			const expected = getPlayListMusicAt(currentIndex + (repeatModeStore.getValue() === MusicRepeatMode.SINGLE ? 0 : 1))
			const queue = ReactNativeTrackPlayer.getQueue()
			const slot = getNativeTrackIdentity(queue[1])
			if (!value || revision !== prepareRevision || nativeQueue?.token !== ownerToken ||
				!isPreparedNextTrackValid(value) || !isSameMediaItem(expected, value.track as IMusic.IMusicItem) ||
				!preloadNextTrackStore.getValue() || playbackIntentStore.getValue() === 'stop' ||
				!isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem()) ||
				ReactNativeTrackPlayer.getActiveMediaItemIndex() !== 0 || queue.length !== 2 ||
				slot?.token !== ownerToken || !slot.placeholder) return
			installedNext = { ownerToken, value }
			ReactNativeTrackPlayer.replaceMediaItem(1, value.mediaItem)
		} catch (error) {
			if (revision === prepareRevision) retirePreparedSlot()
			logError('下一首准备失败', error)
		} finally {
			if (revision === prepareRevision) prepareTimer = null
		}
	}, NEXT_TRACK_PRELOAD_DELAY_MS)
}

function reconcileStreamPriority() {
	if (!isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem())) return
	const state = ReactNativeTrackPlayer.getPlaybackState()
	if (state === PlaybackState.Buffering) {
		setCurrentStreamPriority(true)
		retirePreparedSlot()
	} else if (state === PlaybackState.Ready && trackSourceLoadingStore.getValue() === null) {
		setCurrentStreamPriority(false)
		schedulePreparedSlot()
	}
}

function fetchCurrentLyrics(track: IMusic.IMusicItem, token: string) {
	const sequence = ++lyricsSequence
	retryLyrics = null
	let isCurrent = () => false
	// Playback clears its loading flag in finally after scheduling this request.
	return Promise.resolve().then(async () => {
		const source = musicApiSelectedStore.getValue() as SourceMusicApi | null
		const identity = sourceId(source)
		const revision = sourceRevision
		isCurrent = () => sequence === lyricsSequence && isCurrentMusic(track) && nativeQueue?.token === token &&
			trackSourceLoadingStore.getValue() === null && sourceRevision === revision &&
			sourceId(musicApiSelectedStore.getValue()) === identity
		if (!isCurrent()) return
		lyricsStatusStore.setValue({ status: 'loading', retryable: false })
		let sourceLyrics: SourceLyric | null = null
		if (source?.enabled !== false && typeof source?.getLyric === 'function') {
			try {
				const songmid = await resolveQQMid(track)
				if (!isCurrent()) return
				sourceLyrics = await fetchSourceLyric({ ...track, songmid }, isCurrent)
			} catch (error) {
				logError('获取音源歌词失败:', error)
			}
		}
		if (!isCurrent()) return
		if (sourceLyrics) {
			nowLyricState.setValue(sourceLyrics.lyric || null)
			if (!isCurrent()) return
			nowTranslationLyricState.setValue(sourceLyrics.tlyric || null)
			if (sourceLyrics.lyric) lyricsStatusStore.setValue({ status: 'available', retryable: false })
			if (sourceLyrics.lyric && sourceLyrics.tlyric) return
		}
		if (!isCurrent()) return
		let platformLyrics: SourceLyric | null = null
		let status: 'available' | 'instrumental' | 'unavailable' | 'error' = 'error'
		let retryable = true
		if (!sourceLyrics?.lyric || !sourceLyrics.tlyric) {
			try {
				const result = await myGetLyric(track)
				platformLyrics = normalizeSourceLyric(result)
				// Older QQ responses encode request failure as a display-only LRC line.
				if (platformLyrics && /^\[00:00(?:\.00)?\](?:暂无歌词|No lyrics available)\s*$/i.test(platformLyrics.lyric)) {
					platformLyrics = null
				}
				status = result && 'status' in result ? result.status : platformLyrics?.lyric ? 'available' : 'error'
				retryable = result && 'retryable' in result ? result.retryable === true : status === 'error'
				if (status !== 'available') platformLyrics = null
			} catch (error) {
				logError('获取平台歌词失败:', error)
			}
		}
		if (!isCurrent()) return
		const lyc = mergeSourceLyric(sourceLyrics, platformLyrics)
		nowLyricState.setValue(lyc?.lyric || null)
		if (!isCurrent()) return
		nowTranslationLyricState.setValue(lyc?.tlyric || null)
		if (!isCurrent()) return
		lyricsStatusStore.setValue({ status: lyc?.lyric ? 'available' : status, retryable: !lyc?.lyric && status === 'error' && retryable })
		if (!lyc?.lyric && status === 'error' && retryable) {
			retryLyrics = () => isCurrent() ? fetchCurrentLyrics(track, token) : Promise.resolve()
		}
	}).catch((error) => {
		logError('获取歌词失败:', error)
		if (!isCurrent()) return
		const available = !!nowLyricState.getValue()
		lyricsStatusStore.setValue({ status: available ? 'available' : 'error', retryable: !available })
		if (!available) retryLyrics = () => isCurrent() ? fetchCurrentLyrics(track, token) : Promise.resolve()
	})
}

function retryCurrentLyrics(): Promise<void> {
	const state = lyricsStatusStore.getValue()
	return state.status === 'error' && state.retryable && retryLyrics ? retryLyrics() : Promise.resolve()
}

function refetchCurrentLyricsIfOwned() {
	if (nativeQueue && trackSourceLoadingStore.getValue() === null &&
		isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem())) {
		void fetchCurrentLyrics(nativeQueue.track as IMusic.IMusicItem, nativeQueue.token)
	}
}

/** Validate against the current native queue, not a queued event's index alone. */
function isCurrentNativeItem(item: MediaItem | null | undefined, placeholder = false) {
	if (!nativeQueue || !isCurrentMusic(nativeQueue.track as IMusic.IMusicItem)) return false
	const identity = getNativeTrackIdentity(item)
	const active = ReactNativeTrackPlayer.getActiveMediaItem()
	const activeIdentity = getNativeTrackIdentity(active)
	return identity?.token === nativeQueue.token &&
		identity.placeholder === placeholder &&
		activeIdentity?.token === nativeQueue.token &&
		activeIdentity.placeholder === placeholder &&
		item?.mediaId === active?.mediaId &&
		ReactNativeTrackPlayer.getActiveMediaItemIndex() === (placeholder ? 1 : 0)
}

function isCurrentProgressEvent(event: PlaybackProgressUpdatedEvent) {
	const active = ReactNativeTrackPlayer.getActiveMediaItem()
	return isCurrentNativeItem(active) && event.mediaId === active?.mediaId &&
		Number.isFinite(event.timestamp) && event.timestamp >= nativeQueue.startedAt
}

const pendingConfirmedArtwork = new Map<string, string>()

/** Retain loading-track confirmations; return true only after native publication. */
export function updateCurrentArtwork(track: { id?: string | number; platform?: string }, uri: string): boolean {
	const key = neteaseArtworkKey(track)
	const artwork = usableArtwork(uri)
	const current = currentMusicStore.getValue()
	const owned = nativeQueue
	if (!key || !artwork || key !== neteaseArtworkKey(current)) return false
	if (trackSourceLoadingStore.getValue() !== null) {
		pendingConfirmedArtwork.delete(key)
		pendingConfirmedArtwork.set(key, artwork)
		if (pendingConfirmedArtwork.size > 128) pendingConfirmedArtwork.delete(pendingConfirmedArtwork.keys().next().value!)
		return false
	}
	if (key !== neteaseArtworkKey(owned?.track) ||
		!isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem())) return false
	try {
		if (ReactNativeTrackPlayer.getActiveMediaItem()?.artworkUrl !== artwork) {
			ReactNativeTrackPlayer.updateMetadata(0, { artworkUrl: artwork })
		}
		if (nativeQueue !== owned || currentMusicStore.getValue() !== current ||
			!isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem())) return false
		owned.track = { ...owned.track, artwork }
		if (current.artwork !== artwork) {
			const updated = { ...current, artwork }
			currentMusicStore.setValue(updated)
			PersistStatus.set('music.musicItem', updated)
		}
		pendingConfirmedArtwork.delete(key)
		return true
	} catch (error) {
		logError('Artwork metadata update failed', error)
		return false
	}
}

function setPlaybackIntent(intent: 'play' | 'pause' | 'stop') {
	controlRevision++
	playbackIntentStore.setValue(intent)
}

function retireTrackSkip() {
	activeTrackSkip = null
	trackSkipLoadingStore.setValue(null)
}

function adoptPreparedTransition(item: MediaItem | null | undefined, index: number | null): boolean {
	const slot = installedNext
	const value = slot?.value
	const identity = getNativeTrackIdentity(item)
	const active = ReactNativeTrackPlayer.getActiveMediaItem()
	const activeIdentity = getNativeTrackIdentity(active)
	const target = value && getNativeTrackIdentity(value.mediaItem)
	const expected = getPlayListMusicAt(currentIndex + (repeatModeStore.getValue() === MusicRepeatMode.SINGLE ? 0 : 1))
	if (value && target && index === 1 && ReactNativeTrackPlayer.getActiveMediaItemIndex() === 1 &&
		nativeQueue?.token === slot.ownerToken && playbackIntentStore.getValue() !== 'stop' &&
		// Once installed audio is active, preference/cache invalidation cannot undo
		// the native transition. Its installed token and generation remain authoritative.
		isSameMediaItem(expected, value.track as IMusic.IMusicItem) &&
		item?.mediaId === value.mediaItem.mediaId && active?.mediaId === value.mediaItem.mediaId &&
		identity?.token === target.token && activeIdentity?.token === target.token &&
		identity?.preparedGeneration === value.generation && activeIdentity?.preparedGeneration === value.generation &&
		!identity.placeholder && !activeIdentity.placeholder) {
		// Whitelist artwork only: the prepared source owns headers/cache identity.
		const latestArtwork = expected?.artwork !== value.track.artwork ? expected?.artwork
			: isSameMediaItem(expected, nativeQueue.track as IMusic.IMusicItem) ? nativeQueue.track.artwork : expected?.artwork
		const track = { ...value.track, artwork: latestArtwork || value.track.artwork } as IMusic.IMusicItem
		installedNext = null
		retirePreparedSlot()
		retireTrackSkip()
		trackSourceLoadingStore.setValue(null)
		nativeQueue = { token: target.token, track, startedAt: Date.now(), handoffConsumed: false }
		setCurrentMusic(track)
		PersistStatus.set('music.musicItem', track)
		ReactNativeTrackPlayer.removeMediaItem(0)
		ReactNativeTrackPlayer.addMediaItem(toMediaItem(getFakeNextTrack(), target.token, true))
		if (track.artwork) updateCurrentArtwork(track, track.artwork)
		PersistStatus.set('music.progress', ReactNativeTrackPlayer.getProgress().position)
		fetchCurrentLyrics(track, target.token)
		setCurrentStreamPriority(false)
		return true
	}
	return false
}

function handleNativeTransition(item: MediaItem | null | undefined, index: number | null) {
	if (adoptPreparedTransition(item, index)) {
		schedulePreparedSlot()
		return
	}
	// clear() can omit item entirely. A duplicate/stale placeholder must not advance.
	if (item == null || index !== 1 || !isCurrentNativeItem(item, true) ||
		nativeQueue.handoffConsumed || trackSourceLoadingStore.getValue() !== null ||
		playbackIntentStore.getValue() !== 'play') return
	nativeQueue.handoffConsumed = true
	logInfo('队列末尾，播放下一首')
	const advance = repeatModeStore.getValue() === MusicRepeatMode.SINGLE
		? play(null, true)
		: skipToNext()
	void advance.catch((error) => logError('自动切歌失败', error))
}

function observeNativeTransport(intent: 'play' | 'pause' | 'stop') {
	// Hybrid transport already ran natively. Only reconcile pending JS work here.
	setPlaybackIntent(intent)
	if (intent === 'stop') {
		retirePreparedSlot()
		setCurrentStreamPriority(false)
	}
	if (intent === 'play') {
		// Pause can arrive before a queued placeholder transition reaches JS. A
		// later native resume must complete that deferred business-queue handoff.
		handleNativeTransition(ReactNativeTrackPlayer.getActiveMediaItem(), ReactNativeTrackPlayer.getActiveMediaItemIndex())
		reconcileStreamPriority()
	}
}

function reset() {
	lyricsSequence++
	retryLyrics = null
	nowLyricState.setValue(null)
	nowTranslationLyricState.setValue(null)
	lyricsStatusStore.setValue({ status: 'idle', retryable: false })
	retirePreparedSlot()
	setCurrentStreamPriority(false)
	controlRevision++
	retireTrackSkip()
	playbackIntentStore.setValue('stop')
	trackSourceLoadingStore.setValue(null)
	nativeQueue = null
	ReactNativeTrackPlayer.clear()
}

const hotModule = module as typeof module & { hot?: { dispose(callback: () => void): void } }
hotModule.hot?.dispose(() => {
	reset()
	playerSubscriptions.forEach((subscription) => subscription.remove())
	playerSubscriptions = []
})

function migrate() {
	PersistStatus.set('music.rate', 1)
	PersistStatus.set('music.repeatMode', MusicRepeatMode.QUEUE)
	PersistStatus.set('music.progress', 0)
	Config.set('status.music', undefined)
}

async function setupTrackPlayer() {
	migrate()
	const rate = PersistStatus.get('music.rate')
	const musicQueue = PersistStatus.get('music.play-list')
	const legacyMusicQueue = PersistStatus.get('music.playList')
	const repeatMode = PersistStatus.get('music.repeatMode')
	const progress = PersistStatus.get('music.progress')
	const track = PersistStatus.get('music.musicItem')
	const quality = PersistStatus.get('music.quality') || '128k'
	const playLists = PersistStatus.get('music.playLists')
	const musicApiLists = PersistStatus.get('music.musicApi')
	const selectedMusicApi = PersistStatus.get('music.selectedMusicApi')
	const importedLocalMusic = PersistStatus.get('music.importedLocalMusic')
	const autoCacheLocal = PersistStatus.get('music.autoCacheLocal') ?? true
	const preloadNextTrack = PersistStatus.get('music.preloadNextTrack') ?? true
	const language = PersistStatus.get('app.language') ?? 'zh'
	const isCachedIconVisible = PersistStatus.get('music.isCachedIconVisible') ?? true
	const songsNumsToLoad = PersistStatus.get('music.songsNumsToLoad') ?? 100
	const restoredQueue = musicQueue ?? legacyMusicQueue

	if (!musicQueue && legacyMusicQueue) {
		PersistStatus.set('music.play-list', legacyMusicQueue)
		PersistStatus.set('music.playList', undefined)
	}
	// 状态恢复
	if (rate) {
		ReactNativeTrackPlayer.setPlaybackSpeed(+rate)
	}
	if (repeatMode) {
		repeatModeStore.setValue(repeatMode as MusicRepeatMode)
	}

	if (quality) {
		setQuality(quality as IMusic.IQualityKey)
	}
	if (playLists) {
		const resolvedPlayLists = await Promise.all(
			playLists.map(async (playList) => {
				const [artwork, coverImg] = await Promise.all([
					resolveLocalFile(playList.artwork),
					resolveLocalFile(playList.coverImg),
				])
				return {
					...playList,
					...(artwork.status === 'resolved' ? { artwork: artwork.fileUri } : {}),
					...(coverImg.status === 'resolved' ? { coverImg: coverImg.fileUri } : {}),
				}
			}),
		)
		// Project cover addresses for display only; preserve stored IDs, songs and URLs.
		playListsStore.setValue(resolvedPlayLists)
	}
	if (musicApiLists) {
		musicApiStore.setValue(musicApiLists)
	}
	const restoredApi = musicApiLists?.find((api) => api.id === selectedMusicApi?.id)
	const restoredApis = (musicApiLists || []).map((api) => ({ ...api, isSelected: api.id === restoredApi?.id }))
	musicApiStore.setValue(restoredApis)
	PersistStatus.set('music.musicApi', restoredApis)
	if (restoredApi) {
		musicApiSelectedStore.setValue({ ...restoredApi, isSelected: true })
		await reloadNowSelectedMusicApi()
	} else {
		musicApiSelectedStore.setValue(null)
		PersistStatus.set('music.selectedMusicApi', undefined)
	}
	if (importedLocalMusic) {
		importedLocalMusicStore.setValue(importedLocalMusic)
	}
	if (restoredQueue && Array.isArray(restoredQueue)) {
		addAll(restoredQueue, undefined, repeatMode === MusicRepeatMode.SHUFFLE)
	}
	if (autoCacheLocal == true || autoCacheLocal == false) {
		autoCacheLocalStore.setValue(autoCacheLocal)
	}
	preloadNextTrackStore.setValue(preloadNextTrack)
	if (isCachedIconVisible == true || isCachedIconVisible == false) {
		isCachedIconVisibleStore.setValue(isCachedIconVisible)
	}
	if (language) {
		nowLanguage.setValue(language)
	}
	if (songsNumsToLoad) {
		songsNumsToLoadStore.setValue(songsNumsToLoad)
	}
	if (playerSubscriptions.length === 0) {
		playerSubscriptions.push(
			{ remove: onPreparationInvalidated(invalidatePreparedSlot) },
			ReactNativeTrackPlayer.addEventListener(Event.PlaybackStateChanged, reconcileStreamPriority),
			ReactNativeTrackPlayer.addEventListener(Event.IsPlayingChanged, reconcileStreamPriority),
			ReactNativeTrackPlayer.addEventListener(Event.RemoteSeek, retirePreparedSlot),
			ReactNativeTrackPlayer.addEventListener(Event.MediaItemTransition, (event) => {
				handleNativeTransition(event.item, event.index)
			}),
			ReactNativeTrackPlayer.addEventListener(Event.PlaybackError, (error) => {
				if (!error.message || trackSourceLoadingStore.getValue() !== null ||
					ReactNativeTrackPlayer.getPlaybackState() !== PlaybackState.Error ||
					!isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem())) return
				logInfo('播放出错', { message: error.message, code: error.code })
				void failToPlay().catch((failure) => logError('播放错误恢复失败', failure))
			}),
		)
		logInfo('播放器初始化完成')
	}
}

/**
 * 获取自动播放的下一个track，保持nextTrack 不变,生成nextTrack的with fake url 形式  假音频
 * 获取下一个 track 并设置其属性为假音频。这在测试或处理特殊情况时非常有用
 */
const getFakeNextTrack = (): Track => {
	const repeatMode = repeatModeStore.getValue()
	const track = getPlayListMusicAt(currentIndex + (repeatMode === MusicRepeatMode.SINGLE ? 0 : 1))
	return {
		id: track?.id ?? 'empty',
		platform: track?.platform,
		title: track?.title,
		artist: track?.artist,
		album: track?.album,
		artwork: track?.artwork,
		url: Image.resolveAssetSource(SoundAsset.fakeAudio).uri,
	}
}

/** 播放失败时的情况 */
async function failToPlay() {
	retirePreparedSlot()
	setCurrentStreamPriority(false)
	const revision = controlRevision
	const failedMusic = currentMusicStore.getValue()
	const sourceToken = trackSourceLoadingStore.getValue()
	retireTrackSkip()
	if (isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem())) {
		// Keep the failed item/headers so a native Play during the delay can reload
		// it immediately. That explicit intent also invalidates the delayed Next.
		ReactNativeTrackPlayer.stop()
	} else {
		nativeQueue = null
		ReactNativeTrackPlayer.clear()
	}
	await delay(500)
	if (revision !== controlRevision || !isCurrentMusic(failedMusic) ||
		sourceToken !== trackSourceLoadingStore.getValue() ||
		playbackIntentStore.getValue() !== 'play') return
	await skipToNext()
}

// 播放模式相关
const _toggleRepeatMapping = {
	[MusicRepeatMode.SHUFFLE]: MusicRepeatMode.SINGLE,
	[MusicRepeatMode.SINGLE]: MusicRepeatMode.QUEUE,
	[MusicRepeatMode.QUEUE]: MusicRepeatMode.SHUFFLE,
}
/** 切换下一个模式 */
const toggleRepeatMode = () => {
	setRepeatMode(_toggleRepeatMapping[repeatModeStore.getValue()])
}

/**
 * 添加到播放列表
 * @param musicItems 目标歌曲
 * @param beforeIndex 在第x首歌曲前添加
 * @param shouldShuffle 随机排序
 */
const addAll = (
	musicItems: Array<IMusic.IMusicItem> = [],
	beforeIndex?: number,
	shouldShuffle?: boolean,
) => {
	retirePreparedSlot()
	const now = Date.now()
	let newPlayList: IMusic.IMusicItem[] = []
	const currentPlayList = getPlayList()
	const _musicItems = musicItems.map((item, index) => ({
		...item,
		[timeStampSymbol]: now,
		[sortIndexSymbol]: index,
	}))
	if (beforeIndex === undefined || beforeIndex < 0) {
		newPlayList = currentPlayList.concat(_musicItems.filter((item) => !isInPlayList(item)))
	} else {
		const indexMap = createMediaIndexMap(_musicItems)
		const beforeDraft = currentPlayList.slice(0, beforeIndex).filter((item) => !indexMap.has(item))
		const afterDraft = currentPlayList.slice(beforeIndex).filter((item) => !indexMap.has(item))

		newPlayList = [...beforeDraft, ..._musicItems, ...afterDraft]
	}

	if (shouldShuffle) {
		newPlayList = shuffle(newPlayList)
	}
	setPlayList(newPlayList)
	const currentMusicItem = currentMusicStore.getValue()

	if (currentMusicItem) {
		currentIndex = getMusicIndex(currentMusicItem)
	}
	updateNextMetadata()
}

/** 追加到队尾 */
const add = (musicItem: IMusic.IMusicItem | IMusic.IMusicItem[], beforeIndex?: number) => {
	addAll(Array.isArray(musicItem) ? musicItem : [musicItem], beforeIndex)
}

/**
 * 下一首播放
 * @param musicItem
 */
const addAsNextTrack = (musicItem: IMusic.IMusicItem | IMusic.IMusicItem[]) => {
	const shouldPlay = isPlayListEmpty()
	add(musicItem, currentIndex + 1)
	if (shouldPlay) {
		play(Array.isArray(musicItem) ? musicItem[0] : musicItem)
	}
}
/**
 * 是当前正在播放的音频
 *
 */
const isCurrentMusic = (musicItem: IMusic.IMusicItem | null | undefined) => {
	return isSameMediaItem(musicItem, currentMusicStore.getValue()) ?? false
}
/**
 * 从播放列表移除IMusicItem
 *
 */
const remove = async (musicItem: IMusic.IMusicItem) => {
	retirePreparedSlot()
	const playList = getPlayList()
	let newPlayList: IMusic.IMusicItem[] = []
	let currentMusic: IMusic.IMusicItem | null = currentMusicStore.getValue()
	const targetIndex = getMusicIndex(musicItem)
	let shouldPlayCurrent: boolean | null = null
	if (targetIndex === -1) {
		// 1. 这种情况应该是出错了
		return
	}
	// 2. 移除的是当前项
	if (currentIndex === targetIndex) {
		// 2.1 停止播放，移除当前项
		newPlayList = produce(playList, (draft) => {
			draft.splice(targetIndex, 1)
		})
		// 2.2 设置新的播放列表，并更新当前音乐
		if (newPlayList.length === 0) {
			currentMusic = null
			shouldPlayCurrent = false
		} else {
			currentMusic = newPlayList[currentIndex % newPlayList.length]
			// Native route loss/interruption can pause output without a remote event.
			// Intent only stands in for output while the requested source is pending.
			shouldPlayCurrent = ReactNativeTrackPlayer.isPlaying() ||
				(playbackIntentStore.getValue() === 'play' &&
					(trackSourceLoadingStore.getValue() !== null ||
						ReactNativeTrackPlayer.getPlaybackState() === PlaybackState.Buffering))
		}
	} else {
		// 3. 删除
		newPlayList = produce(playList, (draft) => {
			draft.splice(targetIndex, 1)
		})
	}

	setPlayList(newPlayList)
	setCurrentMusic(currentMusic)
	if (shouldPlayCurrent === true) {
		await play(currentMusic, true)
	} else if (shouldPlayCurrent === false) {
		reset()
	} else {
		updateNextMetadata()
	}
}

function updateNextMetadata() {
	retirePreparedSlot()
	if (!nativeQueue || ReactNativeTrackPlayer.getQueue().length !== 2 ||
		!isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem())) return
	ReactNativeTrackPlayer.replaceMediaItem(1, toMediaItem(getFakeNextTrack(), nativeQueue.token, true))
	schedulePreparedSlot()
}

/**
 * 设置播放模式
 * @param mode 播放模式
 */
const setRepeatMode = (mode: MusicRepeatMode) => {
	const playList = getPlayList()
	let newPlayList
	const prevMode = repeatModeStore.getValue()

	if (
		(prevMode === MusicRepeatMode.SHUFFLE && mode !== MusicRepeatMode.SHUFFLE) ||
		(mode === MusicRepeatMode.SHUFFLE && prevMode !== MusicRepeatMode.SHUFFLE)
	) {
		if (mode === MusicRepeatMode.SHUFFLE) {
			newPlayList = shuffle(playList)
		} else {
			newPlayList = sortByTimestampAndIndex(playList, true)
		}
		setPlayList(newPlayList)
	}

	const currentMusicItem = currentMusicStore.getValue()
	currentIndex = getMusicIndex(currentMusicItem)
	repeatModeStore.setValue(mode)
	// 更新下一首歌的信息
	updateNextMetadata()
	// 记录
	PersistStatus.set('music.repeatMode', mode)
}

/** 清空播放列表 */
const clear = async () => {
	setPlayList([])
	setCurrentMusic(null)

	reset()
	PersistStatus.set('music.musicItem', undefined)
	PersistStatus.set('music.progress', 0)
}
/** 清空待播列表 */
const clearToBePlayed = async () => {
	// 获取当前正在播放的音乐
	const currentMusic = currentMusicStore.getValue()

	if (currentMusic) {
		// 设置播放列表仅包含当前正在播放的音乐
		setPlayList([currentMusic])
		setCurrentMusic(currentMusic)

		updateNextMetadata()
	} else {
		// 如果没有当前播放的音乐，清空播放列表
		setPlayList([])
		setCurrentMusic(null)
		reset()
	}
}

/** 暂停 */
const pause = () => {
	setPlaybackIntent('pause')
	ReactNativeTrackPlayer.pause()
}

const stop = () => {
	setPlaybackIntent('stop')
	retirePreparedSlot()
	setCurrentStreamPriority(false)
	ReactNativeTrackPlayer.stop()
}

/** 设置音源 */
const setTrackSource = (track: Track) => {
	retirePreparedSlot()
	currentIndex = getMusicIndex(track as IMusic.IMusicItem)
	const token = createTrackSourceLoadingToken(track as IMusic.IMusicItem)
	// Snapshot after source resolution. A preference change never reloads the active item.
	const playbackOptions = { preciseSeeking: PersistStatus.get('music.preciseSeeking') === true }
	const items = [
		toMediaItem(track, token, false, playbackOptions),
		toMediaItem(getFakeNextTrack(), token, true),
	]
	// Keep the complete resolved source in JS. v5 getter projections lose headers.
	nativeQueue = { token, track, startedAt: Date.now(), handoffConsumed: false }
	ReactNativeTrackPlayer.setMediaItems(items)
	setCurrentMusic(track as IMusic.IMusicItem)
	PersistStatus.set('music.musicItem', track as IMusic.IMusicItem)
	PersistStatus.set('music.progress', 0)

	const intent = playbackIntentStore.getValue()
	if (intent === 'play') {
		ReactNativeTrackPlayer.play()
	} else if (intent === 'stop') {
		// A source may finish resolving after Stop. Retain it for a later Play,
		// without letting setMediaItems change the requested stopped state.
		ReactNativeTrackPlayer.stop()
	}
	if (trackSourceLoadingStore.getValue() === null) reconcileStreamPriority()
}
/**
 * 设置currentMusicStore，更新currentIndex
 *
 */
const setCurrentMusic = (musicItem?: IMusic.IMusicItem | null) => {
	if (!isSameMediaItem(musicItem, currentMusicStore.getValue()) || !musicItem) {
		lyricsSequence++
		retryLyrics = null
		nowLyricState.setValue(null)
		nowTranslationLyricState.setValue(null)
		lyricsStatusStore.setValue({ status: musicItem ? 'loading' : 'idle', retryable: false })
	}
	if (!musicItem) {
		currentIndex = -1
		currentMusicStore.setValue(null)
		trackSourceLoadingStore.setValue(null)
		PersistStatus.set('music.musicItem', undefined)
		PersistStatus.set('music.progress', 0)
		return
	}
	currentIndex = getMusicIndex(musicItem)
	currentMusicStore.setValue(musicItem)
}

const setQuality = (quality: IMusic.IQualityKey) => {
	qualityStore.setValue(quality)
	PersistStatus.set('music.quality', quality)
}
//添加歌曲到指定歌单
const addSongToStoredPlayList = (playlist: IMusic.PlayList, track: IMusic.IMusicItem) => {
	try {
		const nowPlayLists = playListsStore.getValue() || []
		const updatedPlayLists = nowPlayLists.map((existingPlaylist) => {
			if (existingPlaylist.id === playlist.id) {
				// 检查歌曲是否已经存在于播放列表中
				// console.log('track', JSON.stringify(track))
				// console.log('existingPlaylist.songs', JSON.stringify(existingPlaylist.songs))
				const songExists = existingPlaylist.songs.some((song) => isSameMediaItem(song, track))
				// console.log('songExists', songExists)

				if (!songExists) {
					// 只有当歌曲不存在时才添加
					return {
						...existingPlaylist,
						songs: [...existingPlaylist.songs, existingPlaylist.remoteBinding ||
							(existingPlaylist.platform === 'QQ' && /^\d+$/.test(existingPlaylist.id))
							? { ...track, localAdded: true } : track],
					}
				} else {
					logInfo('歌曲已存在')
				}
			}
			return existingPlaylist
		})

		playListsStore.setValue(updatedPlayLists)
		PersistStatus.set('music.playLists', updatedPlayLists)
		logInfo('歌曲成功添加到歌单')
	} catch (error) {
		logError('添加歌曲到歌单时出错:', error)
		// 可以在这里添加一些错误处理逻辑，比如显示一个错误提示给用户
	}
}
//从歌单删除指定歌曲
//添加歌曲到指定歌单
const deleteSongFromStoredPlayList = (playlist: IMusic.PlayList, trackId: string | IMusic.IMusicItem, platform?: string) => {
	try {
		const nowPlayLists = playListsStore.getValue() || []
		const updatedPlayLists = nowPlayLists.map((existingPlaylist) => {
			if (existingPlaylist.id === playlist.id) {
				// 检查歌曲是否已经存在于播放列表中
				const id = typeof trackId === 'string' ? trackId : trackId.id
				const targetPlatform = typeof trackId === 'string' ? platform : trackId.platform
				// Legacy id-only callers may delete only an unambiguous platform/id.
				const matches = existingPlaylist.songs.filter((song) => song.id === id &&
					(targetPlatform === undefined || song.platform === targetPlatform))
				const songExists = matches.length > 0 &&
					(targetPlatform !== undefined || new Set(matches.map((song) => song.platform)).size === 1)

				if (songExists) {
					// 只有当歌曲存在时才删除
					return {
						...existingPlaylist,
						songs: existingPlaylist.songs.filter((song) => !matches.includes(song)),
					}
				} else {
					logInfo('歌曲不存在')
				}
			}
			return existingPlaylist
		})

		playListsStore.setValue(updatedPlayLists)
		PersistStatus.set('music.playLists', updatedPlayLists)
		logInfo('歌曲成功删除')
	} catch (error) {
		logError('删除歌曲到歌单时出错:', error)
		// 可以在这里添加一些错误处理逻辑，比如显示一个错误提示给用户
	}
}
const addPlayLists = (playlist: IMusic.PlayList) => {
	try {
		const nowPlayLists = playListsStore.getValue() || []

		// 检查播放列表是否已存在
		const playlistExists = nowPlayLists.some(
			(existingPlaylist) => existingPlaylist.id == playlist.id,
		)

		if (playlistExists) {
			// logInfo(`Playlist already exists, not adding duplicate. Current playlists: ${JSON.stringify(nowPlayLists, null, 2)}`);
			return // 如果播放列表已存在，直接返回，不进行任何操作
		}

		// 如果播放列表不存在，则添加它
		const updatedPlayLists = [...nowPlayLists, playlist]
		playListsStore.setValue(updatedPlayLists)
		PersistStatus.set('music.playLists', updatedPlayLists)
		logInfo('Playlist added successfully')
	} catch (error) {
		logError('Error adding playlist:', error)
		// 可以在这里添加一些错误处理逻辑，比如显示一个错误提示给用户
	}
}

const deletePlayLists = (playlistId: string) => {
	try {
		if (playlistId == 'favorites') {
			return '不能删除收藏歌单'
		}
		const nowPlayLists = playListsStore.getValue() || []

		// 检查播放列表是否已存在
		const playlistFiltered = nowPlayLists.filter(
			(existingPlaylist) => existingPlaylist.id !== playlistId,
		)

		// 如果播放列表不存在，则添加它
		const updatedPlayLists = [...playlistFiltered]
		playListsStore.setValue(updatedPlayLists)
		PersistStatus.set('music.playLists', updatedPlayLists)
		logInfo('Playlist deleted successfully')
		return 'success'
	} catch (error) {
		logError('Error deleted playlist:', error)
	}
}
const getPlayListById = (playlistId: string) => {
	try {
		// logInfo(playlistId + 'playlistId')
		const nowPlayLists = playListsStore.getValue() || []
		const playlistFiltered = nowPlayLists.filter(
			(existingPlaylist) => existingPlaylist.id === playlistId,
		)
		return playlistFiltered
	} catch (error) {
		logError('Error find playlist:', error)
	}
}
const addMusicApi = (musicApi: IMusic.MusicApi) => {
	try {
		const nowMusicApiList = musicApiStore.getValue() || []

		// 检查是否已存在
		const existingApiIndex = nowMusicApiList.findIndex(
			(existingApi) => existingApi.id === musicApi.id,
		)

		if (existingApiIndex !== -1) {
			Alert.alert('是否覆盖', `已经存在该音源，是否覆盖？`, [
				{
					text: '确定',
					onPress: () => {
						const latest = musicApiStore.getValue() || []
						if (!latest.some((api) => api.id === musicApi.id)) return
						const selected = musicApiSelectedStore.getValue()?.id === musicApi.id
						const updatedMusicApiList = latest.map((api) => api.id === musicApi.id
							? { ...musicApi, isSelected: selected } : api)
						musicApiStore.setValue(updatedMusicApiList)
						PersistStatus.set('music.musicApi', updatedMusicApiList)
						if (selected) void setMusicApiAsSelectedById(musicApi.id)
						logInfo('Music API updated successfully')
						Alert.alert('成功', '音源更新成功', [
							{ text: '确定', onPress: () => logInfo('Update alert closed') },
						])
					},
				},
				{ text: '取消', onPress: () => {}, style: 'cancel' },
			])
		} else {
			// 如果是新添加的音源，默认设置 isSelected 为 false 。如果音源为空，则自动选择
			const newMusicApi = { ...musicApi, isSelected: false }
			console.log('nowMusicApiList', nowMusicApiList)
			const updatedMusicApiList = [...nowMusicApiList, newMusicApi]
			if (!nowMusicApiList.length) {
				logInfo('音源为空，自动选择')
				musicApiStore.setValue(updatedMusicApiList)
				PersistStatus.set('music.musicApi', updatedMusicApiList)
				setMusicApiAsSelectedById(newMusicApi.id)
			} else {
				musicApiStore.setValue(updatedMusicApiList)
				PersistStatus.set('music.musicApi', updatedMusicApiList)
			}
			logInfo('音源导入成功')
			Alert.alert('成功', '音源导入成功', [
				{ text: '确定', onPress: () => logInfo('Add alert closed') },
			])
		}
	} catch (error) {
		logError('Error adding/updating music API:', error)
		Alert.alert('失败', '音源导入/更新失败', [
			{ text: '确定', onPress: () => logInfo('Error alert closed') },
		])
	}
}
const reloadNowSelectedMusicApi = async () => {
	const revision = ++sourceRevision
	try {
		// 找到被选中的音源脚本
		const selectedApi = musicApiSelectedStore.getValue()

		if (selectedApi === null) {
			logInfo('No music API is currently selected.')
			return null
		}
		// 重新加载选中的脚本
		const reloadedApi = await reloadMusicApi(selectedApi)
		const latestApis: IMusic.MusicApi[] = musicApiStore.getValue() || []
		if (revision !== sourceRevision || musicApiSelectedStore.getValue() !== selectedApi ||
			!latestApis.some((api) => api.id === selectedApi.id)) return null

		// 更新 musicApiStore 中的脚本
		musicApiSelectedStore.setValue(reloadedApi)
		const updatedApis = latestApis.map((api) => api.id === reloadedApi.id ? reloadedApi : api)
		musicApiStore.setValue(updatedApis)
		PersistStatus.set('music.musicApi', updatedApis)

		// 更新 store 和持久化存储
		PersistStatus.set('music.selectedMusicApi', reloadedApi)

		logInfo(`Selected music API "${reloadedApi.name}" reloaded successfully`)

		return reloadedApi
	} catch (error) {
		logError('Error reloading selected music API:', error)
		throw error
	} finally {
		if (revision === sourceRevision) refetchCurrentLyricsIfOwned()
	}
}
const reloadMusicApi = (musicApi: IMusic.MusicApi, isTest: boolean = false): Promise<IMusic.MusicApi> => withSourceRuntimeLock(async () => {
	if (!musicApi.isSelected && !isTest) {
		return musicApi // 如果没有被选中，直接返回原始对象
	}

	try {
		// 检测是否为 lx-music 格式脚本
		if (musicApi.scriptType === 'lxmusic' || isLxMusicScript(musicApi.script)) {
			return await reloadLxMusicScript(musicApi)
		}

		// Cymusic 原有 CommonJS 格式
		const context: any = {
			module: { exports: {} },
			exports: {},
			require: () => {},
		}

		const scriptFunction = new Function('module', 'exports', 'require', musicApi.script)
		scriptFunction.call(context, context.module, context.exports, context.require)
		if (!isTest) disposeLxMusicScript()

		return {
			...musicApi,
			getMusicUrl: context.module.exports.getMusicUrl || musicApi.getMusicUrl,
			getLyric: typeof context.module.exports.getLyric === 'function' ? context.module.exports.getLyric : undefined,
			sources: context.module.exports.sources,
		}
	} catch (error) {
		logError(`Error reloading script for API "${musicApi.name}":`, error)
		return musicApi
	}
})
const setMusicApiAsSelectedById = async (musicApiId: string) => {
	let revision: number | undefined
	try {
		// 获取当前存储的所有音源脚本
		let musicApis: IMusic.MusicApi[] = musicApiStore.getValue() || []

		// 检查指定的音源是否存在
		const targetApiIndex = musicApis.findIndex((api) => api.id === musicApiId)

		if (targetApiIndex === -1) {
			logError(`Music API with id ${musicApiId} not found`)
			Alert.alert('错误', '未找到指定的音源')
			return
		}

		// 更新选中状态
		musicApis = musicApis.map((api) => ({
			...api,
			isSelected: api.id === musicApiId,
		}))

		// 获取新选中的音源
		const selectedApi = musicApis[targetApiIndex]
		revision = ++sourceRevision
		invalidatePreparedSlot()
		musicApiStore.setValue(musicApis)
		PersistStatus.set('music.musicApi', musicApis)
		musicApiSelectedStore.setValue(selectedApi)
		PersistStatus.set('music.selectedMusicApi', selectedApi)

		// 重新加载选中的音源脚本
		const reloadedApi = await reloadMusicApi(selectedApi)
		const latestApis: IMusic.MusicApi[] = musicApiStore.getValue() || []
		if (revision !== sourceRevision || musicApiSelectedStore.getValue() !== selectedApi ||
			!latestApis.some((api) => api.id === musicApiId)) return

		// 更新重新加载后的音源
		musicApiSelectedStore.setValue(reloadedApi)
		// 更新 store 和持久化存储
		PersistStatus.set('music.selectedMusicApi', reloadedApi)
		const latest = musicApiStore.getValue().map((api) => api.id === musicApiId ? reloadedApi : api)
		musicApiStore.setValue(latest)
		PersistStatus.set('music.musicApi', latest)

		logInfo(`Music API "${reloadedApi.name}" set as selected and reloaded successfully`)
		Alert.alert('成功', `音源 "${reloadedApi.name}" 已设置为当前选中并重新加载`)
	} catch (error) {
		logError('Error setting music API as selected:', error)
		Alert.alert('错误', '设置选中音源时发生错误')
	} finally {
		if (revision !== undefined && revision === sourceRevision) refetchCurrentLyricsIfOwned()
	}
}

const deleteMusicApiById = (musicApiId: string) => {
	const selectedMusicApi = musicApiSelectedStore.getValue()
	const musicApis = musicApiStore.getValue() || []
	if (selectedMusicApi?.id === musicApiId) {
		const revision = ++sourceRevision
		invalidatePreparedSlot()
		musicApiSelectedStore.setValue(null)
		PersistStatus.set('music.selectedMusicApi', undefined)
		void withSourceRuntimeLock(async () => {
			if (!musicApiSelectedStore.getValue()) disposeLxMusicScript()
		}).catch((error) => logError('释放音源失败', error)).finally(() => {
			if (revision === sourceRevision) refetchCurrentLyricsIfOwned()
		})
	}
	const musicApisFiltered = musicApis.filter((musicApi) => musicApi.id !== musicApiId)
	musicApiStore.setValue(musicApisFiltered)
	PersistStatus.set('music.musicApi', musicApisFiltered)
	logInfo('Music API deleted successfully')
	Alert.alert('成功', '音源删除成功', [
		{ text: '确定', onPress: () => logInfo('Add alert closed') },
	])
}
const play = async (musicItem?: IMusic.IMusicItem | null, forcePlay?: boolean, skipOperation?: symbol) => {
	let trackSourceLoadingToken: string | null = null
	try {
		// A direct selection supersedes an older Next/Previous request. Its late
		// finally must not clear a newer navigation operation with the same direction.
		if (skipOperation !== activeTrackSkip) retireTrackSkip()
		if (!musicItem && !forcePlay && installedNext) {
			handleNativeTransition(ReactNativeTrackPlayer.getActiveMediaItem(), ReactNativeTrackPlayer.getActiveMediaItemIndex())
		}
		if (!musicItem) {
			musicItem = currentMusicStore.getValue()
		}
		if (!musicItem) {
			throw new Error(PlayFailReason.PLAY_LIST_IS_EMPTY)
		}
		setPlaybackIntent('play')

		// 1. If already playing this track
		if (isCurrentMusic(musicItem)) {
			// Resume an outstanding request without starting another one. Its result
			// reads the latest intent; explicit replacement still gets a new token.
			if (trackSourceLoadingStore.getValue() !== null && !forcePlay) return
			const firstItem = ReactNativeTrackPlayer.getQueue()[0]
			if (nativeQueue && getNativeTrackIdentity(firstItem)?.token === nativeQueue.token &&
				isSameMediaItem(musicItem, nativeQueue.track as IMusic.IMusicItem)) {
				trackSourceLoadingStore.setValue(null)
				if (forcePlay || ReactNativeTrackPlayer.getActiveMediaItemIndex() !== 0 ||
					ReactNativeTrackPlayer.getPlaybackState() === PlaybackState.Error) {
					// A fresh transport token also retires already-queued placeholder events.
					setTrackSource(nativeQueue.track)
					fetchCurrentLyrics(nativeQueue.track as IMusic.IMusicItem, nativeQueue.token)
				} else {
					// In v5, Play reloads a stopped retained item from zero, including headers.
					ReactNativeTrackPlayer.play()
					reconcileStreamPriority()
				}
				return
			}
		}

		// 2. Add to playlist if not present
		if (!isInPlayList(musicItem)) {
			add(musicItem)
		}

		trackSourceLoadingToken = createTrackSourceLoadingToken(musicItem)
		retirePreparedSlot()
		setCurrentStreamPriority(true)
		trackSourceLoadingStore.setValue(trackSourceLoadingToken)

		// 3. Update current music state immediately (UI updates instantly)
		setCurrentMusic(musicItem)

		// 4. Resolve source (cache check + network if needed)
		const source = await resolveSource(musicItem, {
			requestType: 'current',
		})

		// 5. Race condition guard
		if (!isCurrentMusic(musicItem) || trackSourceLoadingStore.getValue() !== trackSourceLoadingToken) {
			return
		}

		// 6. Build track and set source
		const artworkKey = neteaseArtworkKey(musicItem)
		const confirmedArtwork = artworkKey ? pendingConfirmedArtwork.get(artworkKey) : undefined
		const track = mergeProps(musicItem, {
			...(confirmedArtwork ? { artwork: confirmedArtwork } : {}),
			url: source.wasCached ? getCacheFileUri(source.url) : source.url,
			headers: source.headers,
			userAgent: source.userAgent,
			cacheSourceId: source.cacheIdentity?.sourceId ?? musicItem.cacheSourceId,
			cacheQuality: source.cacheIdentity?.quality ?? musicItem.cacheQuality,
		}) as IMusic.IMusicItem
		logInfo('获取音源成功：', track)
		setTrackSource(track)
		if (artworkKey && pendingConfirmedArtwork.get(artworkKey) === confirmedArtwork) pendingConfirmedArtwork.delete(artworkKey)
		const appliedToken = nativeQueue.token

		// 7. Fetch lyrics in background (non-blocking)
		fetchCurrentLyrics(track, appliedToken)

		// 8. Auto-cache in background
		if (
			source.url !== fakeAudioMp3Uri &&
			!source.url.includes('fake') &&
			!source.wasCached &&
			autoCacheLocalStore.getValue() &&
			!source.url.startsWith('file://')
		) {
			setTimeout(() => {
				downloadToCache(track)
					.then((localUri) => {
						logInfo('音乐已缓存到本地:', localUri)
						const newTrack = { ...track, url: localUri }
						addImportedLocalMusic([newTrack], false)
					})
					.catch((error) => {
						logError('缓存音乐时出错:', error)
					})
			}, 5000)
		}

	} catch (e: any) {
		if (trackSourceLoadingToken && trackSourceLoadingStore.getValue() !== trackSourceLoadingToken) return
		const message = e?.message
		if (message === PlayFailReason.FORBID_CELLUAR_NETWORK_PLAY) {
			logInfo('移动网络')
		} else if (message === PlayFailReason.INVALID_SOURCE) {
			logError('音源为空，播放失败')
			await failToPlay()
		} else if (message === PlayFailReason.PLAY_LIST_IS_EMPTY) {
			// empty queue
		} else {
			logError('播放失败', e)
		}
	} finally {
		if (
			trackSourceLoadingToken &&
			trackSourceLoadingStore.getValue() === trackSourceLoadingToken
		) {
			trackSourceLoadingStore.setValue(null)
			if (nativeQueue?.track.url?.startsWith('file://')) setCurrentStreamPriority(false)
			reconcileStreamPriority()
		}
	}
}
const cacheAndImportMusic = async (track: IMusic.IMusicItem) => {
	try {
		const resolved = isCurrentMusic(track) && nativeQueue &&
			isSameMediaItem(track, nativeQueue.track as IMusic.IMusicItem) && trackSourceLoadingStore.getValue() === null
			? nativeQueue.track as IMusic.IMusicItem : track
		const localPath = await downloadToCache(resolved)
		await addImportedLocalMusic([{ ...resolved, url: localPath }], false)

		Alert.alert('成功', '音乐已缓存到本地', [{ text: '确定', onPress: () => {} }])
	} catch (error) {
		logError('缓存音乐时出错:', error)
		// await addImportedLocalMusic([track], false)
	}
}

/**
 * 播放音乐，同时替换播放队列
 * @param musicItem 音乐
 * @param newPlayList 替代列表
 */
const playWithReplacePlayList = async (
	musicItem: IMusic.IMusicItem,
	newPlayList: IMusic.IMusicItem[],
) => {
	retirePreparedSlot()
	if (newPlayList.length !== 0) {
		const now = Date.now()
		const playListItems = newPlayList.map((item, index) => ({
			...item,
			[timeStampSymbol]: now,
			[sortIndexSymbol]: index,
		}))
		setPlayList(
			repeatModeStore.getValue() === MusicRepeatMode.SHUFFLE
				? shuffle(playListItems)
				: playListItems,
			true,
			true, // lazy index build - defer to first query
		)
		await play(musicItem, true)
	}
}

const runWithTrackSkipLoading = async (
	direction: 'next' | 'previous',
	action: (operation: symbol) => Promise<void>,
) => {
	if (activeTrackSkip) {
		return
	}

	const operation = Symbol(direction)
	activeTrackSkip = operation
	trackSkipLoadingStore.setValue(direction)
	try {
		await action(operation)
	} finally {
		if (activeTrackSkip === operation) {
			retireTrackSkip()
		}
	}
}

const skipToNext = async () => {
	retirePreparedSlot()
	await runWithTrackSkipLoading('next', async (operation) => {
		if (isPlayListEmpty()) {
			setCurrentMusic(null)
			reset()
			return
		}
		await play(getPlayListMusicAt(currentIndex + 1), true, operation)
	})
}

const skipToPrevious = async () => {
	retirePreparedSlot()
	await runWithTrackSkipLoading('previous', async (operation) => {
		if (isPlayListEmpty()) {
			setCurrentMusic(null)
			reset()
			return
		}

		await play(getPlayListMusicAt(currentIndex === -1 ? 0 : currentIndex - 1), true, operation)
	})
}

/** 修改当前播放的音质 */
const changeQuality = async (newQuality: IMusic.IQualityKey) => {
	// 获取当前的音乐和进度
	if (newQuality === qualityStore.getValue()) {
		return true
	}

	// 获取当前歌曲
	const musicItem = currentMusicStore.getValue()
	if (!musicItem) {
		return false
	}
	try {
		setQuality(newQuality)
		return true
	} catch {
		// 修改失败
		return false
	}
}

enum PlayFailReason {
	/** 禁止移动网络播放 */
	FORBID_CELLUAR_NETWORK_PLAY = 'FORBID_CELLUAR_NETWORK_PLAY',
	/** 播放列表为空 */
	PLAY_LIST_IS_EMPTY = 'PLAY_LIST_IS_EMPTY',
	/** 无效源 */
	INVALID_SOURCE = 'INVALID_SOURCE',
	/** 非当前音乐 */
}

function useMusicState() {
	return usePlaybackState()
}

const emptyProgress = { position: 0, duration: 0, buffered: 0, cached: 0 }

function getProgress() {
	return isCurrentNativeItem(ReactNativeTrackPlayer.getActiveMediaItem())
		? ReactNativeTrackPlayer.getProgress()
		: emptyProgress
}

function useMusicProgress(intervalSeconds = 1) {
	// v5 polls drive renders but retain the previous track's sample between ticks.
	// Read the current native snapshot so a new selection cannot borrow its duration.
	useProgress(intervalSeconds)
	currentMusicStore.useValue()
	return getProgress()
}

function getPreviousMusic() {
	const currentMusicItem = currentMusicStore.getValue()
	if (!currentMusicItem) {
		return null
	}

	return getPlayListMusicAt(currentIndex - 1)
}

function getNextMusic() {
	const currentMusicItem = currentMusicStore.getValue()
	if (!currentMusicItem) {
		return null
	}

	return getPlayListMusicAt(currentIndex + 1)
}
const addImportedLocalMusic = async (musicItem: IMusic.IMusicItem[], isAlert: boolean = true) => {
	try {
		console.log('addImportedLocalMusic', musicItem[0])
		const importedLocalMusic = importedLocalMusicStore.getValue() || []
		const newMusicItems = musicItem.filter(
			(newItem) => !importedLocalMusic.some((existingItem) => existingItem.id == newItem.id),
		)
		if (newMusicItems.length === 0) {
			// Alert.alert('提示', '所有选择的音乐已经存在，没有新的音乐被导入。')
			return
		}
		// 确保目标目录存在 isAlert只有导入本地音乐为true。所有自动缓存为false.,不需要移动文件
		if (isAlert) {
			const targetDir = `${FileSystemNative.documentDirectoryPath}/importedLocalMusic`
			await ensureDirExists(targetDir)

			// 移动文件并更新musicItem的url
			for (const item of newMusicItems) {
				if (item.url.startsWith('file://')) {
					const originalExtension = item.url.split('.').pop() || 'mp3'

					// 创建一个安全的文件名（移除或替换不允许的字符）
					const safeTitle = item.title.replace(/[/\\?%*:|"<>]/g, '-')
					const safeArtist = item.artist.replace(/[/\\?%*:|"<>]/g, '-')
					const fileName = `${safeTitle}-${safeArtist}.${originalExtension}`
					const newPath = `${targetDir}/${fileName}`
					await FileSystem.moveAsync({
						from: item.url,
						to: newPath,
					})
					item.url = newPath
				}
			}
		}
		const updatedImportedLocalMusic = [...importedLocalMusic, ...newMusicItems]
		importedLocalMusicStore.setValue(updatedImportedLocalMusic)
		PersistStatus.set('music.importedLocalMusic', updatedImportedLocalMusic)
		if (isAlert) {
			Alert.alert('成功', '音乐导入成功,请手动选择', [
				{ text: '确定', onPress: () => logInfo('Add alert closed') },
			])
		}
	} catch (error) {
		logError('本地音乐保存时出错:', error)
	}
}
const deleteImportedLocalMusic = async (musicItemsIdToDelete: string) => {
	try {
		const importedLocalMusic = importedLocalMusicStore.getValue() || []
		const selectedItems = importedLocalMusic.filter((item) => item.id === musicItemsIdToDelete)
		if (selectedItems.length !== 1) return
		const selectedItem = selectedItems[0]
		const localFile = await resolveLocalFile(selectedItem.url, { requireOwnedMedia: true })
		const currentItems = importedLocalMusicStore.getValue() || []
		if (
			!currentItems.includes(selectedItem) ||
			currentItems.filter((item) => item.id === musicItemsIdToDelete).length !== 1
		) {
			return
		}
		if (localFile.status === 'resolved') {
			await FileSystem.deleteAsync(localFile.fileUri)
		}
		// Explicit removal may discard a missing-file record, but never guesses a file
		// target. Read the latest list after I/O so concurrent imports/deletes survive.
		const latestItems = importedLocalMusicStore.getValue() || []
		const updatedImportedLocalMusic = latestItems.filter((item) => item !== selectedItem)
		importedLocalMusicStore.setValue(updatedImportedLocalMusic)
		PersistStatus.set('music.importedLocalMusic', updatedImportedLocalMusic)
	} catch (error) {
		logError('删除本地音乐时出错:', error)
	}
}
const isExistImportedLocalMusic = (musicItemName: string) => {
	// todo 检查文件存在？
	const importedLocalMusic = importedLocalMusicStore.getValue() || []
	return importedLocalMusic.some((item) => item.genre === musicItemName)
}
const toggleAutoCacheLocal = (bool: boolean) => {
	PersistStatus.set('music.autoCacheLocal', bool)
	autoCacheLocalStore.setValue(bool)
}
const togglePreloadNextTrack = (bool: boolean) => {
	invalidatePreparedSlot()
	PersistStatus.set('music.preloadNextTrack', bool)
	preloadNextTrackStore.setValue(bool)
	if (bool) schedulePreparedSlot()
}
const toggleIsCachedIconVisible = (bool: boolean) => {
	PersistStatus.set('music.isCachedIconVisible', bool)
	isCachedIconVisibleStore.setValue(bool)
}
const showErrorMessage = (message: string) => {
	// 只在应用在前台时显示 Alert
	if (AppState.currentState === 'active') {
		showToast('错误', message, 'error')
		// Alert.alert('错误', message, [{ text: '确定', onPress: () => {} }])
	}
}
const myTrackPlayer = {
	updateCurrentArtwork,
	retryCurrentLyrics,
	setupTrackPlayer,
	usePlayList,
	getPlayList,
	addAll,
	add,
	addAsNextTrack,
	skipToNext,
	skipToPrevious,
	play,
	playWithReplacePlayList,
	pause,
	stop,
	observeNativeTransport,
	remove,
	clear,
	clearToBePlayed,
	useCurrentMusic: currentMusicStore.useValue,
	getCurrentMusic: currentMusicStore.getValue,
	useRepeatMode: repeatModeStore.useValue,
	getRepeatMode: repeatModeStore.getValue,
	toggleRepeatMode,
	usePlaybackState,
	setRepeatMode,
	setQuality,
	getProgress,
	useProgress: useMusicProgress,
	seekTo: (position: number) => {
		retirePreparedSlot()
		ReactNativeTrackPlayer.seekTo(position)
		reconcileStreamPriority()
	},
	isCurrentNativeItem,
	isCurrentProgressEvent,
	changeQuality,
	addPlayLists,
	deletePlayLists,
	getPlayListById,
	addMusicApi,
	setMusicApiAsSelectedById,
	deleteMusicApiById,
	addSongToStoredPlayList,
	deleteSongFromStoredPlayList,
	addImportedLocalMusic,
	deleteImportedLocalMusic,
	isExistImportedLocalMusic,
	useCurrentQuality: qualityStore.useValue,
	getCurrentQuality: qualityStore.getValue,
	getRate: ReactNativeTrackPlayer.getPlaybackSpeed,
	setRate: ReactNativeTrackPlayer.setPlaybackSpeed,
	useMusicState,
	reset,
	getPreviousMusic,
	getNextMusic,
	clearCache,
	toggleAutoCacheLocal,
	togglePreloadNextTrack,
	cacheAndImportMusic,
	isCached,
	toggleIsCachedIconVisible,
	reloadMusicApi,
}

export default myTrackPlayer
export { MusicRepeatMode, PlaybackState as MusicState }
