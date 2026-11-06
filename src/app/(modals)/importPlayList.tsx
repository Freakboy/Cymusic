import { unknownTrackImageUri } from '@/constants/images'
import { ThemeColors, screenPadding } from '@/constants/tokens'
import { logError } from '@/helpers/logger'
import { importRemotePlaylist, type PlaylistImportMode } from '@/helpers/remotePlaylistStore'
import myTrackPlayer from '@/helpers/trackPlayerIndex'
import {
	fetchRemotePlaylistFromInput,
	findBoundPlaylist,
	parseRemotePlaylistReference,
	type RemotePlaylistPlatform,
	type RemotePlaylistResult,
} from '@/helpers/userApi/remotePlaylist'
import { useThemeColors } from '@/hooks/useAppTheme'
import { usePlaylistFeatureText } from '@/locales/playlistFeature'
import { playListsStore } from '@/player/PlayerStore'
import { useDefaultStyles } from '@/styles'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import { router } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
	ActivityIndicator,
	Image,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'

const ImportPlayList = () => {
	const colors = useThemeColors()
	const defaultStyles = useDefaultStyles()
	const styles = useMemo(() => createStyles(colors, defaultStyles), [colors, defaultStyles])
	const text = usePlaylistFeatureText()
	const playlists = playListsStore.useValue() || []
	const [newName, setNewName] = useState('')
	const [newCover, setNewCover] = useState<string | undefined>()
	const [playlistUrl, setPlaylistUrl] = useState('')
	const [preview, setPreview] = useState<RemotePlaylistResult | null>(null)
	const [isLoading, setIsLoading] = useState(false)
	const [isSaving, setIsSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [customName, setCustomName] = useState('')
	const [coverImage, setCoverImage] = useState<string | undefined>()
	const [importMode, setImportMode] = useState<PlaylistImportMode>('update')
	const [platform, setPlatform] = useState<RemotePlaylistPlatform | undefined>()
	const requestId = useRef(0)
	const busy = useRef(false)
	const saving = useRef(false)
	const headerHeight = useHeaderHeight()
	const insets = useSafeAreaInsets()
	const existing = preview ? findBoundPlaylist(playlists, preview.remoteBinding) : undefined

	useEffect(
		() => () => {
			requestId.current++
		},
		[],
	)

	const invalidate = () => {
		requestId.current++
		busy.current = false
		setIsLoading(false)
		setPreview(null)
		setError(null)
		setImportMode('update')
	}

	const pickImage = async (create = false) => {
		const current = requestId.current
		try {
			const result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ['images'],
				allowsEditing: true,
				aspect: [1, 1],
				quality: 1,
			})
			if (current === requestId.current && !result.canceled) {
				if (create) setNewCover(result.assets[0].uri)
				else setCoverImage(result.assets[0].uri)
			}
		} catch (err) {
			if (current === requestId.current) setError(text.coverFailed)
			logError('Playlist cover:', err)
		}
	}

	const handlePreview = async () => {
		if (busy.current || saving.current) return
		invalidate()
		if (/^\d+$/.test(playlistUrl.trim()) && !platform) {
			setError(text.choosePlatform)
			return
		}
		if (!parseRemotePlaylistReference(playlistUrl, platform)) {
			setError(text.invalidLink)
			return
		}
		const current = requestId.current
		busy.current = true
		setIsLoading(true)
		try {
			const response = await fetchRemotePlaylistFromInput(playlistUrl, platform)
			if (current === requestId.current) setPreview(response)
		} catch (err) {
			if (current === requestId.current) {
				const detail = err instanceof Error ? err.message : ''
				setError(detail ? `${text.importFailed}\n${detail}` : text.importFailed)
			}
			logError('Playlist preview:', err)
		} finally {
			if (current === requestId.current) {
				busy.current = false
				setIsLoading(false)
			}
		}
	}

	const handleSave = async (action: 'create' | 'import') => {
		if (saving.current || busy.current) return
		if (action === 'create' && !newName.trim()) {
			setError(text.nameRequired)
			return
		}
		if (action === 'import' && !preview) return
		saving.current = true
		setIsSaving(true)
		setError(null)
		const current = requestId.current
		try {
			if (action === 'create') {
				await myTrackPlayer.addPlayLists({
					id: Date.now().toString(),
					platform: 'local',
					artist: text.unknownArtist,
					name: newName.trim(),
					title: newName.trim(),
					songs: [],
					artwork: newCover || unknownTrackImageUri,
					tracks: [],
				} as IMusic.PlayList)
			} else if (preview) {
				importRemotePlaylist(preview, importMode, { name: customName, artwork: coverImage })
			}
			if (current === requestId.current) router.dismiss()
		} catch (err) {
			if (current === requestId.current) setError(text.saveFailed)
			logError('Playlist save:', err)
		} finally {
			saving.current = false
			if (current === requestId.current) setIsSaving(false)
		}
	}

	return (
		<SafeAreaView
			edges={['left', 'right', 'bottom']}
			style={[styles.container, { paddingTop: Math.max(headerHeight, insets.top, 16) }]}
		>
			<View pointerEvents="none" style={[styles.dismissSymbol, { top: insets.top - 25 }]}>
				<View style={styles.dismissBar} />
			</View>
			<KeyboardAvoidingView
				behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
				style={styles.flex}
			>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<View style={styles.section}>
						<Text style={styles.sectionTitle}>{text.createSection}</Text>
						<View style={styles.card}>
							<View style={styles.createRow}>
								<TouchableOpacity
									accessibilityRole="button"
									accessibilityLabel={text.chooseCover}
									disabled={isSaving || isLoading}
									onPress={() => void pickImage(true)}
									style={styles.createCover}
								>
									{newCover ? (
										<Image source={{ uri: newCover }} style={styles.createCover} />
									) : (
										<>
											<Ionicons name="image-outline" size={24} color={colors.primary} />
											<Text style={styles.coverText}>{text.chooseCover}</Text>
										</>
									)}
								</TouchableOpacity>
								<TextInput
									style={[styles.input, styles.flex]}
									value={newName}
									onChangeText={setNewName}
									editable={!isSaving}
									placeholder={text.name}
									accessibilityLabel={text.name}
									placeholderTextColor={colors.placeholder}
									returnKeyType="done"
								/>
							</View>
							<TouchableOpacity
								accessibilityRole="button"
								style={styles.button}
								disabled={isSaving || isLoading}
								onPress={() => void handleSave('create')}
							>
								{isSaving ? (
									<ActivityIndicator color={colors.primary} />
								) : (
									<Ionicons name="add-circle-outline" size={24} color={colors.primary} />
								)}
								<Text style={styles.buttonText}>{isSaving ? text.saving : text.create}</Text>
							</TouchableOpacity>
						</View>
					</View>
					<View style={styles.divider} />
					<View style={styles.section}>
						<Text style={styles.sectionTitle}>{text.importSection}</Text>
						<View style={styles.card}>
							<Text style={styles.label}>{text.source}</Text>
							<View style={styles.row}>
								{([undefined, 'QQ', 'Netease'] as const).map((item) => (
									<TouchableOpacity
										key={item || 'auto'}
										accessibilityRole="button"
										accessibilityState={{ selected: platform === item }}
										disabled={isSaving}
										style={[styles.choice, platform === item && styles.selected]}
										onPress={() => {
											invalidate()
											setPlatform(item)
										}}
									>
										<Text style={[styles.choiceText, platform === item && styles.selectedText]}>
											{item ? text[item] : text.auto}
										</Text>
									</TouchableOpacity>
								))}
							</View>
							<TextInput
								style={styles.input}
								value={playlistUrl}
								editable={!isSaving}
								onChangeText={(value) => {
									invalidate()
									setPlaylistUrl(value)
								}}
								placeholder={text.linkPlaceholder}
								accessibilityLabel={text.linkPlaceholder}
								placeholderTextColor={colors.placeholder}
								autoCapitalize="none"
								autoCorrect={false}
								multiline
								returnKeyType="done"
								onSubmitEditing={handlePreview}
							/>
							<Text style={styles.hint}>{text.idHint}</Text>
							<TouchableOpacity
								accessibilityRole="button"
								style={styles.button}
								disabled={isLoading || isSaving}
								onPress={handlePreview}
							>
								{isLoading && <ActivityIndicator color={colors.primary} />}
								<Text style={styles.buttonText}>
									{isLoading ? text.recognizing : error && !preview ? text.retry : text.preview}
								</Text>
							</TouchableOpacity>
							{preview && (
								<View style={styles.preview}>
									<Text style={styles.label}>{text.previewTitle}</Text>
									<View style={styles.previewRow}>
										<Image
											source={{ uri: preview.artwork || unknownTrackImageUri }}
											style={styles.cover}
											accessibilityLabel={text.cover}
										/>
										<View style={styles.flex}>
											<Text style={styles.label}>{preview.name}</Text>
											<Text style={styles.hint}>
												{text[preview.remoteBinding.platform]} · {preview.songs.length} {text.songs}
											</Text>
										</View>
									</View>
									<Text style={styles.hint}>
										{existing ? `${text.exists}: ${existing.name}` : text.newPlaylist}
									</Text>
									{preview.qqCompleteness?.unavailableSongIds?.length > 0 && (
										<Text style={styles.hint}>{preview.qqCompleteness.unavailableSongIds.length} {text.unavailableSongs}</Text>
									)}
									{existing && (
										<View style={styles.row}>
											{(['update', 'copy', 'merge'] as const).map((mode) => (
												<TouchableOpacity
													key={mode}
													accessibilityRole="button"
													accessibilityState={{ selected: importMode === mode }}
													disabled={isSaving}
													onPress={() => {
														requestId.current++
														setImportMode(mode)
														setError(null)
													}}
													style={[styles.choice, importMode === mode && styles.selected]}
												>
													<Text
														style={[styles.choiceText, importMode === mode && styles.selectedText]}
													>
														{text[mode]}
													</Text>
												</TouchableOpacity>
											))}
										</View>
									)}
									<Text style={styles.hint}>
										{existing ? text[`${importMode}Hint`] : text.refreshHint}
									</Text>
								</View>
							)}

							{preview && (
								<View style={styles.preview}>
									<Text style={styles.label}>{text.customize}</Text>
									<TouchableOpacity
										accessibilityRole="button"
										accessibilityLabel={text.chooseCover}
										disabled={isSaving}
										onPress={() => void pickImage()}
										style={styles.coverPicker}
									>
										{coverImage ? (
											<Image source={{ uri: coverImage }} style={styles.cover} />
										) : (
											<Text style={styles.buttonText}>{text.chooseCover}</Text>
										)}
									</TouchableOpacity>
									<TextInput
										style={styles.input}
										value={customName}
										onChangeText={setCustomName}
										editable={!isSaving}
										placeholder={text.optionalName}
										accessibilityLabel={text.name}
										placeholderTextColor={colors.placeholder}
										returnKeyType="done"
									/>
									<TouchableOpacity
										accessibilityRole="button"
										style={styles.button}
										disabled={isSaving}
										onPress={() => void handleSave('import')}
									>
										{isSaving && <ActivityIndicator color={colors.primary} />}
										<Text style={styles.buttonText}>{isSaving ? text.saving : text.confirm}</Text>
									</TouchableOpacity>
								</View>
							)}
						</View>
					</View>
					{error && (
						<Text accessibilityRole="alert" style={styles.error}>
							{error}
						</Text>
					)}
					<TouchableOpacity
						accessibilityRole="button"
						disabled={isSaving}
						style={styles.button}
						onPress={() => {
							invalidate()
							router.dismiss()
						}}
					>
						<Text style={styles.buttonText}>{text.cancel}</Text>
					</TouchableOpacity>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	)
}

const createStyles = (colors: ThemeColors, defaultStyles: ReturnType<typeof useDefaultStyles>) =>
	StyleSheet.create({
		container: { ...defaultStyles.container, paddingHorizontal: screenPadding.horizontal },
		dismissSymbol: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
		dismissBar: { width: 50, height: 5, borderRadius: 2.5, backgroundColor: colors.dismissBar },
		flex: { flex: 1 },
		content: { paddingBottom: 24 },
		section: { marginBottom: 24 },
		sectionTitle: { fontSize: 20, fontWeight: '600', color: colors.text, marginBottom: 16 },
		card: { gap: 16, padding: 16, borderRadius: 12, backgroundColor: colors.surface },
		divider: { height: 1, backgroundColor: colors.separator, marginVertical: 24 },
		createRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
		createCover: {
			width: 100,
			height: 100,
			borderRadius: 8,
			backgroundColor: colors.surfaceMuted,
			alignItems: 'center',
			justifyContent: 'center',
			overflow: 'hidden',
		},
		coverText: { color: colors.primary, fontSize: 14, marginTop: 8 },
		preview: { gap: 12 },
		label: { fontSize: 17, fontWeight: '600', color: colors.text },
		hint: { fontSize: 14, lineHeight: 21, color: colors.textMuted },
		row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
		previewRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
		choice: {
			flexGrow: 1,
			flexBasis: 80,
			minHeight: 44,
			padding: 10,
			borderRadius: 8,
			alignItems: 'center',
			justifyContent: 'center',
			backgroundColor: colors.surfaceMuted,
		},
		selected: { backgroundColor: colors.primary },
		choiceText: { color: colors.text, fontWeight: '600', textAlign: 'center' },
		selectedText: { color: colors.background },
		input: {
			minHeight: 44,
			paddingHorizontal: 16,
			paddingVertical: 10,
			borderRadius: 8,
			fontSize: 16,
			color: colors.text,
			backgroundColor: colors.surfaceMuted,
		},
		cover: { width: 80, height: 80, borderRadius: 8 },
		coverPicker: {
			minHeight: 44,
			alignSelf: 'flex-start',
			justifyContent: 'center',
			padding: 8,
			borderRadius: 8,
			backgroundColor: colors.surfaceMuted,
		},
		button: {
			minHeight: 44,
			padding: 12,
			flexDirection: 'row',
			gap: 8,
			alignItems: 'center',
			justifyContent: 'center',
			borderRadius: 8,
			backgroundColor: colors.surfaceMuted,
		},
		buttonText: { fontSize: 18, fontWeight: '600', color: colors.primary, textAlign: 'center' },
		error: { color: colors.error, fontSize: 14, lineHeight: 21 },
	})

export default ImportPlayList
