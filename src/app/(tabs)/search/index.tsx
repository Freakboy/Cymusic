import { SearchList } from '@/components/SearchList'
import { ThemeColors } from '@/constants/tokens'
import { useThemeColors } from '@/hooks/useAppTheme'
import searchAll, { SearchType } from '@/helpers/searchAll'
import { useSourceSearchText } from '@/locales/sourceSearch'
import i18n from '@/utils/i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	Animated,
	useWindowDimensions,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { Track } from '@/player/types'
import { useSearchHot } from '@/hooks/useSearchHot'
import { useSearchDiscoveryText } from '@/locales/searchDiscovery'
import TracksListItem from '@/components/TracksListItem'
import myTrackPlayer from '@/helpers/trackPlayerIndex'
import { router } from 'expo-router'
import { Image } from 'expo-image'
import { ActivityIndicator, Alert, ScrollView, TouchableOpacity } from 'react-native'
import PersistStatus from '@/store/PersistStatus'
import { useQueue } from '@/store/queue'

let hotQueueRevision = 0

const SearchlistsScreen = () => {
	const text = useSourceSearchText()
	const [search, setSearch] = useState('')
	const discoveryText = useSearchDiscoveryText()
	const hotSongs = useSearchHot('songs', !search.trim())
	const hotPlaylists = useSearchHot('playlists', !search.trim())
	// Batched A -> B -> A edits still need a fresh request generation.
	const [revision, setRevision] = useState(0)
	const input = useRef('')
	const SEGMENT_WIDTH = (useWindowDimensions().width - 36) / 4
	const colors = useThemeColors()
	const styles = useMemo(() => createStyles(colors), [colors])
	// const router = useRouter()
	const [searchResults, setSearchResults] = useState<Track[]>([])
	const page = useRef(0)
	const pending = useRef(false)
	const controller = useRef<AbortController | null>(null)
	const [error, setError] = useState(false)
	const [isLoading, setIsLoading] = useState(false)
	const [hasMore, setHasMore] = useState(false)
	const searchRequestRef = useRef(0)
	const [searchType, setSearchType] = useState<SearchType>('songs')
	const slideAnim = useRef(new Animated.Value(0)).current
	const { setActiveQueueId } = useQueue()
	const latestHotSongs = useRef(hotSongs.tracks)
	latestHotSongs.current = hotSongs.tracks
	const hotInteractionGeneration = useRef(0)
	const hotGeneration = hotInteractionGeneration.current
	const selectHotSong = async (track: Track) => {
		// Include synchronous input intent: cached rows can fire before the next render.
		if (
			search.trim() ||
			input.current.trim() ||
			hotGeneration !== hotInteractionGeneration.current ||
			latestHotSongs.current !== hotSongs.tracks
		)
			return
		const songs = hotSongs.tracks.filter((item) => !item.isArtist && !item.searchKind)
		const selected = songs.find((item) => item.id === track.id && item.platform === track.platform)
		if (!selected) return
		try {
			if (PersistStatus.get('search.playbackMode') === 'append') {
				await myTrackPlayer.play(selected as IMusic.IMusicItem)
			} else {
				const snapshot = songs.map((item) => ({ ...item })) as IMusic.IMusicItem[]
				const playback = myTrackPlayer.playWithReplacePlayList(
					selected as IMusic.IMusicItem,
					snapshot,
				)
				setActiveQueueId(JSON.stringify(['search-hot', 'qq-chart-26', ++hotQueueRevision]))
				await playback
			}
		} catch (cause) {
			Alert.alert(discoveryText.failed, cause instanceof Error ? cause.message : String(cause))
		}
	}
	useEffect(() => {
		Animated.spring(slideAnim, {
			toValue: ['songs', 'artists', 'albums', 'playlists'].indexOf(searchType) * SEGMENT_WIDTH,
			useNativeDriver: true,
			tension: 100,
			friction: 10,
		}).start()
	}, [searchType, SEGMENT_WIDTH, slideAnim])
	const handleSearchChange = (value: string) => {
		if (input.current === value) return
		input.current = value
		++hotInteractionGeneration.current
		++searchRequestRef.current
		pending.current = true
		controller.current?.abort()
		setSearch(value)
		setRevision((value) => value + 1)
	}

	const fetchSearchResults = useCallback(
		async (currentPage: number) => {
			if (!search.trim() || pending.current) {
				return
			}

			const requestId = ++searchRequestRef.current
			const requestController = new AbortController()
			controller.current = requestController
			pending.current = true
			setError(false)
			setIsLoading(true)

			try {
				const { data, hasMore: moreResults } = await searchAll(
					search,
					currentPage,
					searchType,
					requestController.signal,
				)

				if (requestId === searchRequestRef.current) {
					setHasMore(moreResults)
					setSearchResults((prevResults) => {
						if (requestId !== searchRequestRef.current) return prevResults
						const seen = new Set<string>()
						return (currentPage === 1 ? data : [...prevResults, ...data]).filter((item) => {
							const key = `${item.platform || searchType}:${item.id}`
							if (seen.has(key)) return false
							seen.add(key)
							return true
						})
					})

					page.current = currentPage
				}
			} catch {
				if (requestId === searchRequestRef.current && !requestController.signal.aborted)
					setError(true)
			} finally {
				if (requestId === searchRequestRef.current) {
					pending.current = false
					setIsLoading(false)
				}
			}
		},
		[search, searchType],
	)
	useEffect(() => {
		const generation = searchRequestRef
		const activeController = controller
		page.current = 0
		pending.current = false
		setError(false)
		setHasMore(false)
		setSearchResults([])
		generation.current++
		setIsLoading(!!search.trim())
		const timer = setTimeout(() => {
			if (search.trim()) void fetchSearchResults(1)
		}, 350)

		return () => {
			generation.current++
			clearTimeout(timer)
			activeController.current?.abort()
		}
	}, [search, searchType, revision, fetchSearchResults])

	const handleLoadMore = useCallback(() => {
		if (!isLoading && !error && hasMore && search.trim()) {
			void fetchSearchResults(page.current + 1)
		}
	}, [isLoading, error, hasMore, fetchSearchResults, search])

	const handleSearchTypeChange = (type: SearchType) => {
		if (type === searchType) return
		++searchRequestRef.current
		pending.current = true
		controller.current?.abort()
		setSearchType(type)
		setRevision((value) => value + 1)
	}

	return (
		<SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
			<View style={styles.contentContainer}>
				<View style={styles.searchRow}>
					<TextInput
						style={styles.searchInput}
						value={search}
						onChangeText={handleSearchChange}
						placeholder={text.songSearch}
						accessibilityLabel={text.songSearch}
						placeholderTextColor={colors.placeholder}
						autoCapitalize="none"
						autoCorrect={false}
						returnKeyType="search"
					/>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={text.clearSearch}
						onPress={() => handleSearchChange('')}
						style={styles.clearButton}
					>
						<Text style={{ color: colors.primary }}>{text.clearSearch}</Text>
					</Pressable>
				</View>
				<View style={styles.segmentedControlContainer}>
					<View style={styles.segmentedControl}>
						<Animated.View
							style={[
								styles.activeSegment,
								{
									position: 'absolute',
									width: SEGMENT_WIDTH,
									transform: [{ translateX: slideAnim }],
								},
							]}
						/>
						{(['songs', 'artists', 'albums', 'playlists'] as SearchType[]).map((type) => (
							<Pressable
								key={type}
								style={[styles.segment, { borderTopLeftRadius: 8, borderBottomLeftRadius: 8 }]}
								onPress={() => handleSearchTypeChange(type)}
							>
								<Text style={[styles.segmentText, searchType === type && styles.activeSegmentText]}>
									{type === 'albums' || type === 'playlists' ? text[type] : i18n.t(`find.${type}`)}
								</Text>
							</Pressable>
						))}
					</View>
				</View>
				{search.trim() ? (
					<SearchList
						tracks={searchResults}
						id={JSON.stringify(['search', search.trim(), searchType])}
						onLoadMore={handleLoadMore}
						hasMore={hasMore}
						isLoading={isLoading}
						error={error ? text.searchError : undefined}
						onRetry={() => void fetchSearchResults(page.current + 1)}
						emptyMessage={search.trim() ? text.empty : text.prompt}
					/>
				) : (
					<ScrollView
						keyboardShouldPersistTaps="handled"
						contentContainerStyle={{ padding: 16, paddingBottom: 128 }}
					>
						{(
							[
								['songs', hotSongs],
								['playlists', hotPlaylists],
							] as const
						).map(([kind, section]) => (
							<View key={kind} style={{ marginBottom: 24 }}>
								<Text style={{ color: colors.text, fontSize: 18, marginBottom: 12 }}>
									{discoveryText[kind]}
								</Text>
								{section.loading && <ActivityIndicator />}
								{section.error && (
									<Pressable
										accessibilityRole="button"
										onPress={section.retry}
										style={{ minHeight: 44, justifyContent: 'center' }}
									>
										<Text style={{ color: colors.text }}>
											{discoveryText.error} {discoveryText.retry}
										</Text>
									</Pressable>
								)}
								{section.tracks.map((track) =>
									kind === 'songs' ? (
										<View key={track.id} style={{ marginBottom: 18 }}>
											<TracksListItem track={track} onTrackSelect={selectHotSong} />
										</View>
									) : (
										<TouchableOpacity
											key={track.id}
											style={{
												flexDirection: 'row',
												alignItems: 'center',
												minHeight: 60,
												marginBottom: 18,
											}}
											onPress={() =>
												router.navigate({
													pathname: '/(tabs)/search/collection',
													params: { kind: 'playlists', id: track.id, title: track.title },
												})
											}
										>
											<Image
												source={{ uri: track.artwork }}
												style={{ width: 50, height: 50, borderRadius: 5, marginRight: 13 }}
											/>
											<Text style={{ color: colors.text, fontSize: 16, flex: 1 }}>
												{track.title}
											</Text>
										</TouchableOpacity>
									),
								)}
							</View>
						))}
					</ScrollView>
				)}
			</View>
		</SafeAreaView>
	)
}

const createStyles = (colors: ThemeColors) =>
	StyleSheet.create({
		container: {
			flex: 1,
			backgroundColor: colors.background,
		},
		safeArea: {
			flex: 1,
			backgroundColor: colors.background,
		},
		contentContainer: {
			flex: 1,
			backgroundColor: colors.background,
			paddingTop: 8,
		},
		searchRow: {
			flexDirection: 'row',
			alignItems: 'center',
			marginHorizontal: 16,
			marginBottom: 8,
			gap: 8,
		},
		searchInput: {
			flex: 1,
			minHeight: 44,
			borderRadius: 8,
			paddingHorizontal: 12,
			fontSize: 16,
			color: colors.text,
			backgroundColor: colors.surfaceMuted,
		},
		clearButton: {
			minHeight: 44,
			minWidth: 44,
			justifyContent: 'center',
			alignItems: 'center',
		},
		segmentedControlContainer: {
			paddingHorizontal: 16,
			marginTop: 0,
			paddingBottom: 4,
		},
		segmentedControl: {
			flexDirection: 'row',
			backgroundColor: colors.surfaceMuted,
			borderRadius: 8,
			padding: 2,
			position: 'relative',
		},
		segment: {
			minHeight: 44,
			flex: 1,
			paddingVertical: 6,
			alignItems: 'center',
			justifyContent: 'center',
			zIndex: 1,
		},
		activeSegment: {
			backgroundColor: colors.surfaceElevated,
			borderRadius: 6,
			shadowColor: colors.shadow,
			shadowOffset: {
				width: 0,
				height: 1,
			},
			shadowOpacity: 0.15,
			shadowRadius: 2,
			elevation: 2,
			position: 'absolute',
			top: 2,
			bottom: 2,
			zIndex: 0,
		},
		segmentText: {
			fontSize: 15,
			color: colors.textMuted,
		},
		activeSegmentText: {
			color: colors.primary,
			fontWeight: '500',
		},
	})

export default SearchlistsScreen
