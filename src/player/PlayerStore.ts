import { MusicRepeatMode } from '@/helpers/types'
import { GlobalState } from '@/utils/stateMapper'
import { invalidatePlaybackPreparation } from './preparationInvalidation'
import { sourceId } from './sourceIdentity'

/** 当前播放 */
export const currentMusicStore = new GlobalState<IMusic.IMusicItem | null>(null)
/** 歌单 */
export const playListsStore = new GlobalState<IMusic.PlayList[] | []>(null)
/** 播放模式 */
export const repeatModeStore = new GlobalState<MusicRepeatMode>(MusicRepeatMode.QUEUE)
/** 音质 */
export const qualityStore = new GlobalState<IMusic.IQualityKey>('128k')
/** 音源 */
export const musicApiStore = new GlobalState<IMusic.MusicApi[] | []>(null)
/** 当前音源 */
export const musicApiSelectedStore = new GlobalState<IMusic.MusicApi>(null)
/** 音源状态 */
export const nowApiState = new GlobalState<string>('正常')
/** 是否自动缓存本地 */
export const autoCacheLocalStore = new GlobalState<boolean>(true)
/** 是否提前准备下一首 */
export const preloadNextTrackStore = new GlobalState<boolean>(true)
/** 是否显示已缓存图标 */
export const isCachedIconVisibleStore = new GlobalState<boolean>(true)
/** 首页加载歌曲数量 */
export const songsNumsToLoadStore = new GlobalState<number>(100)
/** 已导入的本地音乐 */
export const importedLocalMusicStore = new GlobalState<IMusic.IMusicItem[] | []>(null)
/** 当前歌词 */
export const nowLyricState = new GlobalState<string>(null)
/** 当前歌词译文 */
export const nowTranslationLyricState = new GlobalState<string>(null)
/** 切歌中的按钮方向 */
export const trackSkipLoadingStore = new GlobalState<'next' | 'previous' | null>(null)
/** 当前曲目音源解析中 */
export const trackSourceLoadingStore = new GlobalState<string | null>(null)
/** User transport intent; v5 readiness/output do not expose pending play intent. */
export const playbackIntentStore = new GlobalState<'play' | 'pause' | 'stop'>('pause')

// Invalidate synchronously, even when preferences change away and back during I/O.
function invalidateOnChange<T>(store: GlobalState<T>, key: (value: T) => string) {
	const setValue = store.setValue
	store.setValue = (value) => {
		const before = key(store.getValue())
		setValue(value)
		if (before !== key(store.getValue())) invalidatePlaybackPreparation()
	}
}
invalidateOnChange(qualityStore, String)
invalidateOnChange(preloadNextTrackStore, String)
invalidateOnChange(musicApiSelectedStore, sourceId)
invalidateOnChange(musicApiStore, (apis) =>
	JSON.stringify((apis || []).map((api) => [sourceId(api), api.enabled !== false])),
)
