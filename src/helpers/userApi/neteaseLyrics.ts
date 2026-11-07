export type NeteaseLyricResult = {
	lyric: string
	tlyric: string
	status: 'available' | 'instrumental' | 'unavailable' | 'error'
	retryable?: boolean
}

const cache = new Map<string, { expires: number; result: NeteaseLyricResult }>()
const pending = new Map<string, Promise<NeteaseLyricResult>>()
const errorResult = (retryable: boolean): NeteaseLyricResult => ({
	lyric: '', tlyric: '', status: 'error', retryable,
})

export function isNeteaseLyricsPlatform(platform: unknown): boolean {
	return typeof platform === 'string' && ['netease', 'wy', '163'].includes(platform.trim().toLowerCase())
}

function cleanLyric(value: unknown): string {
	if (typeof value !== 'string') return ''
	return value.split(/\r?\n/).filter((line) => {
		if (!line.trim().startsWith('{')) return true
		try {
			const metadata = JSON.parse(line)
			return !(typeof metadata.t === 'number' && Array.isArray(metadata.c))
		} catch {
			return true
		}
	}).join('\n').trim()
}

function yrcToLrc(value: unknown): string {
	const lines: string[] = []
	for (const line of cleanLyric(value).split('\n')) {
		const match = /^\[(\d+),(\d+)\](\(\d+,\d+,\d+\).*)$/.exec(line.trim())
		if (!match) continue
		const start = Number(match[1])
		const duration = Number(match[2])
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(duration) ||
			!Number.isSafeInteger(start + duration)) continue
		let valid = true
		const text = match[3].replace(/\((\d+),(\d+),(\d+)\)/g, (_tag, time, length, flag) => {
			if (![time, length, flag].every((part) => Number.isSafeInteger(Number(part))) ||
				!Number.isSafeInteger(Number(time) + Number(length))) valid = false
			return ''
		}).trim()
		// Reject leftover timing/metadata tags, but retain ordinary lyric parentheses.
		if (!valid || !text || /\[[^\]]*\]|\([^()]*,[^()]*\)/.test(text)) continue
		const minutes = String(Math.floor(start / 60000)).padStart(2, '0')
		const seconds = String(Math.floor(start / 1000) % 60).padStart(2, '0')
		const milliseconds = String(start % 1000).padStart(3, '0')
		lines.push(`[${minutes}:${seconds}.${milliseconds}]${text}`)
	}
	return lines.join('\n')
}

function parseLyrics(data: any): NeteaseLyricResult {
	if (data?.code !== 200) {
		return errorResult(typeof data?.code !== 'number' || data.code === 408 || data.code === 429 || data.code >= 500)
	}
	if (data.nolyric === true || data.pureMusic === true) {
		return { lyric: '', tlyric: '', status: 'instrumental' }
	}
	if (data.uncollected === true) return { lyric: '', tlyric: '', status: 'unavailable' }
	// Preserve line lyrics; only structured YRC can supply exact fallback timestamps.
	const lyric = [data.lrc?.lyric, data.lyric]
		.map(cleanLyric).find((text) => text.replace(/\[[^\]]*\]/g, '').trim()) || yrcToLrc(data.yrc?.lyric)
	if (!lyric) return errorResult(true)
	return { lyric, tlyric: cleanLyric(data.tlyric?.lyric), status: 'available' }
}

async function requestLyrics(id: string): Promise<NeteaseLyricResult> {
	const deadline = Date.now() + 6000
	let result = errorResult(true)
	for (const endpoint of ['song/lyric/v1', 'song/lyric']) {
		const remaining = deadline - Date.now()
		if (remaining <= 0) break
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			// The race also bounds body parsing and fetch implementations that ignore abort.
			const timeout = new Promise<NeteaseLyricResult>((resolve) => {
				timer = setTimeout(() => {
					controller.abort()
					resolve(errorResult(true))
				}, Math.min(3000, remaining))
			})
			const work = (async () => {
				const response = await fetch(
					`https://music.163.com/api/${endpoint}?id=${id}&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1`,
					{ signal: controller.signal, credentials: 'omit' },
				)
				if (!response.ok) return errorResult(response.status === 408 || response.status === 429 || response.status >= 500)
				return parseLyrics(await response.json())
			})()
			result = await Promise.race([work, timeout])
		} catch {
			result = errorResult(true)
		} finally {
			clearTimeout(timer)
		}
		if (result.status !== 'error' || !result.retryable) break
	}
	if (result.status !== 'error') {
		const now = Date.now()
		for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key)
		cache.delete(id)
		if (cache.size >= 128) cache.delete(cache.keys().next().value!)
		cache.set(id, { expires: now + (result.status === 'available' ? 600000 : 30000), result })
	}
	return result
}

// Callers retain their generation guards. Shared work has no caller-owned signal,
// so one screen leaving cannot cancel another screen's request for the same ID.
export async function getNeteaseLyrics(id: unknown): Promise<NeteaseLyricResult> {
	if ((typeof id !== 'string' && typeof id !== 'number') ||
		!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) return errorResult(false)
	const key = String(id)
	const cached = cache.get(key)
	if (cached && cached.expires > Date.now()) return { ...cached.result }
	let task = pending.get(key)
	if (!task) {
		task = requestLyrics(key).finally(() => pending.delete(key))
		pending.set(key, task)
	}
	return { ...await task }
}
