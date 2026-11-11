import { unknownTrackImageUri } from '@/constants/images'
import { ThemeColors, screenPadding } from '@/constants/tokens'
import myTrackPlayer from '@/helpers/trackPlayerIndex'
import { useThemeColors } from '@/hooks/useAppTheme'
import { useDefaultStyles, useUtilsStyles } from '@/styles'
import i18n from '@/utils/i18n'
import { isSameMediaItem } from '@/utils/mediaItem'

import { getSingerMidBySingerName } from '@/helpers/userApi/getMusicSource'
import { useSourceSearchText } from '@/locales/sourceSearch'
import PersistStatus from '@/store/PersistStatus'
import { useQueue } from '@/store/queue'
import { MenuView } from '@react-native-menu/menu'
import { FlashList } from '@shopify/flash-list'
import { router } from 'expo-router'
import React, { memo, useCallback, useMemo, useRef } from 'react'
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Track } from '@/player/types'
import { useIsPlaying } from '@rntp/player'
import TracksListItem from './TracksListItem'

export type SearchListProps = {
	id: string
	tracks: Track[]
	hideQueueControls?: boolean
	onLoadMore: () => void
	hasMore: boolean
	isLoading: boolean
	error?: string
	onRetry?: () => void
	emptyMessage?: string
}

let searchQueueRevision = 0

const ItemDivider = memo(() => {
	const utilsStyles = useUtilsStyles()
	return <View style={{ ...utilsStyles.itemSeparator, marginVertical: 9, marginLeft: 60 }} />
})

const EmptyComponent = memo(() => {
	const utilsStyles = useUtilsStyles()
	return (
		<View>
			<Image
				contentFit="cover"
				cachePolicy="memory-disk"
				priority="normal"
				source={{ uri: unknownTrackImageUri }}
				style={utilsStyles.emptyContentImage}
			/>
		</View>
	)
})

const FooterComponent = memo(({ isLoading, hasMore }: { isLoading: boolean; hasMore: boolean }) => {
	const utilsStyles = useUtilsStyles()

	if (isLoading) {
		return (
			<View style={{ paddingVertical: 20 }}>
				<ActivityIndicator size="large" />
			</View>
		)
	}
	if (!hasMore) {
		return (
			<View style={{ paddingVertical: 20 }}>
				<Text style={utilsStyles.emptyContentText}>{i18n.t('find.noMoreResults')}</Text>
			</View>
		)
	}
	return null
})

const createStyles = (colors: ThemeColors) =>
	StyleSheet.create({
		artistItem: {
			flexDirection: 'row',
			alignItems: 'center',
		},
		artistAvatar: {
			width: 50,
			height: 50,
			borderRadius: 5,
			marginRight: 13,
		},
		artistName: {
			fontSize: 16,
			color: colors.text,
		},
	})

export const SearchList = ({
	id,
	tracks,
	onLoadMore,
	hasMore,
	isLoading,
	error,
	onRetry,
	emptyMessage,
}: SearchListProps) => {
	const text = useSourceSearchText()
	const colors = useThemeColors()
	const defaultStyles = useDefaultStyles()
	const styles = useMemo(() => createStyles(colors), [colors])
	const currentMusic = myTrackPlayer.useCurrentMusic()
	const playing = useIsPlaying()
	const playbackMode = PersistStatus.useValue('search.playbackMode', 'newplaylist')
	const { setActiveQueueId } = useQueue()
	const latestResults = useRef({ id, tracks })
	latestResults.current = { id, tracks }

	const handleTrackSelect = useCallback(
		async (selectedTrack: Track) => {
			try {
				if (latestResults.current.id !== id || latestResults.current.tracks !== tracks) return
				if (
					!tracks.some((track) =>
						isSameMediaItem(track as IMusic.IMusicItem, selectedTrack as IMusic.IMusicItem),
					)
				)
					return
				if (selectedTrack.searchKind === 'albums' || selectedTrack.searchKind === 'playlists') {
					router.navigate({
						pathname: '/(tabs)/search/collection',
						params: {
							kind: selectedTrack.searchKind,
							id: selectedTrack.albumMID || selectedTrack.id,
							title: selectedTrack.title,
						},
					})
					return
				}
				if (selectedTrack.isArtist) {
					const singerMid =
						selectedTrack.singerMID || (await getSingerMidBySingerName(selectedTrack.artist || ''))
					if (!singerMid) throw new Error(text.empty)
					router.navigate(`/(modals)/${singerMid}`)
					return
				}
				if (PersistStatus.get('search.playbackMode') !== 'append') {
					const songs = tracks.filter((track) => !track.isArtist && !track.searchKind)
					const playback = myTrackPlayer.playWithReplacePlayList(
						selectedTrack as IMusic.IMusicItem,
						songs as IMusic.IMusicItem[],
					)
					// The facade replaces the queue before awaiting playback resolution.
					setActiveQueueId(JSON.stringify(['search', id, ++searchQueueRevision]))
					await playback
				} else {
					await myTrackPlayer.play(selectedTrack as IMusic.IMusicItem)
				}
			} catch (cause) {
				Alert.alert(text.failed, cause instanceof Error ? cause.message : String(cause))
			}
		},
		[id, tracks, setActiveQueueId, text],
	)

	const renderItem = useCallback(
		({ item: track }: { item: Track }) => {
			if (track.isArtist || track.searchKind) {
				return (
					<TouchableOpacity style={styles.artistItem} onPress={() => handleTrackSelect(track)}>
						<Image
							contentFit="cover"
							cachePolicy="memory-disk"
							recyclingKey={(track.artwork || unknownTrackImageUri) ?? 'missing-artwork'}
							source={{ uri: track.artwork || unknownTrackImageUri }}
							style={styles.artistAvatar}
						/>
						<Text style={styles.artistName}>{track.title}</Text>
					</TouchableOpacity>
				)
			}
			const isActiveTrack = isSameMediaItem(
				track as IMusic.IMusicItem,
				currentMusic as IMusic.IMusicItem | null | undefined,
			)
			return (
				<TracksListItem
					track={track}
					onTrackSelect={handleTrackSelect}
					isActiveTrack={isActiveTrack}
					isPlaying={isActiveTrack && !!playing}
				/>
			)
		},
		[
			handleTrackSelect,
			currentMusic,
			playing,
			styles.artistAvatar,
			styles.artistItem,
			styles.artistName,
		],
	)

	const keyExtractor = useCallback((item: Track) => `${item.platform || 'tx'}:${item.id}`, [])

	const handleEndReached = useCallback(() => {
		if (hasMore && !isLoading && !error) {
			onLoadMore()
		}
	}, [hasMore, isLoading, error, onLoadMore])
	const insets = useSafeAreaInsets()

	const footerComponent = useMemo(
		() =>
			error ? (
				<TouchableOpacity accessibilityRole="button" onPress={onRetry} style={{ padding: 20 }}>
					<Text style={{ color: colors.text, textAlign: 'center' }}>
						{error} {text.retry}
					</Text>
				</TouchableOpacity>
			) : (
				<FooterComponent isLoading={isLoading} hasMore={hasMore || tracks.length === 0} />
			),
		[error, onRetry, colors.text, text.retry, isLoading, hasMore, tracks.length],
	)
	const listExtraData = useMemo(
		() => ({
			currentTrackId: currentMusic?.id ?? null,
			currentTrackPlatform: currentMusic?.platform ?? null,
			playing,
		}),
		[currentMusic?.id, currentMusic?.platform, playing],
	)

	return (
		<View style={[defaultStyles.container]}>
			<MenuView
				onPressAction={({ nativeEvent }) => {
					if (nativeEvent.event === 'append' || nativeEvent.event === 'newplaylist') {
						PersistStatus.set('search.playbackMode', nativeEvent.event)
					}
				}}
				actions={[
					{
						id: 'append',
						title: text.playbackAppend,
						state: playbackMode !== 'newplaylist' ? 'on' : 'off',
					},
					{
						id: 'newplaylist',
						title: text.playbackReplace,
						state: playbackMode === 'newplaylist' ? 'on' : 'off',
					},
				]}
				shouldOpenOnLongPress={false}
			>
				<View
					accessibilityRole="button"
					style={{
						minHeight: 44,
						justifyContent: 'center',
						paddingHorizontal: screenPadding.horizontal,
					}}
				>
					<Text style={{ color: colors.text }}>
						{playbackMode === 'newplaylist' ? text.playbackReplace : text.playbackAppend}
					</Text>
				</View>
			</MenuView>
			<FlashList
				data={tracks}
				extraData={listExtraData}
				contentContainerStyle={{
					paddingTop: 60,
					paddingBottom: 128 + insets.bottom,
					paddingHorizontal: screenPadding.horizontal,
				}}
				ItemSeparatorComponent={ItemDivider}
				ListEmptyComponent={
					!isLoading && !error ? (
						<View>
							<EmptyComponent />
							<Text style={{ color: colors.textMuted, textAlign: 'center' }}>
								{emptyMessage || text.empty}
							</Text>
						</View>
					) : null
				}
				renderItem={renderItem}
				keyExtractor={keyExtractor}
				onEndReached={handleEndReached}
				onEndReachedThreshold={0.1}
				ListFooterComponent={footerComponent}
				maintainVisibleContentPosition={{ disabled: true }}
				keyboardDismissMode="on-drag"
				keyboardShouldPersistTaps="handled"
			/>
		</View>
	)
}

export default memo(SearchList)
