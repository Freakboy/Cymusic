import { ThemeColors } from '@/constants/tokens'
import { Playlist } from '@/helpers/types'
import { useThemeColors } from '@/hooks/useAppTheme'
import { useDefaultStyles } from '@/styles'
import { Ionicons } from '@expo/vector-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableHighlight, TouchableHighlightProps, TouchableOpacity, View } from 'react-native'
import { Image } from 'expo-image'
import { getPlaylistReference } from '@/helpers/userApi/remotePlaylist'
import { usePlaylistArtwork } from '@/hooks/usePlaylistArtwork'

type PlaylistListItemProps = {
	playlist: Playlist
	onRefresh?: (playlist: Playlist) => Promise<void>
	onMore?: (playlist: Playlist, refresh: () => Promise<void>) => void
} & TouchableHighlightProps

export const PlaylistListItem = ({ playlist, onRefresh, onMore, ...props }: PlaylistListItemProps) => {
	const colors = useThemeColors()
	const defaultStyles = useDefaultStyles()
	const styles = useMemo(() => createStyles(colors, defaultStyles), [colors, defaultStyles])
	const artwork = usePlaylistArtwork(playlist)
	const [refreshState, setRefreshState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
	const remotePlaylist = getPlaylistReference(playlist)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const mounted = useRef(true)
	const busy = useRef(false)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			if (timer.current !== null) clearTimeout(timer.current)
		}
	}, [])

	const handleRefresh = async () => {
		if (!onRefresh || busy.current) return
		busy.current = true
		if (timer.current !== null) clearTimeout(timer.current)
		setRefreshState('loading')
		try {
			await onRefresh(playlist)
			if (mounted.current) {
				setRefreshState('success')
				timer.current = setTimeout(() => setRefreshState('idle'), 1500)
			}
		} catch (error) {
			if (mounted.current) {
				setRefreshState('error')
				Alert.alert('刷新失败', error instanceof Error ? error.message : '请稍后重试')
			}
		} finally {
			busy.current = false
		}
	}

	return (
		<TouchableHighlight activeOpacity={0.8} underlayColor={colors.surfaceMuted} {...props}
			onLongPress={onMore ? () => onMore(playlist, handleRefresh) : props.onLongPress}>
			<View style={styles.playlistItemContainer}>
				<View>
					<Image
						contentFit="cover"
						cachePolicy="memory-disk"
						priority="normal"
						recyclingKey={artwork.source.uri}
						source={artwork.source}
						placeholder={artwork.placeholder}
						onError={artwork.onError}
						style={styles.playlistArtworkImage}
					/>
				</View>

				<View
					style={{
						flexDirection: 'row',
						justifyContent: 'space-between',
						alignItems: 'center',
						flex: 1,
					}}
				>
					<View style={styles.playlistTextContainer}>
						<Text numberOfLines={1} style={styles.playlistNameText}>{playlist.title}</Text>
						{remotePlaylist && <Text numberOfLines={1} style={styles.playlistMetaText}>{remotePlaylist.platform === 'Netease' ? '网易云音乐' : 'QQ音乐'}</Text>}
						{refreshState === 'error' && <Text style={[styles.playlistMetaText, { color: colors.error }]}>刷新失败，点击重试</Text>}
					</View>
					<View style={styles.actionsContainer}>
						{remotePlaylist && onRefresh && (
							<TouchableOpacity onPress={(event) => { event.stopPropagation(); void handleRefresh() }} disabled={refreshState === 'loading'} style={styles.actionButton} accessibilityRole="button" accessibilityLabel="刷新远端歌单">
								{refreshState === 'loading' ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name={refreshState === 'success' ? 'checkmark-circle' : refreshState === 'error' ? 'alert-circle' : 'refresh'} size={20} color={refreshState === 'error' ? colors.error : colors.primary} />}
							</TouchableOpacity>
						)}
						{onMore && <TouchableOpacity onPress={(event) => { event.stopPropagation(); onMore(playlist, handleRefresh) }}
							style={styles.actionButton} accessibilityRole="button" accessibilityLabel="歌单更多操作">
							<Ionicons name="ellipsis-horizontal" size={22} color={colors.icon} />
						</TouchableOpacity>}
					</View>
				</View>
			</View>
		</TouchableHighlight>
	)
}

const createStyles = (
	colors: ThemeColors,
	defaultStyles: ReturnType<typeof useDefaultStyles>,
) =>
	StyleSheet.create({
	playlistItemContainer: {
		flexDirection: 'row',
		columnGap: 14,
		alignItems: 'center',
		paddingRight: 0,
	},
	playlistArtworkImage: {
		borderRadius: 8,
		width: 70,
		height: 70,
	},
	playlistNameText: {
		...defaultStyles.text,
		fontSize: 17,
		fontWeight: '600',
	},
	playlistTextContainer: { flex: 1, minWidth: 0 },
	playlistMetaText: { ...defaultStyles.text, color: colors.textMuted, fontSize: 12, marginTop: 3 },
	actionsContainer: { flexDirection: 'row', alignItems: 'center', columnGap: 8 },
	actionButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
	})
