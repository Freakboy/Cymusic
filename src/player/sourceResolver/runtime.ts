import {
	disposeLxMusicScript,
	isLxMusicScript,
	reloadLxMusicScript,
} from '@/helpers/userApi/lxMusicSourceAdapter'
import type { ModuleExports, SourceMusicApi } from '@/helpers/userApi/importMusicSource'
import type { SourceRequestContext } from './platforms'

const queue: { priority: number; run: () => Promise<void> }[] = []
let running = false

// A caller timing out must not release the singleton while its script still runs.
export function withSourceRuntimeLock<T>(
	task: () => Promise<T>,
	requestType: 'current' | 'preload' = 'current',
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		queue.push({
			priority: requestType === 'current' ? 0 : 1,
			run: async () => {
				try {
					resolve(await task())
				} catch (error) {
					reject(error)
				}
			},
		})
		void drain()
	})
}

async function drain() {
	if (running) return
	running = true
	try {
		while (queue.length) {
			queue.sort((a, b) => a.priority - b.priority)
			await queue.shift()!.run()
		}
	} finally {
		running = false
	}
}

export const isLxSource = (api: IMusic.MusicApi) =>
	api.scriptType === 'lxmusic' || isLxMusicScript(api.script || '')

// Only invoke under withSourceRuntimeLock, including user-driven source reloads.
export async function loadResolverSource(
	api: IMusic.MusicApi,
	reload = false,
): Promise<SourceMusicApi> {
	if (isLxSource(api)) return reloadLxMusicScript(api)
	if (!reload && typeof api.getMusicUrl === 'function') return api
	const module = { exports: {} as ModuleExports }
	new Function('module', 'exports', 'require', api.script)(module, module.exports, () => {})
	if (typeof module.exports.getMusicUrl !== 'function') throw new Error('INVALID_SOURCE_SCRIPT')
	return {
		...api,
		getMusicUrl: module.exports.getMusicUrl,
		getLyric: typeof module.exports.getLyric === 'function' ? module.exports.getLyric : undefined,
		sources: module.exports.sources,
	}
}

export function releaseResolverRuntime() {
	disposeLxMusicScript()
}

// CommonJS has no native singleton to retire. Bound a stuck plugin promise so
// cancellation cannot strand the runtime queue; observe late rejection via race.
export async function requestSourceUrl(
	api: SourceMusicApi,
	title: string,
	artist: string,
	qqmid: string,
	quality: string,
	context: SourceRequestContext,
) {
	if (context.signal?.aborted) throw new Error('SOURCE_CANCELLED')
	if (isLxSource(api)) return api.getMusicUrl(title, artist, qqmid, quality, context)
	let timer: ReturnType<typeof setTimeout> | undefined
	let abort: (() => void) | undefined
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				if (context.signal?.aborted) throw new Error('SOURCE_CANCELLED')
				return api.getMusicUrl(title, artist, qqmid, quality, context)
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('SOURCE_REQUEST_TIMEOUT')),
					context.timeoutMs ?? 5000,
				)
				abort = () => reject(new Error('SOURCE_CANCELLED'))
				context.signal?.addEventListener('abort', abort, { once: true })
				if (context.signal?.aborted) abort()
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
		if (abort) context.signal?.removeEventListener('abort', abort)
	}
}
