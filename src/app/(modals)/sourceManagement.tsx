import { ThemeColors } from '@/constants/tokens'
import myTrackPlayer from '@/helpers/trackPlayerIndex'
import {
	assertSourceIdle,
	describeSourceChannels,
	fetchManagedSourceScript,
	importManagedSource,
	saveSourceList,
	testSourceChannels,
	updateManagedSource,
} from '@/helpers/sourceManagement'
import { useThemeColors } from '@/hooks/useAppTheme'
import { useSourceSearchText } from '@/locales/sourceSearch'
import { musicApiSelectedStore, musicApiStore } from '@/player/PlayerStore'
import { Ionicons } from '@expo/vector-icons'
import { MenuView } from '@react-native-menu/menu'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { Stack, router } from 'expo-router'
import { useMemo, useRef, useState } from 'react'
import {
	ActivityIndicator,
	Alert,
	Pressable,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function SourceManagementScreen() {
	const colors = useThemeColors()
	const styles = useMemo(() => createStyles(colors), [colors])
	const text = useSourceSearchText()
	const sources = musicApiStore.useValue() || []
	const selected = musicApiSelectedStore.useValue()
	const [url, setUrl] = useState('')
	const [busy, setBusy] = useState(false)
	const locked = useRef(false)
	const [status, setStatus] = useState<Record<string, string>>({})
	const [error, setError] = useState('')
	const run = async (action: () => Promise<void> | void) => {
		if (locked.current) return
		locked.current = true
		setBusy(true)
		setError('')
		try {
			assertSourceIdle(text.busy)
			await action()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			locked.current = false
			setBusy(false)
		}
	}
	const importUrl = () =>
		run(async () => {
			const target = url.trim()
			await importManagedSource(await fetchManagedSourceScript(target), text.busy, target)
			setUrl('')
		})
	const importFile = () =>
		run(async () => {
			const result = await DocumentPicker.getDocumentAsync({
				type: '*/*',
				copyToCacheDirectory: true,
				multiple: false,
			})
			if (result.canceled) return
			await importManagedSource(await new File(result.assets[0].uri).text(), text.busy)
		})
	const move = (id: string, offset: number) =>
		run(() => {
			const next = [...(musicApiStore.getValue() || [])]
			const index = next.findIndex((source) => source.id === id)
			if (index < 0 || !next[index + offset]) return
			;[next[index], next[index + offset]] = [next[index + offset], next[index]]
			saveSourceList(next)
		})
	const button = (label: string, action: () => void, disabled = false) => (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled: busy || disabled }}
			disabled={busy || disabled}
			onPress={action}
			style={[styles.button, (busy || disabled) && styles.disabled]}
		>
			<Text style={styles.buttonText}>{label}</Text>
		</Pressable>
	)
	return (
		<SafeAreaView style={styles.container}>
			<Stack.Screen options={{ title: text.sources, headerShown: false }} />
			<View style={styles.header}>
				<Text style={styles.title}>{text.sources}</Text>
				<Pressable
					accessibilityRole="button"
					disabled={busy}
					onPress={() => router.back()}
					style={styles.more}
				>
					<Text style={styles.buttonText}>{text.back}</Text>
				</Pressable>
			</View>
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
				<View style={styles.section}>
					<Text style={styles.sectionTitle}>{text.importSource}</Text>
					<View style={styles.group}>
						<TextInput
							accessibilityLabel={text.url}
							placeholder={text.url}
							placeholderTextColor={colors.placeholder}
							value={url}
							onChangeText={setUrl}
							editable={!busy}
							autoCapitalize="none"
							autoCorrect={false}
							keyboardType="url"
							style={styles.input}
						/>
						{button(
							text.importUrl,
							() => {
								void importUrl()
							},
							!url.trim(),
						)}
						{button(text.importFile, () => {
							void importFile()
						})}
					</View>
					<Text style={styles.footer}>{text.trust}</Text>
				</View>
				{busy && <ActivityIndicator color={colors.primary} />}
				{!!error && (
					<Text accessibilityRole="alert" style={styles.error}>
						{text.failed}: {error}
					</Text>
				)}
				<View style={styles.section}>
					<Text style={styles.sectionTitle}>{text.sources}</Text>
					<View style={styles.group}>
						{sources.length === 0 && <Text style={styles.footer}>{text.emptySources}</Text>}
						{sources.map((source, index) => (
							<View key={source.id} style={[styles.source, index > 0 && styles.separator]}>
								<View style={styles.sourceHeader}>
									<Pressable
										accessibilityRole="button"
										accessibilityLabel={`${source.name}: ${text.select}`}
										accessibilityState={{
											selected: selected?.id === source.id,
											disabled: busy || source.enabled === false || selected?.id === source.id,
										}}
										disabled={busy || source.enabled === false || selected?.id === source.id}
										style={styles.selectSource}
										onPress={() =>
											void run(async () => {
												await myTrackPlayer.setMusicApiAsSelectedById(source.id)
											})
										}
									>
										<Text style={styles.name}>{source.name}</Text>
										{selected?.id === source.id && (
											<Ionicons name="checkmark" size={22} color={colors.primary} />
										)}
									</Pressable>
									<MenuView
										actions={[
											{ id: 'capabilities', title: text.channels },
											{
												id: 'select',
												title: text.select,
												state: selected?.id === source.id ? 'on' : 'off',
												attributes: {
													disabled: busy || source.enabled === false || selected?.id === source.id,
												},
											},
											{
												id: 'reload',
												title: text.reload,
												attributes: {
													disabled: busy || source.enabled === false || selected?.id !== source.id,
												},
											},
											{
												id: 'update',
												title: text.update,
												attributes: {
													disabled: busy,
													hidden: typeof source.importUrl !== 'string' || !source.importUrl.trim(),
												},
											},
											{
													id: 'test',
												title: text.test,
												attributes: {
														disabled: busy || source.enabled === false,
												},
											},
											{ id: 'up', title: text.up, attributes: { disabled: busy || index === 0 } },
											{
												id: 'down',
												title: text.down,
												attributes: { disabled: busy || index === sources.length - 1 },
											},
											{
												id: 'delete',
												title: text.delete,
												attributes: { disabled: busy, destructive: true },
											},
										]}
										onPressAction={({ nativeEvent: { event } }) => {
											if (busy) return
											switch (event) {
												case 'capabilities':
													Alert.alert(
														source.name,
														[
															text.channels,
															...describeSourceChannels(
																selected?.id === source.id ? selected : source,
															).map(
																(channel) =>
																	`${{ tx: text.channelTx, wy: text.channelWy, kg: text.channelKg, kw: text.channelKw, mg: text.channelMg }[channel.id]}: ${text[channel.state]}${channel.qualitys.length ? ` (${channel.qualitys.join(' / ')})` : ''}`,
															),
															text.channelScope,
														].join('\n'),
													)
													break
												case 'select':
												case 'reload':
													void run(async () => {
														await myTrackPlayer.setMusicApiAsSelectedById(source.id)
													})
													break
												case 'update':
													void run(() => updateManagedSource(source.id, text.busy))
													break
												case 'test':
													void run(async () => {
														setStatus((previous) => ({ ...previous, [source.id]: text.testing }))
														try {
													const results = await testSourceChannels(source.id, text.busy)
													const names = { tx: text.channelTx, wy: text.channelWy, kg: text.channelKg, kw: text.channelKw, mg: text.channelMg }
													const summary = results.map((result) => {
														const state = result.urlResolved ? text.resolved : result.state === 'failed' ? text.failed : text[result.state]
														return `${names[result.id]}: ${state}${result.error ? ` (${result.error})` : ''}`
													}).join('\n')
													setStatus((previous) => ({ ...previous, [source.id]: summary }))
														} catch (cause) {
															setStatus((previous) => ({
																...previous,
																[source.id]: cause instanceof Error ? cause.message : String(cause),
															}))
														}
													})
													break
												case 'up':
													void move(source.id, -1)
													break
												case 'down':
													void move(source.id, 1)
													break
												case 'delete':
													Alert.alert(text.delete, text.confirmDelete, [
														{ text: text.cancel, style: 'cancel' },
														{
															text: text.delete,
															style: 'destructive',
															onPress: () => {
																void run(() => myTrackPlayer.deleteMusicApiById(source.id))
															},
														},
													])
													break
											}
										}}
									>
										<Pressable
											accessibilityRole="button"
											accessibilityLabel={`${source.name}: ${text.more}`}
											accessibilityState={{ disabled: busy }}
											disabled={busy}
											style={styles.more}
										>
											<Ionicons name="ellipsis-horizontal" size={22} color={colors.primary} />
										</Pressable>
									</MenuView>
								</View>
								<Text style={styles.description}>
									{[source.author, source.version, source.scriptType || 'cymusic']
										.filter(Boolean)
										.join(' / ')}
								</Text>
								<View style={styles.sourceHeader}>
									<Text style={styles.description}>{text.enabled}</Text>
									<Switch
										accessibilityLabel={`${source.name}: ${text.enabled}`}
										disabled={busy}
										value={source.enabled !== false}
										onValueChange={(enabled) => {
											void run(() => {
												if (!enabled && musicApiSelectedStore.getValue()?.id === source.id)
													throw new Error(text.disableSelected)
												saveSourceList(
													(musicApiStore.getValue() || []).map((item) =>
														item.id === source.id ? { ...item, enabled } : item,
													),
												)
											})
										}}
									/>
								</View>
								{!!status[source.id] && <Text style={styles.description}>{status[source.id]}</Text>}
							</View>
						))}
					</View>
					<Text style={styles.footer}>{text.resolver}</Text>
					<Text style={styles.footer}>{text.channelScope}</Text>
					<Text style={styles.footer}>{text.testScope}</Text>
				</View>
			</ScrollView>
		</SafeAreaView>
	)
}

const createStyles = (colors: ThemeColors) =>
	StyleSheet.create({
		container: { flex: 1, backgroundColor: colors.background },
		header: {
			flexDirection: 'row',
			justifyContent: 'space-between',
			alignItems: 'center',
			paddingHorizontal: 16,
		},
		title: { color: colors.text, fontSize: 34, fontWeight: 'bold', flex: 1, paddingVertical: 20 },
		content: { paddingBottom: 120 },
		section: { marginBottom: 20 },
		sectionTitle: {
			fontSize: 18,
			fontWeight: '600',
			color: colors.text,
			marginLeft: 20,
			marginBottom: 5,
		},
		group: {
			backgroundColor: colors.surfaceElevated,
			borderRadius: 10,
			marginHorizontal: 16,
			overflow: 'hidden',
		},
		source: { padding: 16, gap: 8 },
		separator: {
			borderTopWidth: StyleSheet.hairlineWidth,
			borderTopColor: colors.maximumTrackTintColor,
		},
		sourceHeader: {
			flexDirection: 'row',
			alignItems: 'center',
			justifyContent: 'space-between',
			minHeight: 44,
		},
		selectSource: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
		more: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
		footer: {
			marginHorizontal: 20,
			marginTop: 8,
			color: colors.textMuted,
			fontSize: 13,
			lineHeight: 19,
		},
		name: { color: colors.text, fontSize: 16, flexShrink: 1 },
		description: { color: colors.textMuted, fontSize: 14, lineHeight: 21 },
		input: {
			color: colors.text,
			padding: 16,
			minHeight: 48,
		},
		button: {
			paddingHorizontal: 12,
			paddingVertical: 12,
			minHeight: 44,
			borderTopWidth: StyleSheet.hairlineWidth,
			borderTopColor: colors.maximumTrackTintColor,
		},
		buttonText: { color: colors.primary, fontSize: 16 },
		disabled: { opacity: 0.4 },
		error: { color: colors.error, lineHeight: 21 },
	})
