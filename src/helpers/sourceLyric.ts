import { musicApiSelectedStore } from '@/player/PlayerStore'
import {
	isLxSource,
	loadResolverSource,
	withSourceRuntimeLock,
} from '@/player/sourceResolver/runtime'
import type { SourceMusicApi } from './userApi/importMusicSource'
import LyricParser from '@/utils/lrcParser'

export type SourceLyric = { lyric: string; tlyric: string }

export function normalizeSourceLyric(value: unknown): SourceLyric | null {
	if (typeof value === 'string') return value.trim() ? { lyric: value, tlyric: '' } : null
	if (!value || typeof value !== 'object') return null
	const data = value as Record<string, unknown>
	const lyric =
		[data.lyric, data.rawLrc].find(
			(text): text is string => typeof text === 'string' && !!text.trim(),
		) || ''
	const tlyric =
		[data.tlyric, data.translation].find(
			(text): text is string => typeof text === 'string' && !!text.trim(),
		) || ''
	return lyric || tlyric ? { lyric, tlyric } : null
}

export function mergeSourceLyric(
	source: SourceLyric | null,
	platform: SourceLyric | null,
): SourceLyric | null {
	if (!source) return platform
	const lyric = source.lyric || platform?.lyric || ''
	const tlyric = source.tlyric || platform?.tlyric || ''
	if (!lyric || !tlyric || !platform || (source.lyric && source.tlyric)) return { lyric, tlyric }
	const target = new LyricParser({ rawLrc: lyric }).getLyric()
	const originals = new LyricParser({ rawLrc: platform.lyric }).getLyric()
	const translations = new LyricParser({ rawLrc: tlyric }).getLyric()
	const normalize = (text: string) =>
		text
			.normalize('NFKC')
			.toLowerCase()
			.replace(/[\s\p{P}\p{S}]/gu, '')
	let cursor = 0
	const aligned = target.map((line) => {
		let time = line.time
		if (source.lyric) {
			// Cross-source timestamps can differ. Match original text in order before
			// moving the platform translation onto the source's untouched timeline.
			const index = originals.findIndex(
				(original, index) =>
					index >= cursor &&
					!!normalize(line.lrc) &&
					normalize(original.lrc) === normalize(line.lrc),
			)
			if (index < 0) return ''
			cursor = index + 1
			time = originals[index].time
		}
		return translations.find((translation) => Math.abs(translation.time - time) < 0.01)?.lrc || ''
	})
	if (!aligned.some((text) => text.trim())) {
		// Do not pair unrelated platform translations with source originals.
		return { lyric, tlyric: source.lyric ? '' : tlyric }
	}
	return {
		lyric,
		// The UI pairs by index, so retain blank entries for unmatched source lines.
		tlyric: target
			.map(
				(line, index) =>
					`[${Math.floor(line.time / 60)}:${(line.time % 60).toFixed(3)}]${aligned[index] || ' '}`,
			)
			.join('\n'),
	}
}

// A null result asks the caller to use platform lyrics. isCurrent must include
// the caller's lyric request token; this helper never writes player lyric state.
export async function fetchSourceLyric(
	item: Pick<IMusic.IMusicItem, 'title' | 'artist' | 'songmid'>,
	isCurrent: () => boolean,
	timeoutMs = 5000,
): Promise<SourceLyric | null> {
	const source = musicApiSelectedStore.getValue() as SourceMusicApi | null
	if (!source || source.enabled === false || !item.songmid || !isCurrent()) return null
	let expired = false
	const current = () => !expired && isCurrent() && musicApiSelectedStore.getValue() === source
	let timer: ReturnType<typeof setTimeout> | undefined
	// Keep ownership until the actual plugin promise settles, even if the UI times out.
	const request = withSourceRuntimeLock(async () => {
		if (!current()) return null
		// CommonJS selection reloads can retain old optional closures. Rebuild from
		// the current script here, under the same lock as playback, after persistence too.
		const loaded = isLxSource(source) ? source : await loadResolverSource(source, true)
		if (!current() || typeof loaded.getLyric !== 'function') return null
		const lyric = normalizeSourceLyric(await loaded.getLyric(item.title, item.artist, item.songmid))
		return current() ? lyric : null
	})
	try {
		return await Promise.race([
			request,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => {
					expired = true
					resolve(null)
				}, timeoutMs)
			}),
		])
	} catch {
		return null
	} finally {
		if (timer) clearTimeout(timer)
	}
}
