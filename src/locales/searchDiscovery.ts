import { nowLanguage } from '@/utils/i18n'

export function useSearchDiscoveryText() {
	return nowLanguage.useValue()?.startsWith('zh')
		? {
				songs: '热门歌曲 · QQ音乐热歌榜',
				playlists: '热门歌单 · 按热度排序',
				error: '加载失败，请重试。',
				retry: '重试',
				refresh: '刷新', more: '加载更多歌单', end: '没有更多歌单了',
				failed: '播放失败',
			}
		: {
				songs: 'Popular songs · QQ Music Hot Songs chart',
				playlists: 'Popular playlists · by popularity',
				error: 'Could not load. Please retry.',
				retry: 'Retry',
				refresh: 'Refresh', more: 'Load more playlists', end: 'No more playlists',
				failed: 'Playback failed',
			}
}
