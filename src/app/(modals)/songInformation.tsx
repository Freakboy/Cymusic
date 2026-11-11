import { useEffect, useState } from 'react'
import { ScrollView, View, Text, TouchableOpacity } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useThemeColors } from '@/hooks/useAppTheme'
import { musicApiStore } from '@/player/PlayerStore'
import { getSongInformationTrack, songInformation, songInformationSize } from '@/helpers/songInformation'
import { useSongInformationText } from '@/locales/songInformation'

export default function SongInformationModal() {
	const { token } = useLocalSearchParams<{ token: string }>()
	const track = getSongInformationTrack(token), apis = musicApiStore.useValue()
	const colors = useThemeColors(), insets = useSafeAreaInsets(), router = useRouter(), text = useSongInformationText()
	const [size, setSize] = useState<{ token: string; bytes: number }>()
	useEffect(() => {
		let active = true
		if (track) void songInformationSize(track, () => active && getSongInformationTrack(token) === track)
			.then((bytes) => { if (active && bytes !== undefined) setSize({ token, bytes }) }).catch(() => {})
		return () => { active = false }
	}, [token, track])
	const info = track ? songInformation(track, apis ?? []) : undefined
	const groups = [
		['title', 'artist', 'album', 'id', 'originalPlatform'], ['quality', 'format', 'size'], ['script', 'sourcePlatform', 'location'],
	] as const
	return <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }}>
		<View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 }}>
			<Text style={{ color: colors.text, fontSize: 24, fontWeight: '700' }}>{text.heading}</Text>
			<TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={text.close} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.primary }}>{text.close}</Text></TouchableOpacity>
		</View>
		{groups.map((rows, group) => <View key={group} style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 24, borderWidth: 0.5, borderColor: colors.textMuted }}>
			{rows.map((key, index) => {
				const value = key === 'size' ? (size?.token === token ? `${size.bytes.toLocaleString()} B` : undefined) : key === 'location' ? (info?.location ? text[info.location as 'cache' | 'local' | 'remote'] : undefined) : info?.[key]
				return <View key={key} style={{ padding: 16, borderTopWidth: index ? 0.5 : 0, borderColor: colors.textMuted }}>
					<Text style={{ color: colors.textMuted, fontSize: 13, marginBottom: 6 }}>{text[key]}</Text>
					<Text selectable style={{ color: colors.text, fontSize: 16 }}>{value || text.unknown}</Text>
				</View>
			})}
		</View>)}
	</ScrollView>
}
