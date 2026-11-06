import localImage from '@/assets/local.png'
import { PlaylistsList } from '@/components/PlaylistsList'
import { screenPadding } from '@/constants/tokens'
import { playListsStore } from '@/helpers/trackPlayerIndex'
import { Playlist } from '@/helpers/types'
import { useDefaultStyles } from '@/styles'
import i18n from '@/utils/i18n'
import { router } from 'expo-router'
import { useMemo } from 'react'
import { Image, ScrollView, View } from 'react-native'
import { refreshRemotePlaylist } from '@/helpers/remotePlaylistStore'

const FavoritesScreen = () => {
	const defaultStyles = useDefaultStyles()

	const storedPlayLists = playListsStore.useValue()
	const playLists = useMemo(
		() => [
			...(storedPlayLists ?? []),
			{
				name: 'Favorites',
				id: 'favorites',
				tracks: [],
				title: i18n.t('appTab.favoritesSongs'),
				coverImg: 'https://y.qq.com/mediastyle/global/img/cover_like.png?max_age=2592000',
				description: i18n.t('appTab.favoritesSongs'),
			},
			{
				name: 'Local',
				id: 'local',
				tracks: [],
				title: i18n.t('appTab.localOrCachedSongs'),
				coverImg: Image.resolveAssetSource(localImage).uri,
				description: i18n.t('appTab.localOrCachedSongs'),
			},
		],
		[storedPlayLists],
	)

	const handlePlaylistPress = (playlist: Playlist) => {
		if (playlist.id === 'favorites') {
			router.push(`/(tabs)/favorites/favoriteMusic`)
		} else if (playlist.id === 'local') {
			router.push(`/(tabs)/favorites/localMusic`)
		} else {
			router.push(`/(tabs)/favorites/${playlist.id}`)
		}
	}
	const handleRefreshPlaylist = async (playlist: Playlist) => {
		await refreshRemotePlaylist(playlist.id)
	}
	return (
		<View style={defaultStyles.container}>
			<ScrollView
				keyboardShouldPersistTaps="handled"
				contentInsetAdjustmentBehavior="automatic"
				style={{
					paddingHorizontal: screenPadding.horizontal,
				}}
			>
				<PlaylistsList
					scrollEnabled={false}
					playlists={playLists as Playlist[]}
					onPlaylistPress={handlePlaylistPress}
					onRefreshPlaylist={handleRefreshPlaylist}
				/>
			</ScrollView>
		</View>
	)
}

export default FavoritesScreen
