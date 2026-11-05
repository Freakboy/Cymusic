import {
	disposeLxMusicScript,
	isLxMusicScript,
	reloadLxMusicScript,
} from '@/helpers/userApi/lxMusicSourceAdapter'

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
export async function loadResolverSource(api: IMusic.MusicApi): Promise<IMusic.MusicApi> {
	if (isLxSource(api)) return reloadLxMusicScript(api)
	if (typeof api.getMusicUrl === 'function') return api
	const module = { exports: {} as { getMusicUrl?: IMusic.MusicApi['getMusicUrl'] } }
	new Function('module', 'exports', 'require', api.script)(module, module.exports, () => {})
	if (typeof module.exports.getMusicUrl !== 'function') throw new Error('INVALID_SOURCE_SCRIPT')
	return { ...api, getMusicUrl: module.exports.getMusicUrl }
}

export function releaseResolverRuntime() {
	disposeLxMusicScript()
}
