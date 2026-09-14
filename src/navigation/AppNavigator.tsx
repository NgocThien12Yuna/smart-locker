import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  Alert,
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';

import {
  createNativeStackNavigator,
} from '@react-navigation/native-stack';

import {
  getInitialNotification,
  getMessaging,
  onNotificationOpenedApp,
} from '@react-native-firebase/messaging';

import HomeScreen from '../screens/HomeScreen';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import ShipperScreen from '../screens/ShipperScreen';
import ResidentScreen from '../screens/ResidentScreen';
import AdminScreen from '../screens/AdminScreen';
import HistoryScreen from '../screens/HistoryScreen';

import {
  useAuth,
} from '../context/AuthContext';

const Stack =
  createNativeStackNavigator();

const navigationRef =
  createNavigationContainerRef();

const PENDING_NOTIFICATION_KEY =
  '@smartlocker_pending_notification_v1';

type PendingNotification = {
  packageId: string;
  receiverPhone: string;
};

export default function AppNavigator() {
  const {
    currentUser,
  } = useAuth();

  const [
    navigationReady,
    setNavigationReady,
  ] = useState(false);

  const currentUserRef =
    useRef(currentUser);

  useEffect(() => {
    currentUserRef.current =
      currentUser;
  }, [currentUser]);

  const navigateToResident =
    useCallback(
      (
        pending:
          PendingNotification,
      ) => {
        if (
          !navigationRef.isReady()
        ) {
          return false;
        }

        navigationRef.navigate(
          'Resident' as never,
          {
            packageId:
              pending.packageId,
          } as never,
        );

        return true;
      },
      [],
    );

  const savePending =
    useCallback(
      async (
        pending:
          PendingNotification,
      ) => {
        await AsyncStorage.setItem(
          PENDING_NOTIFICATION_KEY,
          JSON.stringify(
            pending,
          ),
        );
      },
      [],
    );

  const clearPending =
    useCallback(
      async () => {
        await AsyncStorage.removeItem(
          PENDING_NOTIFICATION_KEY,
        );
      },
      [],
    );

  const handleNotificationOpen =
    useCallback(
      async (
        remoteMessage: any,
      ) => {
        const packageId =
          String(
            remoteMessage?.data
              ?.packageId ||
              '',
          ).trim();

        const receiverPhone =
          String(
            remoteMessage?.data
              ?.receiverPhone ||
              '',
          ).trim();

        if (!packageId) {
          return;
        }

        const pending = {
          packageId,
          receiverPhone,
        };

        const user =
          currentUserRef.current;

        const correctResident =
          user?.role ===
            'RESIDENT' &&
          (
            !receiverPhone ||
            user.phone ===
              receiverPhone
          );

        if (
          correctResident &&
          navigateToResident(
            pending,
          )
        ) {
          await clearPending();
          return;
        }

        await savePending(
          pending,
        );

        if (
          navigationRef.isReady()
        ) {
          navigationRef.navigate(
            'Home' as never,
          );
        }

        if (
          user &&
          receiverPhone &&
          user.phone !==
            receiverPhone
        ) {
          Alert.alert(
            'Thông báo thuộc tài khoản khác',
            `Kiện hàng này thuộc số ${receiverPhone}. Hãy chọn đúng tài khoản Cư dân để mở đơn.`,
          );
        }
      },
      [
        clearPending,
        navigateToResident,
        savePending,
      ],
    );

  useEffect(() => {
    const fcm =
      getMessaging();

    const unsubscribe =
      onNotificationOpenedApp(
        fcm,
        message => {
          handleNotificationOpen(
            message,
          );
        },
      );

    getInitialNotification(
      fcm,
    )
      .then(message => {
        if (message) {
          handleNotificationOpen(
            message,
          );
        }
      })
      .catch(error => {
        console.error(
          'GET INITIAL NOTIFICATION ERROR:',
          error,
        );
      });

    return unsubscribe;
  }, [
    handleNotificationOpen,
  ]);

  useEffect(() => {
    if (
      !navigationReady ||
      currentUser?.role !==
        'RESIDENT'
    ) {
      return;
    }

    const consumePending =
      async () => {
        try {
          const raw =
            await AsyncStorage.getItem(
              PENDING_NOTIFICATION_KEY,
            );

          if (!raw) {
            return;
          }

          const pending =
            JSON.parse(
              raw,
            ) as PendingNotification;

          if (
            !pending?.packageId
          ) {
            await clearPending();
            return;
          }

          if (
            pending.receiverPhone &&
            pending.receiverPhone !==
              currentUser.phone
          ) {
            return;
          }

          if (
            navigateToResident(
              pending,
            )
          ) {
            await clearPending();
          }
        } catch (error) {
          console.error(
            'CONSUME PENDING NOTIFICATION ERROR:',
            error,
          );
        }
      };

    consumePending();
  }, [
    currentUser,
    navigationReady,
    clearPending,
    navigateToResident,
  ]);

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() =>
        setNavigationReady(
          true,
        )
      }
    >
      <Stack.Navigator
        initialRouteName="Home"
      >
        <Stack.Screen
          name="Home"
          component={
            HomeScreen
          }
          options={{
            title:
              'SmartLocker',
          }}
        />

        <Stack.Screen
          name="Login"
          component={
            LoginScreen
          }
          options={{
            title:
              'Đăng nhập',
          }}
        />

        <Stack.Screen
          name="Register"
          component={
            RegisterScreen
          }
          options={{
            title:
              'Đăng ký',
          }}
        />

        <Stack.Screen
          name="Shipper"
          component={
            ShipperScreen
          }
          options={{
            title:
              'Gửi Hàng (Shipper)',
          }}
        />

        <Stack.Screen
          name="Resident"
          component={
            ResidentScreen
          }
          options={{
            title:
              'Nhận Hàng (Cư Dân)',
          }}
        />

        <Stack.Screen
          name="Admin"
          component={
            AdminScreen
          }
          options={{
            title:
              'Quản Lý Sơ Đồ Tủ',
          }}
        />

        <Stack.Screen
          name="History"
          component={
            HistoryScreen
          }
          options={{
            title:
              'Lịch Sử Giao Dịch',
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
