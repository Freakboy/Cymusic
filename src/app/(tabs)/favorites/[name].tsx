import { PlaylistTracksList } from '@/components/PlaylistTracksList'
import { screenPadding } from '@/constants/tokens'
import myTrackPlayer, { playListsStore } from '@/helpers/trackPlayerIndex'
import { Playlist } from '@/helpers/types'

import { useDefaultStyles } from '@/styles'
import { Redirect, router, useLocalSearchParams } from 'expo-router'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import type { Track } from '@/player/types'
import { refreshRemotePlaylist } from '@/helpers/remotePlaylistStore'
import { getPlaylistReference, remotePlaylistId } from '@/helpers/userApi/remotePlaylist'
import { useThemeColors } from '@/hooks/useAppTheme'

const PlaylistScreen = () => {
	const defaultStyles = useDefaultStyles()
	const colors = useThemeColors()
	const [refreshing, setRefreshing] = useState(false)
	const [refreshError, setRefreshError] = useState('')
	const busy = useRef(false)
	const migratedPlaylistId = useRef<string | null>(null)
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => { mounted.current = false }
	}, [])
	const { name: playlistID } = useLocalSearchParams<{ name: string }>()
	const playlists = playListsStore.useValue() as Playlist[] | null

	const playlist = useMemo(() => {
		return playlists?.find((p) => p.id === playlistID)
			?? playlists?.find((p) => p.id === migratedPlaylistId.current)
	}, [playlistID, playlists])

	const songs = useMemo(() => {
		return playlist?.songs || []
	}, [playlist])

	const handleDeleteTrack = useCallback(
		(trackId: string) => {
			myTrackPlayer.deleteSongFromStoredPlayList(playlist as Playlist, trackId)
		},
		[playlist],
	)
	const handleRefresh = async () => {
		if (busy.current) return
		busy.current = true
		setRefreshing(true)
		setRefreshError('')
		try {
			const reference = playlist && getPlaylistReference(playlist)
			migratedPlaylistId.current = reference ? remotePlaylistId(reference) : null
			const result = await refreshRemotePlaylist(playlist?.id ?? playlistID)
			if (mounted.current && result.id !== playlistID) router.replace({ pathname: '/(tabs)/favorites/[name]', params: { name: result.id } })
		} catch (error) {
			const message = error instanceof Error ? error.message : '刷新失败，请重试'
			if (mounted.current) {
				setRefreshError(message)
				Alert.alert('刷新失败', message)
			}
		} finally {
			busy.current = false
			if (mounted.current) setRefreshing(false)
		}
	}

	if (!playlist) {
		console.warn(`Playlist ${playlistID} was not found!`)
		return <Redirect href={'/(tabs)/favorites'} />
	}

	return (
		<View style={defaultStyles.container}>
			<ScrollView
				contentInsetAdjustmentBehavior="automatic"
				style={{ paddingHorizontal: screenPadding.horizontal }}
			>
				{getPlaylistReference(playlist) && <TouchableOpacity disabled={refreshing} onPress={handleRefresh}
					accessibilityRole="button" style={{ padding: 16, alignItems: 'center', flexDirection: 'row', gap: 8 }}>
					{refreshing && <ActivityIndicator color={colors.primary} />}
					<Text style={{ color: colors.primary }}>{refreshing ? '正在刷新...' : '刷新远端歌单'}</Text>
				</TouchableOpacity>}
				{Boolean(refreshError) && <Text style={{ color: colors.error }}>{refreshError}</Text>}
				<PlaylistTracksList
					playlist={playlist as Playlist}
					tracks={songs as Track[]}
					allowDelete={true}
					onDeleteTrack={handleDeleteTrack}
				/>
			</ScrollView>
		</View>
	)
}

export default PlaylistScreen
