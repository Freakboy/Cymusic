import { requireOptionalNativeModule } from 'expo'
import { AppState, Platform } from 'react-native'
import NativePlayer from '@rntp/player'
import type NowPlaying from '../../modules/cymusic-native/nowPlaying'
import myTrackPlayer from '@/helpers/trackPlayerIndex'
import { currentMusicStore, nowLyricState, playListsStore } from '@/player/PlayerStore'
import PersistStatus from '@/store/PersistStatus'
import getOrCreateMMKV from '@/store/getOrCreateMMKV'
import { logError } from '@/helpers/logger'
import LyricParser from '@/utils/lrcParser'

type Collection = { id: string; title: string; tracks: IMusic.IMusicItem[] }
let activeBridge: ReturnType<typeof createBridge> | undefined
let activeBridgeStart: Promise<ReturnType<typeof createBridge>> | undefined

/** Call once AFTER await myTrackPlayer.setupTrackPlayer(), including CarPlay cold launches.
 * Keep alive at app scope, not in a player screen. No foreground gate is needed.
 */
export async function startCarPlayBridge() {
	if (activeBridgeStart) return activeBridgeStart
	const native = Platform.OS === 'ios'
		? requireOptionalNativeModule<typeof NowPlaying>('CyMusicNowPlaying')
		: null
	const bridge = createBridge(native, () => {
		if (activeBridge !== bridge) return
		activeBridge = undefined
		activeBridgeStart = undefined
	})
	activeBridge = bridge
	activeBridgeStart = (async () => {
		try {
			await bridge.sync()
			void bridge.drain().catch((error) => logError('CarPlay 选曲失败', error))
			return bridge
		} catch (error) {
			bridge.dispose()
			throw error
		}
	})()
	return activeBridgeStart
}

function createBridge(native: typeof NowPlaying | null, onDispose: () => void) {
	let disposed = false
	let lastSnapshot = ''
	let lyricTitleEnabled = false
	let lyricTrack: IMusic.IMusicItem | null = null
	let lyricSource: string | null = null
	let lyricDelay = 0
	let lyricParser: LyricParser | null = null
	let projectedTitle: string | null = null
	const restoreTitle = () => {
		const track = currentMusicStore.getValue()
		if (projectedTitle && track && myTrackPlayer.isCurrentNativeItem(NativePlayer.getActiveMediaItem())) {
			NativePlayer.updateMetadata(0, { title: track.title })
		}
		projectedTitle = null
	}
	const inFlight = new Set<string>()
	const report = (error: unknown) => logError('CarPlay bridge', error)
	const sync = async () => {
		if (!native || disposed) return
		const saved = playListsStore.getValue() ?? PersistStatus.get('music.playLists') ?? []
		const collections: Collection[] = [
			{ id: 'favorites', title: '收藏', tracks: PersistStatus.get('music.favorites') ?? [] },
			{ id: 'queue', title: '当前队列', tracks: myTrackPlayer.getPlayList() },
			...saved.map((list) => ({ id: `playlist:${list.id}`, title: list.title, tracks: list.songs })),
		]
		const json = JSON.stringify(collections)
		if (json === lastSnapshot) return
		await native.setCarPlaySnapshot(json)
		lastSnapshot = json
	}
	const handleSelection = async () => {
		if (!native || disposed) return
		const event = await native.getPendingCarPlaySelection()
		if (!event || disposed || inFlight.has(event.id)) return
		inFlight.add(event.id)
		let playing = false
		try {
			// Requests surviving a process restart are valid for ten minutes only.
			const age = Date.now() / 1000 - event.createdAt
			if (!Number.isFinite(age) || age < -60 || age > 600) return
			const tracks: IMusic.IMusicItem[] = JSON.parse(event.queueJSON)
			if (!Array.isArray(tracks) || !Number.isInteger(event.index) ||
				!tracks[event.index] || !tracks.every((track) =>
					track && typeof track.id === 'string' &&
					(track.platform === undefined || typeof track.platform === 'string'))) return
			// Legacy QQ favorites can omit platform. Normalize every entry without
			// filtering indices or guessing a source for unrecognized IDs.
			const queue = tracks.map((track) => {
				const mid = track.songmid || track.id
				return track.platform === undefined && typeof mid === 'string' && /^[a-z\d]{14}$/i.test(mid)
					? { ...track, platform: 'QQ' }
					: track
			})
			const selected = queue[event.index]
			await myTrackPlayer.playWithReplacePlayList(selected, queue)
			const current = myTrackPlayer.getCurrentMusic()
			playing = !disposed && current?.id === selected.id && current?.platform === selected.platform &&
				myTrackPlayer.isCurrentNativeItem(NativePlayer.getActiveMediaItem())
		} catch (error) {
			report(error)
		} finally {
			// Compare-and-clear natively: an older request cannot erase a newer tap.
			await native.completeCarPlaySelection(event.id, playing).catch(report)
			inFlight.delete(event.id)
		}
	}
	let drainTask: Promise<void> | undefined
	let drainAgain = false
	const drain = (): Promise<void> => {
		if (!native || disposed) return Promise.resolve()
		drainAgain = true
		if (drainTask) return drainTask
		// Serialize reads/playback so a slow older pull cannot play after a newer tap.
		drainTask = (async () => {
			do {
				drainAgain = false
				await handleSelection()
			} while (drainAgain && !disposed)
		})().finally(() => { drainTask = undefined })
		return drainTask
	}
	const subscription = native?.addListener('onCarPlaySelect', () => { void drain().catch(report) })
	const storage = native ? getOrCreateMMKV('appPersistStatus').addOnValueChangedListener((key) => {
		if (['music.favorites', 'music.playLists', 'music.play-list'].includes(key)) {
			// Persistence callbacks may run before the originating store update finishes.
			void Promise.resolve().then(sync).catch(report)
		}
		if (key === 'music.bluetoothLyrics') {
			lyricTitleEnabled = PersistStatus.get('music.bluetoothLyrics') === true
			if (!lyricTitleEnabled) restoreTitle()
		}
	}) : undefined
	const appState = native ? AppState.addEventListener('change', (state) => {
		if (state === 'active') {
			void sync().catch(report)
			void drain().catch(report)
		}
	}) : undefined

	// Opt-in LRC line projection through the documented title field. There is no
	// public synchronized Bluetooth-lyrics API or guarantee of accessory display.
	const timer = native ? setInterval(() => {
		if (!lyricTitleEnabled || disposed) return
		const track = currentMusicStore.getValue()
		if (track !== lyricTrack) {
			lyricTrack = track
			lyricSource = null
			lyricParser = null
			projectedTitle = null
		}
		if (!myTrackPlayer.isCurrentNativeItem(NativePlayer.getActiveMediaItem())) return
		const source = nowLyricState.getValue()
		const delay = PersistStatus.get('lyric.delaySeconds') ?? 0
		if (source !== lyricSource || delay !== lyricDelay) {
			lyricSource = source
			lyricDelay = delay
			lyricParser = source ? new LyricParser({ rawLrc: source }, track ?? undefined, { offset: delay }) : null
		}
		const text = lyricParser?.getPosition(myTrackPlayer.getProgress().position).lrc?.lrc || null
		const title = text ? `${track?.title || ''} · ${text}` : track?.title || ''
		if (title !== projectedTitle) {
			// RNTP owns Now Playing and re-anchors elapsed/rate on metadata writes.
			// Slot 0 is still this owned item; a native advance to slot 1 cannot
			// apply an old line to the new song while JS handles the transition.
			NativePlayer.updateMetadata(0, { title })
			projectedTitle = title
		}
	}, 500) : undefined
	lyricTitleEnabled = PersistStatus.get('music.bluetoothLyrics') === true

	return {
		sync,
		drain,
		async setLyricTitleEnabled(enabled: boolean) {
			if (disposed) return
			lyricTitleEnabled = enabled
			PersistStatus.set('music.bluetoothLyrics', enabled)
			if (!enabled) restoreTitle()
		},
		dispose() {
			if (disposed) return
			disposed = true
			if (timer) clearInterval(timer)
			subscription?.remove()
			storage?.remove()
			appState?.remove()
			restoreTitle()
			onDispose()
		},
	}
}
