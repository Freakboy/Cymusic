import myTrackPlayer from '@/helpers/trackPlayerIndex'
import { createMusicApiFromScript } from '@/helpers/userApi/importMusicSource'
import { isLxMusicScript, parseLxMusicScriptInfo } from '@/helpers/userApi/lxMusicSourceAdapter'
import { musicApiSelectedStore, musicApiStore, trackSourceLoadingStore } from '@/player/PlayerStore'
import PersistStatus from '@/store/PersistStatus'
import { withSourceRuntimeLock } from '@/player/MusicSourceResolver'
import type { SourceMusicApi } from './userApi/importMusicSource'

export function describeSourceChannels(source: SourceMusicApi) {
	return (['tx', 'wy', 'kg', 'kw', 'mg'] as const).map((id) => {
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

export async function testCurrentSource(
	id: string,
	messages: { busy: string; currentOnly: string },
) {
	assertSourceIdle(messages.busy)
	const source = musicApiSelectedStore.getValue()
	if (source?.id !== id || typeof source.getMusicUrl !== 'function')
		throw new Error(messages.currentOnly)
	testing = true
	let timer: ReturnType<typeof setTimeout> | undefined
	// A timeout cannot cancel arbitrary CommonJS promises. Keep the serial lock
	// until the actual resolver settles, even after the UI reports a timeout.
	const request = withSourceRuntimeLock(async () => {
		if (musicApiSelectedStore.getValue()?.id !== id || trackSourceLoadingStore.getValue())
			throw new Error(messages.busy)
		return musicApiSelectedStore.getValue().getMusicUrl('稻香', '周杰伦', '004IArbh3ytHgR', '128k')
	}).finally(() => {
		testing = false
	})
	try {
		const url = await Promise.race([
			request,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('URL resolver timeout (15s)')), 15000)
			}),
		])
		if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url))
			throw new Error('Invalid audio URL')
		const parsed = new URL(url)
		if (!parsed.hostname) throw new Error('Invalid audio URL')
	} finally {
		if (timer) clearTimeout(timer)
	}
}
