import myTrackPlayer from '@/helpers/trackPlayerIndex'
import { createMusicApiFromScript } from '@/helpers/userApi/importMusicSource'
import { isLxMusicScript, parseLxMusicScriptInfo } from '@/helpers/userApi/lxMusicSourceAdapter'
import { musicApiSelectedStore, musicApiStore, trackSourceLoadingStore } from '@/player/PlayerStore'
import PersistStatus from '@/store/PersistStatus'
import {
	withSourceRuntimeLock,
	loadResolverSource,
	isLxSource,
	releaseResolverRuntime,
	requestSourceUrl,
} from '@/player/sourceResolver/runtime'
import {
	RESOLUTION_PLATFORMS,
	resolvePlatformMusicInfo,
	type ResolutionPlatform,
} from '@/player/sourceResolver/platforms'
import type { SourceMusicApi } from './userApi/importMusicSource'

export function describeSourceChannels(source: SourceMusicApi) {
	return RESOLUTION_PLATFORMS.map((id) => {
		const capability = source.sources?.[id]
		let state: 'supported' | 'undeclared' | 'unsupported' = 'undeclared'
		if (capability === false || capability === null) state = 'unsupported'
		else if (capability && Array.isArray(capability.actions)) {
			state = capability.actions.includes('musicUrl') ? 'supported' : 'unsupported'
		}
		return {
			id,
			state,
			qualitys: capability && Array.isArray(capability.qualitys) ? capability.qualitys : [],
		}
	})
}

let testing = false

export function assertSourceIdle(message: string) {
	if (testing || trackSourceLoadingStore.getValue()) throw new Error(message)
}

export function saveSourceList(sources: IMusic.MusicApi[]) {
	musicApiStore.setValue(sources)
	PersistStatus.set('music.musicApi', sources)
}

async function parseManagedSource(script: string) {
	script = script.trim()
	if (!script) throw new Error('Source script is empty')
	let source: IMusic.MusicApi
	if (isLxMusicScript(script)) {
		// Import metadata without replacing the singleton used by playback.
		new Function(script)
		const info = parseLxMusicScriptInfo(script)
		const name = info.name || 'lx-music'
		const identity = JSON.stringify(['lxmusic', name, info.author || ''])
		let hash = 2166136261
		for (let i = 0; i < identity.length; i++)
			hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619)
		const existing = (musicApiStore.getValue() || []).find(
			(item) =>
				(item.scriptType === 'lxmusic' || isLxMusicScript(item.script || '')) &&
				item.name === name &&
				(item.author || '') === (info.author || ''),
		)
		source = {
			id: existing?.id || `lx_${(hash >>> 0).toString(16)}`,
			name,
			author: info.author,
			version: info.version,
			srcUrl: info.homepage,
			script,
			scriptType: 'lxmusic',
			platform: 'tx',
			isSelected: false,
			getMusicUrl: undefined,
		}
	} else {
		source = await createMusicApiFromScript(script)
		if (!source.id) source.id = `cymusic_${Date.now()}`
		if (!source.name) source.name = source.id
	}
	return source
}

export async function importManagedSource(script: string, busyMessage: string, importUrl?: string) {
	assertSourceIdle(busyMessage)
	const source = await parseManagedSource(script)
	assertSourceIdle(busyMessage)
	const existing = (musicApiStore.getValue() || []).find((item) => item.id === source.id)
	myTrackPlayer.addMusicApi({
		...source,
		enabled: existing?.enabled ?? true,
		...(importUrl || existing?.importUrl ? { importUrl: importUrl || existing?.importUrl } : {}),
	})
}

export async function fetchManagedSourceScript(url: string): Promise<string> {
	const target = new URL(url.trim())
	if (!['http:', 'https:'].includes(target.protocol)) throw new Error('HTTP(S) URL required')
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 15000)
	try {
		const response = await fetch(target.toString(), { signal: controller.signal })
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		return await response.text()
	} finally {
		clearTimeout(timer)
	}
}

export async function updateManagedSource(id: string, busyMessage: string) {
	assertSourceIdle(busyMessage)
	const original = (musicApiStore.getValue() || []).find((item) => item.id === id)
	if (typeof original?.importUrl !== 'string' || !original.importUrl.trim())
		throw new Error('Source has no import URL')
	const source = await parseManagedSource(await fetchManagedSourceScript(original.importUrl))
	assertSourceIdle(busyMessage)
	const latest = musicApiStore.getValue() || []
	if (latest.find((item) => item.id === id) !== original) throw new Error(busyMessage)
	saveSourceList(
		latest.map((item) =>
			item.id === id
				? {
						...item,
						...source,
						id,
						enabled: item.enabled,
						isSelected: item.isSelected,
						importUrl: original.importUrl,
					}
				: item,
		),
	)
	if (musicApiSelectedStore.getValue()?.id === id) await myTrackPlayer.setMusicApiAsSelectedById(id)
}

export type SourceChannelTestResult = {
	id: ResolutionPlatform
	state: 'supported' | 'unsupported' | 'failed' | 'undeclared'
	declaredState: 'supported' | 'unsupported' | 'undeclared'
	qualitys: string[]
	urlResolved: boolean
	playbackVerified: false
	failureStage?: 'initialization' | 'matching' | 'urlResolution'
	error?: string
}

// Test a fresh script instance, never persist its capabilities or result URLs.
export async function testSourceChannels(
	id: string,
	busyMessage: string,
	options: { item?: IMusic.IMusicItem; signal?: AbortSignal } = {},
): Promise<SourceChannelTestResult[]> {
	assertSourceIdle(busyMessage)
	const source =
		(musicApiStore.getValue() || []).find((api) => api.id === id) ??
		(musicApiSelectedStore.getValue()?.id === id ? musicApiSelectedStore.getValue() : null)
	if (!source) throw new Error('SOURCE_NOT_FOUND')
	testing = true
	try {
		return await withSourceRuntimeLock(async () => {
			if (trackSourceLoadingStore.getValue()) throw new Error(busyMessage)
			const selected = musicApiSelectedStore.getValue()
			const defaultItem = {
				id: '003aAYrm3GE0Ac',
				songmid: '003aAYrm3GE0Ac',
				platform: 'tx',
				title: '稻香',
				artist: '周杰伦',
				album: '魔杰座',
				duration: 223,
			} as IMusic.IMusicItem
			try {
				let loaded: SourceMusicApi
				try {
					if (options.signal?.aborted) throw new Error('SOURCE_CANCELLED')
					loaded = await loadResolverSource(source, true)
				} catch (error) {
					return describeSourceChannels(source).map((channel) => ({
						...channel,
						state: 'failed' as const,
						declaredState: channel.state,
						urlResolved: false,
						playbackVerified: false as const,
						failureStage: 'initialization' as const,
						error: error instanceof Error ? error.message : String(error),
					}))
				}
				const results: SourceChannelTestResult[] = []
				for (const channel of describeSourceChannels(loaded)) {
					const result: SourceChannelTestResult = {
						...channel,
						declaredState: channel.state,
						urlResolved: false,
						playbackVerified: false,
					}
					results.push(result)
					// Undeclared CommonJS keeps its historical TX invocation contract only.
					if (
						channel.state === 'unsupported' ||
						(channel.state === 'undeclared' && (channel.id !== 'tx' || isLxSource(loaded)))
					)
						continue
					const item =
						options.item ??
						(channel.id === 'wy'
							? ({
									id: '109998',
									songmid: '109998',
									platform: 'wy',
									title: '贝加尔湖畔',
									artist: '李健',
									album: '依然',
								} as IMusic.IMusicItem)
							: defaultItem)
					let failureStage: SourceChannelTestResult['failureStage'] = 'matching'
					try {
						const musicInfo = await resolvePlatformMusicInfo(item, channel.id, options.signal)
						failureStage = 'urlResolution'
						const quality = channel.qualitys.length
							? ['128k', '320k', 'flac'].find((q) => channel.qualitys.includes(q))
							: channel.state === 'undeclared'
								? '128k'
								: undefined
						if (!quality) throw new Error('NO_SUPPORTED_QUALITY')
						const value = await requestSourceUrl(
							loaded,
							item.title,
							item.artist,
							channel.id === 'tx' ? String(musicInfo.songmid) : '',
							quality,
							{ platform: channel.id, musicInfo, signal: options.signal, timeoutMs: 5000 },
						)
						const url = typeof value === 'string' ? value : value?.url
						if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url) || !new URL(url).hostname)
							throw new Error('INVALID_AUDIO_URL')
						result.urlResolved = true
					} catch (error) {
						result.state = 'failed'
						result.failureStage = failureStage
						result.error = error instanceof Error ? error.message : String(error)
					}
				}
				return results
			} finally {
				if (isLxSource(source)) {
					if (selected && isLxSource(selected)) {
						try {
							const restored = await loadResolverSource(selected)
							if (musicApiSelectedStore.getValue() === selected)
								musicApiSelectedStore.setValue(restored)
						} catch {
							releaseResolverRuntime()
						}
					} else releaseResolverRuntime()
				}
			}
		})
	} finally {
		testing = false
	}
}

export async function testCurrentSource(
	id: string,
	messages: { busy: string; currentOnly: string },
) {
	assertSourceIdle(messages.busy)
	if (musicApiSelectedStore.getValue()?.id !== id) throw new Error(messages.currentOnly)
	const results = await testSourceChannels(id, messages.busy)
	if (!results.some((result) => result.urlResolved))
		throw new Error(results.find((result) => result.error)?.error || 'Invalid audio URL')
	return results
}
