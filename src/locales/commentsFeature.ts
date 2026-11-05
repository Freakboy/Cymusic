import i18n from '@/utils/i18n'

i18n.store({
	en: {
		commentsFeature: {
			title: 'Comments',
			hot: 'Popular',
			latest: 'Latest',
			retry: 'Tap to retry',
			empty: 'No comments yet',
			failed: 'Could not load comments. Please try again.',
			unsupported: 'Comments are not available for this music source.',
			neteasePublicNotice:
				'Read-only public comments. Anonymous access may return only partial or historical comments, including in Latest.',
			neteaseUnavailable:
				'NetEase public comments could not be loaded. Access may be restricted or the service may be unavailable.',
			noLyrics: 'No lyrics available',
		},
	},
	zh: {
		commentsFeature: {
			title: '歌曲评论',
			hot: '热门',
			latest: '最新评论',
			retry: '点击重试',
			empty: '暂无评论',
			failed: '获取评论失败，请重试',
			unsupported: '当前音源暂不支持评论',
			neteasePublicNotice:
				'仅供只读浏览。网易云匿名公开接口可能仅返回部分或历史评论，“最新”也可能不完整。',
			neteaseUnavailable: '网易云公开评论获取失败，可能受访问权限、网络或接口可用性限制。',
			noLyrics: '暂无歌词',
		},
	},
})

export default i18n
