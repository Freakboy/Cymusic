import { ThemeColors } from '@/constants/tokens'
import myTrackPlayer from '@/helpers/trackPlayerIndex'
import {
	assertSourceIdle,
	describeSourceChannels,
	fetchManagedSourceScript,
	importManagedSource,
	saveSourceList,
	testCurrentSource,
	updateManagedSource,
} from '@/helpers/sourceManagement'
import { useThemeColors } from '@/hooks/useAppTheme'
import { useSourceSearchText } from '@/locales/sourceSearch'
import { musicApiSelectedStore, musicApiStore } from '@/player/PlayerStore'
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
				{button(text.back, () => router.back())}
			</View>
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
				<Text style={styles.description}>{text.resolver}</Text>
				<Text style={styles.description}>{text.channelScope}</Text>
				<Text style={styles.description}>{text.testScope}</Text>
				<View style={styles.card}>
					<Text style={styles.description}>{text.trust}</Text>
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
					<View style={styles.actions}>
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
				</View>
				{busy && <ActivityIndicator color={colors.primary} />}
				{!!error && (
					<Text accessibilityRole="alert" style={styles.error}>
						{text.failed}: {error}
					</Text>
				)}
				{sources.length === 0 && <Text style={styles.description}>{text.emptySources}</Text>}
				{sources.map((source, index) => (
					<View key={source.id} style={styles.card}>
						<Text style={styles.name}>
							{source.name}
							{selected?.id === source.id ? ` (${text.selected})` : ''}
						</Text>
						<Text style={styles.description}>
							{[source.author, source.version, source.scriptType || 'cymusic']
								.filter(Boolean)
								.join(' / ')}
						</Text>
						<Text style={styles.description}>{text.channels}</Text>
						{describeSourceChannels(selected?.id === source.id ? selected : source).map(
							(channel) => (
								<Text key={channel.id} style={styles.description}>
									{{ tx: text.channelTx, wy: text.channelWy, kg: text.channelKg, kw: text.channelKw, mg: text.channelMg }[channel.id]}: {text[channel.state]}
									{channel.qualitys.length ? ` (${channel.qualitys.join(' / ')})` : ''}
								</Text>
							),
						)}
						<View style={styles.header}>
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
						<View style={styles.actions}>
							{button(
								text.select,
								() => {
									void run(async () => {
										await myTrackPlayer.setMusicApiAsSelectedById(source.id)
									})
								},
								source.enabled === false || selected?.id === source.id,
							)}
							{button(
								text.reload,
								() => {
									void run(async () => {
										await myTrackPlayer.setMusicApiAsSelectedById(source.id)
									})
								},
								source.enabled === false || selected?.id !== source.id,
							)}
							{typeof source.importUrl === 'string' &&
								!!source.importUrl.trim() &&
								button(text.update, () => {
									void run(() => updateManagedSource(source.id, text.busy))
								})}
							{button(
								text.test,
								() => {
									void run(async () => {
										setStatus((previous) => ({ ...previous, [source.id]: text.testing }))
										try {
											await testCurrentSource(source.id, text)
											setStatus((previous) => ({ ...previous, [source.id]: text.resolved }))
										} catch (cause) {
											setStatus((previous) => ({
												...previous,
												[source.id]: `tx: ${cause instanceof Error ? cause.message : String(cause)}`,
											}))
										}
									})
								},
								source.enabled === false || selected?.id !== source.id,
							)}
							{button(
								text.up,
								() => {
									void move(source.id, -1)
								},
								index === 0,
							)}
							{button(
								text.down,
								() => {
									void move(source.id, 1)
								},
								index === sources.length - 1,
							)}
							{button(text.delete, () =>
								Alert.alert(text.delete, text.confirmDelete, [
									{ text: text.cancel, style: 'cancel' },
									{
										text: text.delete,
										style: 'destructive',
										onPress: () => {
											void run(() => myTrackPlayer.deleteMusicApiById(source.id))
										},
									},
								]),
							)}
						</View>
						{!!status[source.id] && <Text style={styles.description}>{status[source.id]}</Text>}
					</View>
				))}
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
		title: { color: colors.text, fontSize: 26, fontWeight: '700', flex: 1 },
		content: { padding: 16, paddingBottom: 120, gap: 16 },
		card: { backgroundColor: colors.surfaceMuted, borderRadius: 12, padding: 16, gap: 12 },
		name: { color: colors.text, fontSize: 18, fontWeight: '600' },
		description: { color: colors.textMuted, fontSize: 14, lineHeight: 21 },
		input: {
			color: colors.text,
			borderColor: colors.border,
			borderWidth: 1,
			borderRadius: 8,
			padding: 12,
			minHeight: 48,
		},
		actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
		button: {
			paddingHorizontal: 12,
			paddingVertical: 12,
			minHeight: 44,
			borderRadius: 8,
			backgroundColor: colors.surfaceElevated,
		},
		buttonText: { color: colors.primary, fontSize: 14 },
		disabled: { opacity: 0.4 },
		error: { color: colors.error, lineHeight: 21 },
	})
