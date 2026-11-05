export type CommentsPlatform = 'QQ' | 'Netease'

export function getCommentsPlatform(platform?: string): CommentsPlatform | undefined {
	if (!platform || platform === 'QQ' || platform === 'tx') return 'QQ'
	if (platform === 'Netease' || platform === 'wy') return 'Netease'
}

export class NeteaseCommentsError extends Error {}

type NeteaseComment = {
	commentId: number | string
	content: string
	user?: { nickname?: string; avatarUrl?: string }
	time?: number
	timeStr?: string
	likedCount?: number
}

// Anonymous, read-only website endpoints. They may expose only historical comments.
export async function getNeteaseComments(id: string, mode: 'hot' | 'latest', page = 1) {
	if (
		!/^[1-9]\d*$/.test(id) ||
		!Number.isSafeInteger(Number(id)) ||
		!Number.isSafeInteger(page) ||
		page < 1
	) {
		throw new NeteaseCommentsError('Invalid song ID or page')
	}
	const limit = 20
	const endpoint = mode === 'hot' ? 'hotcomments' : 'comments'
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 15000)
	try {
		const response = await fetch(
			`https://music.163.com/api/v1/resource/${endpoint}/R_SO_4_${id}?limit=${limit}&offset=${(page - 1) * limit}`,
			{ signal: controller.signal, credentials: 'omit' },
		)
		if (!response.ok) throw new NeteaseCommentsError(`HTTP ${response.status}`)
		const data = await response.json()
		if (data?.code !== 200) throw new NeteaseCommentsError(`API ${data?.code ?? 'invalid'}`)
		const raw: NeteaseComment[] = mode === 'hot' ? data.hotComments : data.comments
		const hasMore = mode === 'hot' ? data.hasMore : data.more
		if (
			!Array.isArray(raw) ||
			!Number.isSafeInteger(data.total) ||
			data.total < 0 ||
			typeof hasMore !== 'boolean' ||
			(hasMore && raw.length === 0) ||
			raw.some(
				(item) =>
					!item || !/^\d+$/.test(String(item.commentId)) || typeof item.content !== 'string',
			)
		) {
			throw new NeteaseCommentsError('Invalid comments response')
		}
		return {
			comments: raw.map((item) => ({
				id: String(item.commentId),
				text: item.content,
				userName: item.user?.nickname ?? '',
				avatar: item.user?.avatarUrl?.replace(/^http:/, 'https:'),
				timeStr:
					item.timeStr ||
					(Number.isFinite(item.time) && item.time > 0
						? new Date(item.time).toLocaleDateString()
						: ''),
				likedCount: item.likedCount,
			})),
			hasMore,
		}
	} catch (error) {
		if (error instanceof NeteaseCommentsError) throw error
		throw new NeteaseCommentsError('Public comments request unavailable')
	} finally {
		clearTimeout(timer)
	}
}
