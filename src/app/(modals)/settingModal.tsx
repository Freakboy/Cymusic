// src/app/modals/settingModal.tsx
import { ThemeColors } from '@/constants/tokens'
import { logError, logInfo } from '@/helpers/logger'
import myTrackPlayer, {
	autoCacheLocalStore,
	isCachedIconVisibleStore,
	nowApiState,
	songsNumsToLoadStore,
	useCurrentQuality,
} from '@/helpers/trackPlayerIndex'
import { useThemeColors, useThemeMode } from '@/hooks/useAppTheme'
import PersistStatus from '@/store/PersistStatus'
import { musicApiSelectedStore } from '@/player/PlayerStore'
import i18n, { changeLanguage, nowLanguage } from '@/utils/i18n'
import { showToast } from '@/utils/utils'
import { MenuView } from '@react-native-menu/menu'
import Constants from 'expo-constants'
import { isNewerRelease } from '@/helpers/releaseVersion'
import { useRouter } from 'expo-router'
import React, { useMemo, useRef, useState } from 'react'
import {
	ActivityIndicator,
	Alert,
	Image,
	type ImageSourcePropType,
	Linking,
	Platform,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TouchableOpacity,
	View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Toast, { BaseToast, ErrorToast } from 'react-native-toast-message'
import appIcon from '@/assets/144.png'
import { applyConfigBackup, CONFIG_BACKUP_EXPORT_UNSUPPORTED, configBackupPreview, pickConfigBackup, shareConfigBackup } from '@/helpers/configBackup'
import { configBackupText } from '@/locales/configBackup'
const QUALITY_OPTIONS = ['128k', '320k', 'flac']
const CURRENT_VERSION = Constants.expoConfig?.version ?? '未知版本'

type SettingItem = {
	id: string
	title: string
	icon?: ImageSourcePropType
} & (
	| {
			type: 'switch'
			value: boolean
			description: string
			onValueChange: (value: boolean) => void
		}
	| { type: 'link' | 'value' | 'custom'; value?: string }
)

// eslint-disable-next-line react/prop-types
const MusicQualityMenu = ({ currentQuality, onSelectQuality }) => {
	const colors = useThemeColors()
	const styles = useMemo(() => createStyles(colors), [colors])

	const handlePressAction = async (id: string) => {
		if (QUALITY_OPTIONS.includes(id)) {
			onSelectQuality(id)
		}
	}

	return (
		<MenuView
			onPressAction={({ nativeEvent: { event } }) => handlePressAction(event)}
			actions={QUALITY_OPTIONS.map((quality) => ({
				id: quality,
				title: quality,
				state: currentQuality === quality ? 'on' : 'off',
			}))}
		>
			<TouchableOpacity style={styles.menuTrigger}>
				<Text style={styles.menuTriggerText}>{currentQuality}</Text>
			</TouchableOpacity>
		</MenuView>
	)
}
const SettingModal = () => {
	const colors = useThemeColors()
	const { themeMode, setThemeMode } = useThemeMode()
	const styles = useMemo(() => createStyles(colors), [colors])
	const router = useRouter()
	const [currentQuality, setCurrentQuality] = useCurrentQuality()
	const [isLoading, setIsLoading] = useState(false)
	const [backupBusy, setBackupBusy] = useState(false)
	const backupActive = useRef(false)
	const backupText = configBackupText()
	const apiState = nowApiState.useValue()
	const selectedSource = musicApiSelectedStore.useValue()
	const language = nowLanguage.useValue()
	const autoCacheLocal = autoCacheLocalStore.useValue()
	const preloadNextTrack = PersistStatus.useValue('music.preloadNextTrack', true) === true
	const isCachedIconVisible = isCachedIconVisibleStore.useValue()
	const songsNumsToLoad = songsNumsToLoadStore.useValue()
	const preciseSeeking = PersistStatus.useValue('music.preciseSeeking', false) === true
	const bluetoothLyrics = PersistStatus.useValue('music.bluetoothLyrics', false) === true
	const themeLabel = useMemo(() => {
		switch (themeMode) {
			case 'light':
				return i18n.t('settings.actions.theme.light')
			case 'dark':
				return i18n.t('settings.actions.theme.dark')
			default:
				return i18n.t('settings.actions.theme.system')
		}
	}, [themeMode])
	const settingsData: { title: string; data: SettingItem[] }[] = [
		{
			title: i18n.t('settings.sections.appInfo'),
			data: [
				{ id: '1', title: 'CyMusic', type: 'link', icon: appIcon },
				{ id: '2', title: i18n.t('settings.items.version'), type: 'value', value: CURRENT_VERSION },
				{ id: '3', title: i18n.t('settings.items.checkUpdate'), type: 'value' },
				{ id: '5', title: i18n.t('settings.items.projectLink'), type: 'value', value: '' },
				{ id: '9', title: i18n.t('settings.items.clearCache'), type: 'value', value: '' },
				{ id: '13', title: i18n.t('settings.items.viewLogs'), type: 'link' },
				{
					id: '15',
					title: i18n.t('settings.items.changeLanguage'),
					type: 'value',
					value: '',
				},
				{ id: '18', title: i18n.t('settings.items.theme'), type: 'value', value: '' },
				{ id: '16', title: i18n.t('settings.items.isCachedIconVisible'), type: 'value', value: '' },
				{
					id: '17',
					title: i18n.t('settings.items.songsNumsToLoad'),
					type: 'value',
					value: '',
				},
			],
		},
		{
			title: i18n.t('settings.sections.audioSettings'),
			data: [
				{ id: '6', title: i18n.t('settings.items.clearPlaylist'), type: 'link' },
				{
					id: '14',
					title: i18n.t('settings.items.autoCacheLocal'),
					type: 'value',
				},
				{ id: 'preloadNextTrack', title: i18n.t('settings.items.preloadNextTrack'), type: 'value' },
				{
					id: 'bluetoothLyrics', title: i18n.t('settings.items.bluetoothLyrics'), type: 'switch',
					description: i18n.t('settings.descriptions.bluetoothLyrics'), value: bluetoothLyrics,
					onValueChange: (value: boolean) => PersistStatus.set('music.bluetoothLyrics', value),
				},
				...(Platform.OS === 'ios'
					? [
						{
							id: 'preciseSeeking',
							title: i18n.t('settings.items.preciseSeeking'),
							description: i18n.t('settings.descriptions.preciseSeeking'),
							type: 'switch' as const,
							value: preciseSeeking,
							onValueChange: (value: boolean) => PersistStatus.set('music.preciseSeeking', value),
						},
					]
					: []),
			],
		},
		{
			title: i18n.t('settings.sections.customSource'),
			data: [
				{ id: 'sourceManagement', title: i18n.t('settings.items.sourceManagement'), type: 'link' },
				{
					id: '7',
					title: i18n.t('settings.items.sourceStatus'),
					type: 'value',
					value:
						apiState == '正常'
							? i18n.t('settings.items.normal')
							: i18n.t('settings.items.exception'),
				},
			],
		},
		{
			title: backupText.section,
			data: [
				{ id: 'exportConfig', title: backupText.export, type: 'link' },
				{ id: 'importConfig', title: backupText.import, type: 'link' },
			],
		},
		{
			title: i18n.t('settings.sections.qualitySelection'),
			data: [{ id: '10', title: i18n.t('settings.items.currentQuality'), type: 'value' }],
		},
	]
	const toggleAutoCacheLocalMenu = (
		<MenuView
			onPressAction={({ nativeEvent: { event } }) => {
				switch (event) {
					case 'on':
						myTrackPlayer.toggleAutoCacheLocal(true)
						break
					case 'off':
						myTrackPlayer.toggleAutoCacheLocal(false)
						break
				}
			}}
			actions={[
				{ id: 'on', title: i18n.t('settings.actions.autoCacheLocal.yes') },
				{ id: 'off', title: i18n.t('settings.actions.autoCacheLocal.no') },
			]}
		>
			<TouchableOpacity style={styles.menuTrigger}>
				<Text style={styles.menuTriggerText}>
					{/* 此处加空格为了增大点击区域 */}
					{autoCacheLocal == true
						? '             ' + i18n.t('settings.actions.autoCacheLocal.yes')
						: '             ' + i18n.t('settings.actions.autoCacheLocal.no')}
				</Text>
			</TouchableOpacity>
		</MenuView>
	)
	const togglePreloadNextTrackMenu = (
		<MenuView
			onPressAction={({ nativeEvent: { event } }) => myTrackPlayer.togglePreloadNextTrack(event === 'on')}
			actions={[
				{ id: 'on', title: i18n.t('settings.actions.preloadNextTrack.yes') },
				{ id: 'off', title: i18n.t('settings.actions.preloadNextTrack.no') },
			]}
		>
			<TouchableOpacity style={styles.menuTrigger}>
				<Text style={styles.menuTriggerText}>{preloadNextTrack ? i18n.t('settings.actions.preloadNextTrack.yes') : i18n.t('settings.actions.preloadNextTrack.no')}</Text>
			</TouchableOpacity>
		</MenuView>
	)
	const toggleIsCachedIconVisibleMenu = (
		<MenuView
			onPressAction={({ nativeEvent: { event } }) => {
				switch (event) {
					case 'on':
						myTrackPlayer.toggleIsCachedIconVisible(true)
						break
					case 'off':
						myTrackPlayer.toggleIsCachedIconVisible(false)
						break
				}
			}}
			actions={[
				{ id: 'on', title: i18n.t('settings.actions.isCachedIconVisible.yes') },
				{ id: 'off', title: i18n.t('settings.actions.isCachedIconVisible.no') },
			]}
		>
			<TouchableOpacity style={styles.menuTrigger}>
				<Text style={styles.menuTriggerText}>
					{/* 此处加空格为了增大点击区域 */}
					{isCachedIconVisible == true
						? '             ' + i18n.t('settings.actions.isCachedIconVisible.yes')
						: '             ' + i18n.t('settings.actions.isCachedIconVisible.no')}
				</Text>
			</TouchableOpacity>
		</MenuView>
	)
	const toggleSongsNumsToLoadMenu = (
		<MenuView
			onPressAction={({ nativeEvent: { event } }) => {
				PersistStatus.set('music.songsNumsToLoad', parseInt(event))
				songsNumsToLoadStore.setValue(parseInt(event))
			}}
			actions={[
				{ id: '100', title: '100' },
				{ id: '200', title: '200' },
				{ id: '300', title: '300' },
			]}
		>
			<TouchableOpacity style={styles.menuTrigger}>
				<Text style={styles.menuTriggerText}>{'             ' + songsNumsToLoad}</Text>
			</TouchableOpacity>
		</MenuView>
	)
	const DismissPlayerSymbol = () => {
		const { top } = useSafeAreaInsets()
		return (
			<View style={[styles.dismissSymbol, { top: top - 25 }]}>
				<View style={styles.dismissBar} />
			</View>
		)
	}
	const handleClearCache = async () => {
		try {
			await myTrackPlayer.clearCache()
			Alert.alert(
				i18n.t('settings.actions.cache.success'),
				i18n.t('settings.actions.cache.successMessage'),
			)
		} catch (error) {
			Alert.alert(
				i18n.t('settings.actions.cache.error'),
				i18n.t('settings.actions.cache.errorMessage'),
			)
			console.error(error)
		}
	}
	const changeLanguageMenu = (
		<MenuView
			onPressAction={({ nativeEvent: { event } }) => {
				switch (event) {
					case 'zh':
						changeLanguage('zh')
						break
					case 'en':
						changeLanguage('en')
						break
				}
			}}
			actions={[
				{ id: 'zh', title: '中文' },
				{ id: 'en', title: 'English' },
			]}
		>
			<TouchableOpacity style={styles.menuTrigger}>
				<Text style={styles.menuTriggerText}>{language == 'zh' ? '中文' : 'English'}</Text>
			</TouchableOpacity>
		</MenuView>
	)
	const themeMenu = (
		<MenuView
			onPressAction={({ nativeEvent: { event } }) => {
				if (event === 'system' || event === 'light' || event === 'dark') {
					setThemeMode(event)
				}
			}}
			actions={[
				{
					id: 'system',
					title: i18n.t('settings.actions.theme.system'),
					state: themeMode === 'system' ? 'on' : 'off',
				},
				{
					id: 'light',
					title: i18n.t('settings.actions.theme.light'),
					state: themeMode === 'light' ? 'on' : 'off',
				},
				{
					id: 'dark',
					title: i18n.t('settings.actions.theme.dark'),
					state: themeMode === 'dark' ? 'on' : 'off',
				},
			]}
		>
			<TouchableOpacity style={styles.menuTrigger}>
				<Text style={styles.menuTriggerText}>{themeLabel}</Text>
			</TouchableOpacity>
		</MenuView>
	)

	const checkForUpdates = async () => {
		setIsLoading(true)
		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error('请求超时')), 10000),
		)
		try {
			const result = await Promise.race([
				fetch('https://api.github.com/repos/Freakboy/Cymusic/releases/latest'),
				timeoutPromise,
			])
			if (!(result instanceof Response)) {
				throw new Error('非预期的结果类型')
			}

			if (!result.ok) {
				throw new Error(`HTTP error! status: ${result.status}`)
			}
			const data = await result.json()
			const latestVersion = data.tag_name
			logInfo(CURRENT_VERSION + 'CURRENT_VERSIONCURRENT_VERSION' + latestVersion)

			if (isNewerRelease(latestVersion, CURRENT_VERSION, Constants.expoConfig?.ios?.buildNumber)) {
				Alert.alert(
					i18n.t('settings.actions.checkUpdate.available'),
					`${i18n.t('settings.actions.checkUpdate.message')} ${latestVersion}`,
					[
						{
							text: i18n.t('settings.actions.checkUpdate.ok'),
							onPress: () => Linking.openURL(data.html_url),
						},
						{
							text: i18n.t('settings.actions.checkUpdate.cancel'),
							onPress: () => {},
							style: 'cancel',
						},
					],
				)
			} else {
				Alert.alert(
					i18n.t('settings.actions.checkUpdate.notAvailable'),
					i18n.t('settings.actions.checkUpdate.notAvailableMessage'),
				)
			}
		} catch (error) {
			logError(i18n.t('settings.actions.checkUpdate.error'), error)
			Alert.alert(
				i18n.t('settings.actions.checkUpdate.error'),
				i18n.t('settings.actions.checkUpdate.errorMessage'),
			)
		} finally {
			setIsLoading(false)
		}
	}

	const backupError = (error: unknown) => {
		Alert.alert(backupText.error, error instanceof Error && error.message === backupText.busy
			? backupText.busy : error instanceof Error && error.message === CONFIG_BACKUP_EXPORT_UNSUPPORTED
				? backupText.exportUnsupported : backupText.errorMessage)
	}
	const handleConfigBackup = async (action: 'import' | 'export') => {
		if (backupActive.current) return
		backupActive.current = true
		setBackupBusy(true)
		const finish = () => { backupActive.current = false; setBackupBusy(false) }
		if (action === 'export') {
			Alert.alert(backupText.exportTitle, backupText.exportWarning, [
				{ text: backupText.cancel, style: 'cancel', onPress: finish },
				{ text: backupText.share, onPress: () => {
					void shareConfigBackup().catch(backupError).finally(finish)
				} },
			], { cancelable: false })
			return
		}
		try {
			const backup = await pickConfigBackup()
			if (!backup) { finish(); return }
			const counts = configBackupPreview(backup)
			const summary = backupText.preview.replace(/%\{(\w+)\}/g, (_match, key: keyof typeof counts) => String(counts[key]))
			Alert.alert(backupText.previewTitle, `${summary}\n\n${backupText.importWarning}`, [
				{ text: backupText.cancel, style: 'cancel', onPress: finish },
				{ text: backupText.confirm, style: 'destructive', onPress: () => {
					void applyConfigBackup(backup, backupText.busy).then(() => {
						Alert.alert(backupText.done, backupText.doneMessage)
					}).catch(backupError).finally(finish)
				} },
			], { cancelable: false })
		} catch (error) {
			backupError(error)
			finish()
		}
	}

	const renderItem = (item: SettingItem, index: number, sectionData: SettingItem[]) => {
		const itemStyle = [
			styles.item,
			index === 0 && styles.firstItem,
			index === sectionData.length - 1 && styles.lastItem,
		]
		if (item.type === 'switch') {
			return (
				<View key={item.id}>
					<View style={[itemStyle, styles.switchItem]}>
						<View style={styles.switchHeader}>
							<Text style={[styles.itemText, styles.switchTitle]}>{item.title}</Text>
							<Switch
								testID={`settings.${item.id}`}
								value={item.value}
								onValueChange={item.onValueChange}
								accessibilityLabel={item.title}
								accessibilityHint={item.description}
							/>
						</View>
						<Text style={styles.itemDescription}>{item.description}</Text>
					</View>
					{index !== sectionData.length - 1 && <View style={styles.separator} />}
				</View>
			)
		}
		return (
			<View key={item.id}>
				<TouchableOpacity
					key={item.id}
					accessibilityRole="button"
					accessibilityLabel={item.title}
					disabled={backupBusy && (item.id === 'exportConfig' || item.id === 'importConfig')}
					style={itemStyle}
					onPress={() => {
						if (item.id === 'exportConfig' || item.id === 'importConfig') {
							void handleConfigBackup(item.id === 'exportConfig' ? 'export' : 'import')
							return
						}
						if (item.id === 'sourceManagement') {
							router.push('/(modals)/sourceManagement')
							return
						}
						if (item.title === i18n.t('settings.items.viewLogs')) {
							router.push('/(modals)/logScreen')
						}
						if (item.title === i18n.t('settings.items.projectLink')) {
							Linking.openURL('https://github.com/gyc-12/Cymusic').catch((err) =>
								logError("Couldn't load page", err),
							)
						} else if (item.type === 'link') {
							if (item.title === i18n.t('settings.items.clearPlaylist')) {
								Alert.alert(
									i18n.t('settings.actions.clearPlaylist.title'),
									i18n.t('settings.actions.clearPlaylist.message'),
									[
										{ text: i18n.t('settings.actions.clearPlaylist.cancel'), style: 'cancel' },
										{
											text: i18n.t('settings.actions.clearPlaylist.confirm'),
											onPress: () => myTrackPlayer.clearToBePlayed(),
										},
									],
								)
							} else if (item.title === 'CyMusic') {
								showToast('CyMusic', 'success')
							}
							// logInfo(`Navigate to ${item.title}`)
						} else if (item.title === i18n.t('settings.items.checkUpdate')) {
							checkForUpdates()
						} else if (item.title === i18n.t('settings.items.clearCache')) {
							handleClearCache()
						}
					}}
				>
					{item.icon && <Image source={item.icon} style={styles.icon} />}
					<View style={styles.itemContent}>
						<Text style={styles.itemText}>{item.title}</Text>
						{item.id === 'sourceManagement' && selectedSource && (
							<Text numberOfLines={1} style={[styles.itemValue, styles.sourceValue]}>{selectedSource.name}</Text>
						)}
						{item.type === 'value' && <Text style={styles.itemValue}>{item.value}</Text>}
						{item.title === i18n.t('settings.items.currentQuality') && (
							<MusicQualityMenu currentQuality={currentQuality} onSelectQuality={setCurrentQuality} />
						)}
						{(item.type === 'link' || item.title === i18n.t('settings.items.projectLink')) &&
							!item.icon && <Text style={styles.arrowRight}>{'>'}</Text>}
						{item.title === i18n.t('settings.items.autoCacheLocal') && toggleAutoCacheLocalMenu}
						{item.title === i18n.t('settings.items.preloadNextTrack') && togglePreloadNextTrackMenu}
						{item.title === i18n.t('settings.items.changeLanguage') && changeLanguageMenu}
						{item.title === i18n.t('settings.items.theme') && themeMenu}
						{item.title === i18n.t('settings.items.isCachedIconVisible') &&
							toggleIsCachedIconVisibleMenu}
						{item.title === i18n.t('settings.items.songsNumsToLoad') && toggleSongsNumsToLoadMenu}
					</View>
				</TouchableOpacity>
				{index !== sectionData.length - 1 && <View style={styles.separator} />}
			</View>
		)
	}
	const GlobalLoading = () => (
		<View style={styles.loadingOverlay}>
			<ActivityIndicator size="large" color={colors.loading} />
		</View>
	)
	/*
  1. Create the config
*/
	const toastConfig = {
		/*
	  Overwrite 'success' type,
	  by modifying the existing `BaseToast` component
	*/
		success: (props) => (
			<BaseToast
				{...props}
				style={{
					borderLeftColor: colors.toastAccent,
					backgroundColor: colors.toastBackground,
				}}
				contentContainerStyle={{ paddingHorizontal: 15 }}
				text1Style={{
					fontSize: 15,
					fontWeight: '400',
					color: colors.toastAccent,
				}}
			/>
		),
		/*
	  Overwrite 'error' type,
	  by modifying the existing `ErrorToast` component
	*/
		error: (props) => (
			<ErrorToast
				{...props}
				style={{
					borderLeftColor: colors.toastAccent,
					backgroundColor: colors.toastBackground,
				}}
				contentContainerStyle={{ paddingHorizontal: 15 }}
				text1Style={{
					fontSize: 15,
					fontWeight: '400',
					color: colors.toastAccent,
				}}
			/>
		),
		/*
	  Or create a completely new type - `tomatoToast`,
	  building the layout from scratch.
  
	  I can consume any custom `props` I want.
	  They will be passed when calling the `show` method (see below)
	*/
	}
	return (
		<View style={styles.container}>
			<DismissPlayerSymbol />
			<Text style={styles.header}>{i18n.t('settings.title')}</Text>
			<ScrollView style={styles.scrollView}>
				{settingsData.map((section, index) => (
					<View key={index} style={styles.section}>
						<Text style={styles.sectionTitle}>{section.title}</Text>
						<View style={styles.sectionContent}>{section.data.map(renderItem)}</View>
					</View>
				))}
			</ScrollView>
			{isLoading && <GlobalLoading />}
			<Toast config={toastConfig} />
		</View>
	)
}

const createStyles = (colors: ThemeColors) =>
	StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: colors.background,
	},
	dismissSymbol: {
		position: 'absolute',
		left: 0,
		right: 0,
		flexDirection: 'row',
		justifyContent: 'center',
		zIndex: 1,
	},
	dismissBar: {
		width: 50,
		height: 8,
		borderRadius: 8,
		backgroundColor: colors.dismissBar,
		opacity: 0.7,
	},
	header: {
		fontSize: 34,
		fontWeight: 'bold',
		padding: 20,
		paddingTop: 50,
		color: colors.text,
	},
	scrollView: {
		flex: 1,
	},
	section: {
		marginBottom: 20,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: colors.text,
		marginLeft: 20,
		marginBottom: 5,
	},
	item: {
		minHeight: 44,
		flexDirection: 'row',
		alignItems: 'center',
		padding: 16,
		// 移除 borderBottomWidth 和 borderBottomColor
	},
	firstItem: {
		borderBottomWidth: 0,
	},
	lastItem: {
		borderBottomWidth: 0, // 确保最后一项没有底部边框
	},
	separator: {
		left: 16,
		right: 16,
		height: 1,
		backgroundColor: colors.maximumTrackTintColor,
	},
	sectionContent: {
		backgroundColor: colors.surfaceElevated,
		borderRadius: 10,
		marginHorizontal: 16,
		overflow: 'hidden', // 确保圆角不被分隔线覆盖
	},
	icon: {
		width: 30,
		height: 30,
		marginRight: 10,
		borderRadius: 6,
	},
	itemContent: {
		flex: 1,
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
	},
	itemText: {
		fontSize: 16,
		color: colors.text,
	},
	switchItem: {
		flexDirection: 'column',
		alignItems: 'stretch',
	},
	switchHeader: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
	},
	switchTitle: {
		flex: 1,
		marginRight: 12,
	},
	itemDescription: {
		marginTop: 8,
		fontSize: 13,
		lineHeight: 19,
		color: colors.textMuted,
	},
	itemValue: {
		fontSize: 16,
		color: colors.textMuted,
	},
	sourceValue: { flex: 1, textAlign: 'right', marginHorizontal: 12 },
	arrowRight: {
		fontSize: 18,
		color: colors.textMuted,
	},
	menuTrigger: {
		minWidth: 44,
		minHeight: 44,
		marginVertical: -12,
		justifyContent: 'flex-end',
		flexDirection: 'row',
		alignItems: 'center',
	},
	menuTriggerText: {
		fontSize: 16,
		color: colors.textMuted,
	},
	loadingOverlay: {
		position: 'absolute',
		left: 0,
		right: 0,
		top: 0,
		bottom: 0,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: colors.overlay,
	},
	})

export default SettingModal
