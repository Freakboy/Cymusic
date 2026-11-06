import { adaptLxMusicScript, isLxMusicScript } from './lxMusicSourceAdapter'

type SourceChannelCapability = {
	type?: string
	actions?: string[]
	qualitys?: string[]
}

export type SourceCapabilities = Partial<Record<LX.Source, SourceChannelCapability | false | null>>

export type SourceMusicApi = IMusic.MusicApi & {
	sources?: SourceCapabilities
	getLyric?: (title: string, artist: string, songmid: string) => Promise<unknown>
}

export interface ModuleExports {
	id?: string
	author?: string
	name?: string
	version?: string
	srcUrl?: string
	sources?: SourceCapabilities
	getLyric?: SourceMusicApi['getLyric']
	getMusicUrl?: (
		songname: string,
		artist: string,
		songmid: string,
		quality: string,
	) => Promise<string>
}

export async function createMusicApiFromScript(rawScript: string): Promise<SourceMusicApi> {
	const script = rawScript?.trim?.() ?? ''
	if (!script) {
		throw new Error('音源脚本为空')
	}

	if (isLxMusicScript(script)) {
		return adaptLxMusicScript(script)
	}

	const module: { exports: ModuleExports } = { exports: {} }
	const require = () => {}
	const moduleFunc = new Function('module', 'exports', 'require', script)
	moduleFunc(module, module.exports, require)

	if (typeof module.exports.getMusicUrl !== 'function') {
		throw new Error('脚本缺少 getMusicUrl 方法')
	}

	return {
		id: module.exports.id || '',
		platform: 'tx',
		author: module.exports.author || '',
		name: module.exports.name || '',
		version: module.exports.version || '',
		srcUrl: module.exports.srcUrl || '',
		script,
		scriptType: 'cymusic',
		isSelected: false,
		getMusicUrl: module.exports.getMusicUrl,
		getLyric: typeof module.exports.getLyric === 'function' ? module.exports.getLyric : undefined,
		sources: module.exports.sources,
	}
}

export async function fetchScriptFromUrl(url: string): Promise<string> {
	const target = url?.trim?.()
	if (!target) {
		throw new Error('链接为空')
	}
	const response = await fetch(target)
	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`)
	}
	return response.text()
}

export function looksLikeScriptText(text?: string | null): boolean {
	if (!text) return false
	const normalized = text.trim()
	return /module\s*\.\s*exports\s*\.\s*getMusicUrl/.test(normalized) || isLxMusicScript(normalized)
}
