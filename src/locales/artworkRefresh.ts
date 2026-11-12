import { nowLanguage } from '@/utils/i18n'

export function useArtworkRefreshText() {
	return nowLanguage.useValue()?.startsWith('zh')
		? { action: '重新获取封面', failed: '未能获取封面，请稍后重试。' }
		: { action: 'Refresh artwork', failed: 'Could not fetch artwork. Please try again later.' }
}
