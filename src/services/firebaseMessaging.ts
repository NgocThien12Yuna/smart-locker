import { PermissionsAndroid, Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';

export const setupFirebaseMessaging = async () => {
  try {
    // Android 13+
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );

      if (result !== PermissionsAndroid.RESULTS.GRANTED) {
        console.log('❌ Người dùng chưa cấp quyền thông báo');
        return null;
      }
    }

    const authStatus = await messaging().requestPermission();

    console.log('FCM AUTH STATUS:', authStatus);

    const token = await messaging().getToken();

    console.log('====================================');
    console.log('🔥 FCM TOKEN:');
    console.log(token);
    console.log('====================================');

    return token;
  } catch (error) {
    console.error('FCM SETUP ERROR:', error);
    return null;
  }
};