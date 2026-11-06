const timeReg = /\[\d+(?::\d+)+(?:\.\d+)?\]/g
const metaReg = /\[([a-zA-Z][\w-]*):([^\]\r\n]*)\]/g

/** 额外的配置 */
interface IExtra {
	offset?: number
}

export default class LyricParser {
	private lastIndex: number = 0
	private lrcItems: Array<ILyric.IParsedLrcItem>
	private translationLrcItems: Array<ILyric.IParsedLrcItem>
	private meta: Record<string, any>
	private currentMusicItem?: IMusic.IMusicItem
	public readonly lrcSource: ILyric.ILyricSource

	constructor(source: ILyric.ILyricSource, currentMusicItem?: IMusic.IMusicItem, extra?: IExtra) {
		this.lrcSource = source
		this.currentMusicItem = currentMusicItem
		const rawResult = this.parseLrc(source.rawLrc, extra)
		const translationResult = this.parseLrc(source.translation, extra)

		this.meta = rawResult.meta
		this.lrcItems = rawResult.lrcItems
		this.translationLrcItems = translationResult.lrcItems
	}

	private parseLrc(raw?: string, extra?: IExtra) {
		if (!raw) {
			return {
				lrcItems: [],
				meta: {},
			}
		}
		raw = raw.trim()
		const rawLrcItems: Array<ILyric.IParsedLrcItem> = []
		const meta = this.parseMeta(raw)
		// LRC offset advances lyrics; extra.offset is the user's positive delay.
		// Expose the effective delay in seconds for both lookup and tap-to-seek.
		meta.offset = (extra?.offset ?? 0) - (meta.offset ?? 0)

		for (const line of raw.split(/\r?\n/)) {
			const content = line.replace(metaReg, '')
			const times = content.match(timeReg) ?? []
			const parts = content.split(timeReg)
			let start = 0
			for (let i = 0; i < times.length; ++i) {
				const lrc = parts[i + 1].trim()
				if (!lrc && i < times.length - 1) continue
				for (; start <= i; ++start) {
					rawLrcItems.push({ time: this.parseTime(times[start]), lrc })
				}
			}
		}
		let lrcItems = rawLrcItems.sort((a, b) => a.time - b.time)
		if (lrcItems.length === 0 && raw.length) {
			lrcItems = raw.split('\n').map((_) => ({
				time: 0,
				lrc: _,
			}))
		}

		for (let i = 0; i < lrcItems.length; ++i) {
			lrcItems[i].index = i
		}

		return {
			lrcItems,
			meta,
		}
	}

	getPosition(position: number): {
		lrc?: ILyric.IParsedLrcItem
		transLrc?: ILyric.IParsedLrcItem
		index: number
	} {
		position = position - (this.meta?.offset ?? 0)
		let index
		/** 最前面 */
		if (!this.lrcItems[0] || position < this.lrcItems[0].time) {
			this.lastIndex = 0
			return {
				lrc: undefined,
				index: -1,
			}
		}
		for (index = this.lastIndex; index < this.lrcItems.length - 1; ++index) {
			if (position >= this.lrcItems[index].time && position < this.lrcItems[index + 1].time) {
				this.lastIndex = index
				return {
					lrc: this.lrcItems[index],
					index,
				}
			}
		}

		for (index = 0; index < this.lastIndex; ++index) {
			if (position >= this.lrcItems[index].time && position < this.lrcItems[index + 1].time) {
				this.lastIndex = index
				return {
					lrc: this.lrcItems[index],
					index,
				}
			}
		}

		index = this.lrcItems.length - 1
		this.lastIndex = index
		return {
			lrc: this.lrcItems[index],
			transLrc: this.translationLrcItems[index],
			index,
		}
	}

	getCurrentMusicItem() {
		return this.currentMusicItem
	}

	getLyric() {
		return this.lrcItems
	}

	getTranslationLyric() {
		return this.translationLrcItems
	}

	getMeta() {
		return this.meta
	}

	setMeta(newMeta: Record<string, any>) {
		this.meta = newMeta
	}

	parseMeta(metaStr: string) {
		if (metaStr === '') {
			return {}
		}
		const metaArr = metaStr.match(metaReg) ?? []
		const meta: any = {}
		let k, v
		for (const m of metaArr) {
			k = m.substring(1, m.indexOf(':'))
			v = m.substring(k.length + 2, m.length - 1)
			if (k === 'offset') {
				if (Number.isFinite(+v)) meta[k] = +v / 1000
			} else {
				meta[k] = v
			}
		}
		return meta
	}

	/** [xx:xx.xx] => x s */
	parseTime(timeStr: string): number {
		let result = 0
		const nums = timeStr.slice(1, timeStr.length - 1).split(':')
		for (let i = 0; i < nums.length; ++i) {
			result = result * 60 + +nums[i]
		}
		return result
	}
}
