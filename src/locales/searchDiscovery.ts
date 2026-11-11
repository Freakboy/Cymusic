import { nowLanguage } from '@/utils/i18n'

export function useSearchDiscoveryText() {
	return nowLanguage.useValue()?.startsWith('zh')
		? {
				songs: '热门歌曲 · QQ音乐热歌榜',
				playlists: '热门歌单 · 按热度排序',
				error: '加载失败，请重试。',
				retry: '重试',
				failed: '播放失败',
			}
		: {
				songs: 'Popular songs · QQ Music Hot Songs chart',
				playlists: 'Popular playlists · by popularity',
				error: 'Could not load. Please retry.',
				retry: 'Retry',
				failed: 'Playback failed',
			}
}
