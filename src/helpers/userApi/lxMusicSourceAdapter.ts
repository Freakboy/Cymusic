/**
 * lx-music 音源脚本适配器
 *
 * 使用 Cymusic 已有的 UserApiModule 原生模块（JavaScriptCore 引擎）执行 lx-music 脚本，
 * 将其事件通信机制包装为 Cymusic 的 getMusicUrl 函数。
 */

import type {
	RequestParams,
	SendResponseParams,
	ResponseParams,
} from '@/components/utils/nativeModules/userApi'
import {
	destroy,
	loadScript,
	onScriptAction,
	sendAction
} from '@/components/utils/nativeModules/userApi'
import { Buffer } from 'buffer'
import { logError, logInfo } from '../logger'
import type { SourceCapabilities, SourceMusicApi } from './importMusicSource'
import type { SourceRequestContext } from '@/player/sourceResolver/platforms'

const RESOLUTION_PLATFORMS = ['tx', 'wy', 'kg', 'kw', 'mg'] as const

// ============================================================
// 格式检测
// ============================================================

export const isLxMusicScript = (script: string): boolean => {
	const hasHeader = /^\/\*[\s\S]+?\*\//.test(script.trim())
	if (!hasHeader) return false
	const hasLxApi =
		/\bEVENT_NAMES\b/.test(script) ||
		/\blx\s*\.\s*(on|send)\b/.test(script) ||
		/\blxu?\s*\.\s*(on|send|request|EVENT_NAMES)\b/.test(script) ||
		/\bglobalThis\s*\.\s*lx/.test(script)
	const isCymusicFormat = /module\s*\.\s*exports\s*\.\s*getMusicUrl/.test(script)
	return hasLxApi && !isCymusicFormat
}

// ============================================================
// 元信息解析
// ============================================================

const INFO_NAMES = {
	name: 24,
	description: 256,
	author: 56,
	homepage: 1024,
	version: 36,
} as const

type InfoKeys = keyof typeof INFO_NAMES

export const parseLxMusicScriptInfo = (
	script: string,
): Record<InfoKeys, string> => {
	const headerMatch = /^\/\*[\s\S]+?\*\//.exec(script.trim())
	const infos: Partial<Record<InfoKeys, string>> = {}

	if (headerMatch) {
		const lines = headerMatch[0].split(/\r?\n/)
		const rxp = /^\s?\*\s?@(\w+)\s(.+)$/
		for (const line of lines) {
			const result = rxp.exec(line)
			if (!result) continue
			const key = result[1] as InfoKeys
			if (INFO_NAMES[key] == null) continue
			infos[key] = result[2].trim()
		}
	}

	for (const [key, maxLen] of Object.entries(INFO_NAMES) as Array<
		[InfoKeys, number]
	>) {
		infos[key] ||= ''
		if (infos[key]!.length > maxLen)
			infos[key] = infos[key]!.substring(0, maxLen) + '...'
	}

	return infos as Record<InfoKeys, string>
}

// ============================================================
// JavaScriptCore 原生模块桥接
// ============================================================

type LxRequestType = 'current' | 'preload'

type LxRequestContext = SourceRequestContext

type PendingRequest = {
	resolve: (result: unknown) => void
	action: 'musicUrl' | 'lyric'
	reject: (err: Error) => void
	requestKey: string
	requestType: LxRequestType
}

type SettledRequest = {
	requestKey: string
	requestType: LxRequestType
	timeout: ReturnType<typeof setTimeout>
}

type HttpRequest = {
	controller: AbortController
	timeout: ReturnType<typeof setTimeout> | null
	parentRequestKey?: string
}

type LxRuntime = {
	pendingRequests: Map<string, PendingRequest>
	settledRequestTypes: Map<string, SettledRequest>
	pendingHttpRequests: Map<string, HttpRequest>
	inited: boolean
	sources?: SourceCapabilities
	disposed: boolean
	init: { resolve: () => void, reject: (err: Error) => void } | null
	removeListener: (() => void) | null
}

let activeRuntime: LxRuntime | null = null
let nextRequestId = 0

const isActiveRuntime = (runtime: LxRuntime) => activeRuntime === runtime && !runtime.disposed

const retireRuntime = (runtime: LxRuntime, error: Error) => {
	if (runtime.disposed) return
	runtime.disposed = true
	runtime.inited = false
	if (activeRuntime === runtime) activeRuntime = null
	runtime.init?.reject(error)
	for (const request of runtime.pendingRequests.values()) request.reject(error)
	runtime.pendingRequests.clear()
	for (const request of runtime.settledRequestTypes.values()) clearTimeout(request.timeout)
	runtime.settledRequestTypes.clear()
	for (const request of runtime.pendingHttpRequests.values()) {
		if (request.timeout !== null) clearTimeout(request.timeout)
		request.controller.abort()
	}
	runtime.pendingHttpRequests.clear()
	runtime.removeListener?.()
	runtime.removeListener = null
}

const failRuntime = (runtime: LxRuntime, error: Error) => {
	if (!isActiveRuntime(runtime)) return
	retireRuntime(runtime, error)
	destroy()
}

// Native facade destruction invokes the same per-load cleanup callback. Keeping
// the import one-way avoids a facade/adapter cycle and does not add a second bus.
export const disposeLxMusicScript = () => {
	if (activeRuntime) destroy()
}

const getLxRequestLogPrefix = (
	requestType: LxRequestType | 'unknown',
	requestKey: string,
) => `[lxMusicAdapter][${requestType}][requestKey=${requestKey}]`

const rememberSettledRequestType = (
	runtime: LxRuntime,
	wireRequestKey: string,
	request: PendingRequest,
) => {
	const settled: SettledRequest = {
		requestKey: request.requestKey,
		requestType: request.requestType,
		timeout: setTimeout(() => {
			if (runtime.settledRequestTypes.get(wireRequestKey) === settled) {
				runtime.settledRequestTypes.delete(wireRequestKey)
			}
		}, 30000),
	}
	runtime.settledRequestTypes.set(wireRequestKey, settled)
}

const shouldLogScriptAction = (runtime: LxRuntime, event: any) => {
	if (event.action !== 'response') return true
	const data = event.data as ResponseParams
	const pending = runtime.pendingRequests.get(data.requestKey)
	const requestType = pending?.requestType ?? runtime.settledRequestTypes.get(data.requestKey)?.requestType
	return !(requestType === 'preload' && (!data.status || !pending))
}

const formatScriptActionLog = (runtime: LxRuntime, event: any) => {
	switch (event.action) {
		case 'request': {
			const data = event.data as RequestParams
			const parentPending = data.parentRequestKey
				? runtime.pendingRequests.get(data.parentRequestKey)
				: null
			const requestType = data.requestType ?? parentPending?.requestType
			const requestTypeLabel = requestType ? `[${requestType}]` : ''
			const parentRequestKeyLabel = data.parentRequestKey
				? `[parentRequestKey=${data.parentRequestKey}]`
				: ''
			const httpRequestKeyLabel = data.requestKey
				? `[httpRequestKey=${data.requestKey}]`
				: ''
			return `[lxMusicAdapter] Script action: request${requestTypeLabel}${parentRequestKeyLabel}${httpRequestKeyLabel}`
		}
		case 'response': {
			const data = event.data as ResponseParams
			const pending = runtime.pendingRequests.get(data.requestKey)
			const requestType = pending?.requestType ?? runtime.settledRequestTypes.get(data.requestKey)?.requestType
			const requestTypeLabel = requestType
				? `[${requestType}]`
				: ''
			const businessKey = pending?.requestKey ?? runtime.settledRequestTypes.get(data.requestKey)?.requestKey ?? data.requestKey
			const requestKeyLabel = businessKey
				? `[requestKey=${businessKey}]`
				: ''
			return `[lxMusicAdapter] Script action: response${requestTypeLabel}${requestKeyLabel}`
		}
		default:
			return `[lxMusicAdapter] Script action: ${event.action}`
	}
}

/**
 * 处理来自 JavaScriptCore 脚本的事件
 */
const handleScriptAction = (runtime: LxRuntime, event: any) => {
	if (!isActiveRuntime(runtime)) return
	if (shouldLogScriptAction(runtime, event)) {
		logInfo(formatScriptActionLog(runtime, event))
	}

	switch (event.action) {
		case 'init': {
			if (runtime.inited) break
			// 脚本初始化完成
			const data = event.data
			if (data.status) {
				runtime.sources = Object.fromEntries(RESOLUTION_PLATFORMS.filter(source => {
					const capability = data.info?.sources?.[source]
					return capability?.type === 'music' && Array.isArray(capability.actions) && Array.isArray(capability.qualitys)
				}).map(source => [source, data.info.sources[source]]))
				logInfo('[lxMusicAdapter] Script initialized successfully')
				runtime.inited = true
				runtime.init?.resolve()
			} else {
				logError(
					`[lxMusicAdapter] Script init failed: ${data.errorMessage || 'unknown'}`,
				)
				failRuntime(runtime,
					new Error(data.errorMessage || 'Script init failed'),
				)
			}
			break
		}

		case 'request': {
			// 脚本发起 HTTP 请求 — 我们在 JS-land 代理执行
			const reqData = event.data as RequestParams
			void handleHttpRequest(runtime, reqData)
			break
		}

		case 'cancelRequest': {
			// 脚本取消 HTTP 请求
			const requestKey = event.data as string
			abortHttpRequest(runtime, requestKey)
			break
		}

		case 'response': {
			// 脚本返回 musicUrl/lyric/pic 响应
			const respData = event.data as ResponseParams
			const pending = runtime.pendingRequests.get(respData.requestKey)
			if (pending) {
				const logPrefix = getLxRequestLogPrefix(
					pending.requestType,
					pending.requestKey,
				)
				if (respData.status) {
					const result = respData.result as any
					if (result?.action !== pending.action) {
						pending.reject(new Error('Script returned unexpected response action'))
					} else if (result.action === 'musicUrl') {
						const url = result?.data?.url
						if (typeof url === 'string' && /^https?:/.test(url)) {
							logInfo(`${logPrefix} musicUrl resolved: ${url}`)
							pending.resolve(result.data.headers || result.data.userAgent ? result.data : url)
						} else {
							pending.reject(new Error('Script returned invalid musicUrl'))
						}
					} else {
						pending.resolve(result.data)
					}
				} else {
					if (pending.requestType === 'current') {
						logError(
							`${logPrefix} Script response error: ${respData.errorMessage || 'unknown'}`,
						)
					}
					pending.reject(
						new Error(respData.errorMessage || 'Script returned error'),
					)
				}
			}
			const settled = runtime.settledRequestTypes.get(respData.requestKey)
			if (settled) clearTimeout(settled.timeout)
			runtime.settledRequestTypes.delete(respData.requestKey)
			break
		}

		case 'log': {
			logInfo(`[lxMusicScript] ${event.data}`)
			break
		}

		default:
			logInfo(
				`[lxMusicAdapter] Unhandled action: ${event.action}`,
			)
	}
}

const finishHttpRequest = (
	runtime: LxRuntime,
	requestKey: string,
	request: HttpRequest,
	result: SendResponseParams,
) => {
	if (runtime.pendingHttpRequests.get(requestKey) !== request) return
	if (request.timeout !== null) clearTimeout(request.timeout)
	runtime.pendingHttpRequests.delete(requestKey)
	if (isActiveRuntime(runtime)) sendAction('response', result)
}

const abortHttpRequest = (runtime: LxRuntime, requestKey: string, expected?: HttpRequest) => {
	const request = runtime.pendingHttpRequests.get(requestKey)
	if (!request || (expected && request !== expected)) return
	request.controller.abort()
	const reason: unknown = request.controller.signal.reason
	finishHttpRequest(runtime, requestKey, request, {
		requestKey,
		error: reason instanceof Error ? reason.message : 'Aborted',
		response: null,
	})
}

/**
 * 代理执行 HTTP 请求（脚本在 JavaScriptCore 中发起，由 JS-land fetch 执行）
 */
const handleHttpRequest = async (runtime: LxRuntime, reqData: RequestParams) => {
	const { requestKey, url, options } = reqData
	// No parent is valid during initialization. A supplied parent must still own
	// a live business request, including HTTP emitted after timeout/cancellation.
	if (reqData.parentRequestKey != null && !runtime.pendingRequests.has(reqData.parentRequestKey)) {
		sendAction('response', { requestKey, error: 'SOURCE_REQUEST_SETTLED', response: null })
		return
	}
	const previous = runtime.pendingHttpRequests.get(requestKey)
	if (previous) {
		if (previous.timeout !== null) clearTimeout(previous.timeout)
		previous.controller.abort()
	}
	const controller = new AbortController()
	const request: HttpRequest = { controller, timeout: null, parentRequestKey: reqData.parentRequestKey }
	runtime.pendingHttpRequests.set(requestKey, request)
	const timeoutMs = Number.isFinite(options.timeout) && options.timeout > 0 ? Math.min(options.timeout, 60000) : 15000
	request.timeout = setTimeout(() => abortHttpRequest(runtime, requestKey, request), timeoutMs)

	try {
		const fetchOptions: RequestInit = {
			method: options.method || 'GET',
			headers: options.headers || {},
			signal: controller.signal,
		}

		const headers = (fetchOptions.headers || {}) as Record<string, string>
		const method = String(fetchOptions.method || 'GET').toUpperCase()
		const optionsAny = options as any
		const data = optionsAny.body ?? optionsAny.data
		if (method != 'GET' && method != 'HEAD') {
			if (optionsAny.form && typeof optionsAny.form == 'object') {
				const params = new URLSearchParams()
				for (const [key, value] of Object.entries(optionsAny.form)) {
					params.append(key, String(value))
				}
				fetchOptions.body = params.toString()
				if (!headers['Content-Type'] && !headers['content-type']) {
					headers['Content-Type'] = 'application/x-www-form-urlencoded'
				}
			} else if (optionsAny.formData != null) {
				fetchOptions.body = optionsAny.formData
			} else if (data != null) {
				fetchOptions.body = typeof data == 'string' ? data : JSON.stringify(data)
			}
		}

		const response = await fetch(url, fetchOptions)

		let body: any
		const contentType = response.headers.get('content-type') || ''
		if (options.binary) {
			// 二进制响应 — 转为 base64
			const buffer = await response.arrayBuffer()
			body = Buffer.from(buffer).toString('base64')
		} else {
			const text = await response.text()
			if (contentType.includes('json')) {
				try {
					body = JSON.parse(text)
				} catch {
					body = text
				}
			} else {
				body = text
			}
		}

		const headerObj: Record<string, string> = {}
		response.headers.forEach((value: string, key: string) => {
			headerObj[key] = value
		})

		finishHttpRequest(runtime, requestKey, request, {
			requestKey,
			error: null,
			response: {
				statusCode: response.status,
				statusMessage: response.statusText,
				headers: headerObj,
				body,
			},
		})
	} catch (err) {
		finishHttpRequest(runtime, requestKey, request, {
			requestKey,
			error: err instanceof Error ? err.message : String(err),
			response: null,
		})
	} finally {
		if (request.timeout !== null) clearTimeout(request.timeout)
		if (runtime.pendingHttpRequests.get(requestKey) === request) {
			runtime.pendingHttpRequests.delete(requestKey)
		}
	}
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 初始化 lx-music 脚本到 JavaScriptCore 引擎
 */
const initLxMusicScript = (
	scriptId: string,
	info: Record<string, string>,
	script: string,
): Promise<LxRuntime> => {
	const runtime: LxRuntime = {
		pendingRequests: new Map(),
		settledRequestTypes: new Map(),
		pendingHttpRequests: new Map(),
		inited: false,
		disposed: false,
		init: null,
		removeListener: null,
	}
	activeRuntime = runtime

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			failRuntime(runtime, new Error('脚本初始化超时'))
		}, 10000)
		const init = {
			resolve: () => {
				if (runtime.init !== init) return
				runtime.init = null
				clearTimeout(timeout)
				resolve(runtime)
			},
			reject: (error: Error) => {
				if (runtime.init !== init) return
				runtime.init = null
				clearTimeout(timeout)
				reject(error)
			},
		}
		runtime.init = init

		try {
			runtime.removeListener = onScriptAction(event => handleScriptAction(runtime, event))
			loadScript({
				id: scriptId,
				name: info.name || 'lx-music 音源',
				description: info.description || '',
				version: info.version || '',
				author: info.author || '',
				homepage: info.homepage || '',
				script,
				allowShowUpdateAlert: false,
			}, () => retireRuntime(runtime, new Error('音源脚本已替换或销毁')))
		} catch (error) {
			failRuntime(runtime, error instanceof Error ? error : new Error(String(error)))
		}
	})
}

/**
 * 通过 JavaScriptCore 脚本请求音乐 URL 或歌词
 */
const requestViaScript = <T = string>(
	runtime: LxRuntime,
	title: string,
	artist: string,
	songmid: string,
	quality: string,
	requestContext?: LxRequestContext,
	action: 'musicUrl' | 'lyric' = 'musicUrl',
): Promise<T> => {
	return new Promise((resolve, reject) => {
		if (!isActiveRuntime(runtime) || !runtime.inited) {
			reject(new Error('音源脚本未初始化或已销毁'))
			return
		}
		const platform = requestContext?.platform ?? 'tx'
		const capability = runtime.sources?.[platform]
		if (!capability || !capability.actions?.includes(action) || (action === 'musicUrl' && !capability.qualitys?.includes(quality))) {
			reject(new Error(`${platform} ${action}/${quality} is not supported by this source`))
			return
		}
		if (platform !== 'tx' && requestContext?.musicInfo?.source !== platform) {
			reject(new Error('PLATFORM_MUSIC_INFO_REQUIRED'))
			return
		}
		const signal = requestContext?.signal
		if (signal?.aborted) {
			reject(new Error('SOURCE_CANCELLED'))
			return
		}
		const requestType = requestContext?.requestType ?? 'current'
		const requestKey =
			requestContext?.requestKey ??
			`req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
		// A quality retry may reuse its business key while the previous attempt is
		// still completing. Only the envelope uses this unique correlation key.
		const wireRequestKey = `${requestKey}#${++nextRequestId}`
		const logPrefix = getLxRequestLogPrefix(requestType, requestKey)
		const timeoutMs = requestContext?.timeoutMs ?? 15000

		const timeout = setTimeout(() => {
			if (runtime.pendingRequests.get(wireRequestKey) !== pending) return
			pending.reject(new Error(`${action} request timeout`))
			rememberSettledRequestType(runtime, wireRequestKey, pending)
		}, timeoutMs)
		const abort = () => pending.reject(new Error('SOURCE_CANCELLED'))

		const pending: PendingRequest = {
			resolve: (result: unknown) => {
				if (runtime.pendingRequests.get(wireRequestKey) !== pending) return
				runtime.pendingRequests.delete(wireRequestKey)
				clearTimeout(timeout)
				signal?.removeEventListener('abort', abort)
				resolve(result as T)
			},
			reject: (err: Error) => {
				if (runtime.pendingRequests.get(wireRequestKey) !== pending) return
				runtime.pendingRequests.delete(wireRequestKey)
				clearTimeout(timeout)
				signal?.removeEventListener('abort', abort)
				reject(err)
				for (const [key, request] of runtime.pendingHttpRequests) {
					if (request.parentRequestKey === wireRequestKey) abortHttpRequest(runtime, key, request)
				}
			},
			requestKey,
			requestType,
			action,
		}
		runtime.pendingRequests.set(wireRequestKey, pending)
		signal?.addEventListener('abort', abort, { once: true })

		logInfo(`${logPrefix} Sending ${action} request: ${title} - ${artist}`)

		// 向 JavaScriptCore 脚本发送请求
		try {
			sendAction('request', {
				requestKey: wireRequestKey,
				data: {
					action,
					source: platform,
					info: {
						musicInfo: requestContext?.musicInfo ?? {
							id: songmid,
							songmid,
							title,
							name: title,
							singer: artist,
							artist,
							source: 'tx',
						},
						requestContext: {
							requestKey,
							requestType,
						},
						...(action === 'musicUrl' ? { type: quality || '128k' } : {}),
					},
				},
			} as any)
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)))
		}
	})
}

const runtimeMethods = (runtime: LxRuntime) => {
	const tx = runtime.sources?.tx
	return {
		sources: runtime.sources,
		getMusicUrl: (title: string, artist: string, songmid: string, quality: string,
			requestContext?: LxRequestContext) =>
			requestViaScript(runtime, title, artist, songmid, quality, requestContext),
		getLyric: tx && tx.actions?.includes('lyric')
			? (title: string, artist: string, songmid: string, context?: LxRequestContext) =>
				requestViaScript<unknown>(runtime, title, artist, songmid, '', context, 'lyric')
			: undefined,
	}
}

/**
 * 将 lx-music 格式脚本适配为 Cymusic 的 MusicApi 对象
 */
export const adaptLxMusicScript = async (
	script: string,
): Promise<SourceMusicApi> => {
	const info = parseLxMusicScriptInfo(script)

	const scriptId = info.name
		? `lx_${info.name.replace(/\s+/g, '_')}_${Date.now()}`
		: `lx_api_${Date.now()}`

	// 初始化脚本到 JavaScriptCore
	const runtime = await initLxMusicScript(scriptId, info, script)

	logInfo(`[lxMusicAdapter] Script loaded successfully: ${info.name}`)

	const musicApi: SourceMusicApi = {
		id: scriptId,
		platform: 'tx',
		author: info.author || '',
		name: info.name || 'lx-music 音源',
		version: info.version || '',
		srcUrl: info.homepage || '',
		script: script,
		scriptType: 'lxmusic' as const,
		isSelected: false,
		...runtimeMethods(runtime),
	}

	return musicApi
}

/**
 * 重新加载 lx-music 脚本（从保存的 script 重建）
 */
export const reloadLxMusicScript = async (
	musicApi: IMusic.MusicApi,
): Promise<SourceMusicApi> => {
	try {
		const info = parseLxMusicScriptInfo(musicApi.script)
		const runtime = await initLxMusicScript(musicApi.id, info, musicApi.script)

		return {
			...musicApi,
			scriptType: 'lxmusic',
			...runtimeMethods(runtime),
		}
	} catch (err) {
		logError(
			`[lxMusicAdapter] Failed to reload lx-music script "${musicApi.name}":`,
			err,
		)
		throw err
	}
}
