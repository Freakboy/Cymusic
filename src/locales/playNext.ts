import { nowLanguage } from '@/utils/i18n'

/** Kept separate from shared locale JSON to avoid unrelated settings updates. */
export function usePlayNextText(): string {
	return nowLanguage.useValue() === 'zh' ? '下一首播放' : 'Play next'
}
