import { router } from 'expo-router'
import React from 'react'
import { MaterialCommunityIcons } from '@expo/vector-icons'
import { useThemeColors } from '@/hooks/useAppTheme'
import { Keyboard, Pressable } from 'react-native'
import i18n from '@/utils/i18n'

const AddPlayListButton = () => {
	const colors = useThemeColors()

	const showPlayList = () => {
		Keyboard.dismiss()
		router.push('/(modals)/importPlayList')
	}

	return (
		<Pressable
			onPress={showPlayList}
			accessibilityRole="button"
			accessibilityLabel={i18n.t('addToPlaylist.title')}
			style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
		>
			<MaterialCommunityIcons
				name="plus"
				size={27}
				color={colors.icon}
				accessible={false}
			/>
		</Pressable>
	)
}

export default AddPlayListButton
