import { ThemeColors, screenPadding } from '@/constants/tokens'
import { useThemeColors } from '@/hooks/useAppTheme'
import i18n from '@/locales/commentsFeature'
import { useLocalSearchParams } from 'expo-router'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, View } from 'react-native'
import qqComment from '@/components/utils/musicSdk/tx/comment'
import { getCommentsPlatform, getNeteaseComments } from '@/helpers/userApi/neteaseComments'

type CommentItem = {
	id: string
	text: string
	userName: string
	avatar?: string
	timeStr?: string
	likedCount?: number
}

export default function CommentsScreen() {
	const colors = useThemeColors()
	const styles = useMemo(() => createStyles(colors), [colors])
	const params = useLocalSearchParams<{
		id: string
		songmid?: string
		platform?: string
		title?: string
		artist?: string
	}>()
	const [comments, setComments] = useState<CommentItem[]>([])
	const [loading, setLoading] = useState(true)
	const [loadingMore, setLoadingMore] = useState(false)
	const [mode, setMode] = useState<'hot' | 'latest'>('hot')
	const [page, setPage] = useState(1)
	const [hasMore, setHasMore] = useState(true)
	const [errorPage, setErrorPage] = useState<number | null>(null)
	const requestSequence = useRef(0)
	const pendingRequest = useRef<number | null>(null)
	const platform = getCommentsPlatform(params.platform)
	const supported = !!platform
	const invalidateRequest = useCallback(() => {
		++requestSequence.current
		pendingRequest.current = null
	}, [])

	const loadComments = useCallback(
		async (nextPage = 1, nextMode = mode) => {
			if (nextPage > 1 && pendingRequest.current !== null) return
			const sequence = ++requestSequence.current
			pendingRequest.current = sequence
			if (nextPage === 1) {
				setComments([])
				setPage(1)
				setHasMore(false)
				setLoadingMore(false)
			}
			if (nextPage === 1) setLoading(true)
			else setLoadingMore(true)
			setErrorPage(null)
			try {
				if (!supported) return
				const request = { songmid: params.songmid || params.id }
				const result =
					platform === 'Netease'
						? await getNeteaseComments(params.id, nextMode, nextPage)
						: nextMode === 'hot'
							? await qqComment.getHotComment(request, nextPage)
							: await qqComment.getComment(request, nextPage)
				if (sequence !== requestSequence.current) return
				setComments((current) => {
					const combined =
						nextPage === 1 ? result.comments || [] : [...current, ...(result.comments || [])]
					return Array.from(new Map(combined.map((item) => [item.id, item])).values())
				})
				setPage(nextPage)
				setHasMore('hasMore' in result ? result.hasMore : nextPage < (result.maxPage || 1))
			} catch {
				if (sequence === requestSequence.current) setErrorPage(nextPage)
			} finally {
				if (sequence === requestSequence.current) {
					pendingRequest.current = null
					setLoading(false)
					setLoadingMore(false)
				}
			}
		},
		[mode, params.id, params.songmid, supported, platform],
	)

	useEffect(() => {
		loadComments()
		return invalidateRequest
	}, [loadComments, invalidateRequest])

	const changeMode = (nextMode: 'hot' | 'latest') => {
		if (nextMode === mode) return
		invalidateRequest()
		setLoading(true)
		setMode(nextMode)
	}

	return (
		<View style={styles.container}>
			<View style={styles.header}>
				<Text style={styles.title}>{params.title || i18n.t('commentsFeature.title')}</Text>
				<Text style={styles.subtitle}>{params.artist || ''}</Text>
				{platform === 'Netease' && (
					<Text style={styles.meta}>{i18n.t('commentsFeature.neteasePublicNotice')}</Text>
				)}
			</View>
			{supported && (
				<View style={styles.tabs}>
					<Text
						style={[styles.tab, mode === 'hot' && styles.activeTab]}
						onPress={() => changeMode('hot')}
					>
						{i18n.t('commentsFeature.hot')}
					</Text>
					<Text
						style={[styles.tab, mode === 'latest' && styles.activeTab]}
						onPress={() => changeMode('latest')}
					>
						{i18n.t('commentsFeature.latest')}
					</Text>
				</View>
			)}
			{!supported ? (
				<View style={styles.center}>
					<Text style={styles.meta}>{i18n.t('commentsFeature.unsupported')}</Text>
				</View>
			) : loading ? (
				<ActivityIndicator color={colors.primary} style={styles.center} />
			) : errorPage === 1 ? (
				<View style={styles.center}>
					<Text style={styles.error}>
						{i18n.t(
							platform === 'Netease'
								? 'commentsFeature.neteaseUnavailable'
								: 'commentsFeature.failed',
						)}
					</Text>
					<Text style={styles.retry} onPress={() => loadComments()}>
						{i18n.t('commentsFeature.retry')}
					</Text>
				</View>
			) : (
				<FlatList
					key={`${params.platform}:${params.id}:${params.songmid}:${mode}`}
					data={comments}
					keyExtractor={(item) => item.id}
					contentContainerStyle={styles.list}
					onEndReached={() => {
						if (hasMore && !loadingMore && !errorPage) loadComments(page + 1)
					}}
					onEndReachedThreshold={0.5}
					ListEmptyComponent={
						<View style={styles.empty}>
							<Text style={styles.meta}>{i18n.t('commentsFeature.empty')}</Text>
						</View>
					}
					ListFooterComponent={
						loadingMore ? (
							<ActivityIndicator color={colors.primary} style={styles.footer} />
						) : errorPage ? (
							<View style={styles.footer}>
								<Text style={styles.error}>
									{i18n.t(
										platform === 'Netease'
											? 'commentsFeature.neteaseUnavailable'
											: 'commentsFeature.failed',
									)}
								</Text>
								<Text style={styles.retry} onPress={() => loadComments(errorPage)}>
									{i18n.t('commentsFeature.retry')}
								</Text>
							</View>
						) : null
					}
					renderItem={({ item }) => (
						<View style={styles.comment}>
							{item.avatar ? (
								<Image source={{ uri: item.avatar }} style={styles.avatar} />
							) : (
								<View style={styles.avatarPlaceholder} />
							)}
							<View style={styles.commentBody}>
								<Text style={styles.user}>{item.userName}</Text>
								<Text style={styles.text}>{item.text}</Text>
								<Text style={styles.meta}>
									{item.timeStr || ''}
									{item.likedCount ? ` · ♡ ${item.likedCount}` : ''}
								</Text>
							</View>
						</View>
					)}
				/>
			)}
		</View>
	)
}

const createStyles = (colors: ThemeColors) =>
	StyleSheet.create({
		container: {
			flex: 1,
			backgroundColor: colors.background,
			paddingHorizontal: screenPadding.horizontal,
		},
		header: { paddingTop: 24, paddingBottom: 16 },
		tabs: { flexDirection: 'row', columnGap: 20, paddingBottom: 8 },
		tab: { color: colors.textMuted, fontWeight: '600', paddingVertical: 8 },
		activeTab: { color: colors.primary },
		title: { color: colors.text, fontSize: 22, fontWeight: '700' },
		subtitle: { color: colors.textMuted, marginTop: 5 },
		list: { paddingBottom: 36 },
		comment: {
			flexDirection: 'row',
			paddingVertical: 14,
			borderBottomWidth: StyleSheet.hairlineWidth,
			borderBottomColor: colors.separator,
		},
		avatar: { width: 36, height: 36, borderRadius: 18, marginRight: 12 },
		avatarPlaceholder: {
			width: 36,
			height: 36,
			borderRadius: 18,
			marginRight: 12,
			backgroundColor: colors.surfaceMuted,
		},
		commentBody: { flex: 1 },
		user: { color: colors.primary, fontWeight: '600', marginBottom: 4 },
		text: { color: colors.text, lineHeight: 21 },
		meta: { color: colors.textMuted, fontSize: 12, marginTop: 7 },
		center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
		empty: { paddingVertical: 48, alignItems: 'center' },
		footer: { paddingVertical: 20, alignItems: 'center' },
		error: { color: colors.error },
		retry: { color: colors.primary, marginTop: 12 },
	})
