import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  getMessaging,
  getToken,
  onMessage,
  onTokenRefresh,
  requestPermission,
} from '@react-native-firebase/messaging';

import {
  useFocusEffect,
} from '@react-navigation/native';

import {
  API_BASE_URL,
} from '../config/api';

import {
  useAuth,
} from '../context/AuthContext';

type ResidentPackage = {
  id: string;
  phone: string;
  locker: string;
  size: string;
  sender: string;
  pickupOtp: string | null;
  otpExpiresAt: string | null;
  otpExpired: boolean;
  status:
    | 'READY'
    | 'PICKED_UP'
    | 'CANCELLED';
  createdAt: string;
  pickedUpAt?:
    | string
    | null;
};

const parseBackendDate = (
  value:
    | string
    | null
    | undefined,
) => {
  if (!value) {
    return null;
  }

  const normalized =
    value.includes('T')
      ? value
      : `${value.replace(' ', 'T')}Z`;

  const ms =
    new Date(
      normalized,
    ).getTime();

  return Number.isFinite(ms)
    ? ms
    : null;
};

const formatCreatedAt = (
  value: string,
) => {
  try {
    const ms =
      parseBackendDate(value);

    if (!ms) {
      return value;
    }

    return new Date(
      ms,
    ).toLocaleString(
      'vi-VN',
    );
  } catch {
    return value;
  }
};

const formatRemaining = (
  expiresAt:
    | string
    | null,
  nowMs: number,
) => {
  const expiresMs =
    parseBackendDate(
      expiresAt,
    );

  if (!expiresMs) {
    return 'Không xác định';
  }

  const seconds =
    Math.max(
      0,
      Math.floor(
        (expiresMs - nowMs) /
          1000,
      ),
    );

  const minutes =
    Math.floor(
      seconds / 60,
    );

  const remainSeconds =
    seconds % 60;

  return `${String(
    minutes,
  ).padStart(
    2,
    '0',
  )}:${String(
    remainSeconds,
  ).padStart(
    2,
    '0',
  )}`;
};

const OtpBoxes = ({
  otp,
}: {
  otp:
    | string
    | null;
}) => {
  const digits =
    String(otp || '')
      .padEnd(6, ' ')
      .slice(0, 6)
      .split('');

  return (
    <View
      style={styles.otpRow}
    >
      {digits.map(
        (
          digit,
          index,
        ) => (
          <View
            key={index}
            style={[
              styles.otpBox,
              digit.trim()
                ? styles.otpBoxFilled
                : null,
            ]}
          >
            <Text
              style={
                styles.otpDigit
              }
            >
              {digit.trim()
                ? digit
                : '•'}
            </Text>
          </View>
        ),
      )}
    </View>
  );
};

export default function ResidentScreen({
  navigation,
  route,
}: any) {
  const {
    currentUser,
    currentToken,
    logoutToHome,
  } = useAuth();

  const targetPackageId =
    String(
      route?.params
        ?.packageId ||
        '',
    );

  const [
    fcmStatus,
    setFcmStatus,
  ] = useState(
    'Đang khởi tạo thông báo...',
  );

  const [
    fcmTokenPreview,
    setFcmTokenPreview,
  ] = useState('');

  const [
    packages,
    setPackages,
  ] =
    useState<
      ResidentPackage[]
    >([]);

  const [
    isLoadingPackages,
    setIsLoadingPackages,
  ] = useState(false);

  const [
    isRefreshing,
    setIsRefreshing,
  ] = useState(false);

  const [
    packageError,
    setPackageError,
  ] = useState('');

  const [
    openingPackageId,
    setOpeningPackageId,
  ] = useState<
    string | null
  >(null);

  const [
    refreshingOtpId,
    setRefreshingOtpId,
  ] = useState<
    string | null
  >(null);

  const [
    nowMs,
    setNowMs,
  ] = useState(
    Date.now(),
  );

  useEffect(() => {
    const timer =
      setInterval(
        () => {
          setNowMs(
            Date.now(),
          );
        },
        1000,
      );

    return () =>
      clearInterval(timer);
  }, []);

  const loadPackages =
    useCallback(
      async (
        silent = false,
      ) => {
        if (
          !currentToken ||
          !currentUser ||
          currentUser.role !==
            'RESIDENT'
        ) {
          return;
        }

        if (!silent) {
          setIsLoadingPackages(
            true,
          );
        }

        try {
          setPackageError('');

          const response =
            await fetch(
              `${API_BASE_URL}/packages/my`,
              {
                headers: {
                  Authorization:
                    `Bearer ${currentToken}`,
                },
              },
            );

          const data =
            await response.json();

          if (
            !response.ok ||
            !data?.ok
          ) {
            throw new Error(
              data?.message ||
                `HTTP ${response.status}`,
            );
          }

          setPackages(
            Array.isArray(
              data.packages,
            )
              ? data.packages
              : [],
          );
        } catch (
          error: any
        ) {
          console.error(
            '❌ LOAD PACKAGES ERROR:',
            error,
          );

          setPackageError(
            error?.message ||
              'Không tải được danh sách kiện hàng.',
          );
        } finally {
          setIsLoadingPackages(
            false,
          );
          setIsRefreshing(
            false,
          );
        }
      },
      [
        currentToken,
        currentUser,
      ],
    );

  useFocusEffect(
    useCallback(() => {
      loadPackages();
    }, [loadPackages]),
  );

  useEffect(() => {
    if (
      !currentUser ||
      currentUser.role !==
        'RESIDENT' ||
      !currentToken
    ) {
      return;
    }

    let mounted = true;

    let unsubscribeTokenRefresh:
      | (() => void)
      | undefined;

    let unsubscribeForegroundMessage:
      | (() => void)
      | undefined;

    const registerDeviceOnBackend =
      async (
        fcmToken: string,
      ) => {
        const response =
          await fetch(
            `${API_BASE_URL}/devices/register`,
            {
              method:
                'POST',
              headers: {
                'Content-Type':
                  'application/json',
                Authorization:
                  `Bearer ${currentToken}`,
              },
              body:
                JSON.stringify({
                  fcmToken,
                  platform:
                    Platform.OS,
                }),
            },
          );

        let data: any =
          null;

        try {
          data =
            await response.json();
        } catch {
          // body không phải JSON
        }

        if (
          !response.ok ||
          !data?.ok
        ) {
          throw new Error(
            data?.message ||
              `HTTP ${response.status}`,
          );
        }
      };

    const updatePreview = (
      token: string,
    ) => {
      if (!mounted) {
        return;
      }

      setFcmTokenPreview(
        token.length > 24
          ? `${token.slice(0, 12)}...${token.slice(-8)}`
          : token,
      );
    };

    const setupNotifications =
      async () => {
        try {
          if (
            Platform.OS ===
              'android' &&
            Platform.Version >=
              33
          ) {
            const result =
              await PermissionsAndroid.request(
                PermissionsAndroid
                  .PERMISSIONS
                  .POST_NOTIFICATIONS,
              );

            if (
              result !==
              PermissionsAndroid
                .RESULTS
                .GRANTED
            ) {
              if (mounted) {
                setFcmStatus(
                  'Bạn chưa cấp quyền nhận thông báo.',
                );
              }

              return;
            }
          }

          const fcm =
            getMessaging();

          if (
            Platform.OS ===
            'ios'
          ) {
            await requestPermission(
              fcm,
            );
          }

          const token =
            await getToken(fcm);

          updatePreview(token);

          if (mounted) {
            setFcmStatus(
              'Đang liên kết thiết bị...',
            );
          }

          await registerDeviceOnBackend(
            token,
          );

          if (mounted) {
            setFcmStatus(
              `✅ Thiết bị đã liên kết với tài khoản ${currentUser.phone}.`,
            );
          }

          unsubscribeTokenRefresh =
            onTokenRefresh(
              fcm,
              async newToken => {
                updatePreview(
                  newToken,
                );

                try {
                  await registerDeviceOnBackend(
                    newToken,
                  );

                  if (
                    mounted
                  ) {
                    setFcmStatus(
                      `✅ Thiết bị đã liên kết với tài khoản ${currentUser.phone}.`,
                    );
                  }
                } catch (
                  error
                ) {
                  console.error(
                    'SAVE REFRESHED TOKEN ERROR:',
                    error,
                  );
                }
              },
            );

          unsubscribeForegroundMessage =
            onMessage(
              fcm,
              async remoteMessage => {
                console.log(
                  '📩 FCM FOREGROUND:',
                  remoteMessage,
                );

                await loadPackages(
                  true,
                );

                const title =
                  remoteMessage
                    .notification
                    ?.title ||
                  'SmartLocker';

                const body =
                  remoteMessage
                    .notification
                    ?.body ||
                  'Bạn có kiện hàng mới.';

                Alert.alert(
                  title,
                  body,
                );
              },
            );
        } catch (
          error: any
        ) {
          console.error(
            '❌ FCM SETUP ERROR:',
            error,
          );

          if (mounted) {
            setFcmStatus(
              `Lỗi liên kết thiết bị: ${
                error?.message ||
                String(error)
              }`,
            );
          }
        }
      };

    setupNotifications();

    return () => {
      mounted = false;
      unsubscribeTokenRefresh?.();
      unsubscribeForegroundMessage?.();
    };
  }, [
    currentUser?.phone,
    currentUser?.role,
    currentToken,
    loadPackages,
  ]);

  const readyPackages =
    useMemo(
      () =>
        packages.filter(
          item =>
            item.status ===
            'READY',
        ),
      [packages],
    );

  const handleRefresh =
    () => {
      setIsRefreshing(true);
      loadPackages(true);
    };

  const handleRefreshOtp =
    async (
      pkg: ResidentPackage,
    ) => {
      if (!currentToken) {
        return;
      }

      setRefreshingOtpId(
        pkg.id,
      );

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/packages/${encodeURIComponent(
              pkg.id,
            )}/otp/refresh`,
            {
              method:
                'POST',
              headers: {
                'Content-Type':
                  'application/json',
                Authorization:
                  `Bearer ${currentToken}`,
              },
            },
          );

        const data =
          await response.json();

        if (
          !response.ok ||
          !data?.ok
        ) {
          throw new Error(
            data?.message ||
              `HTTP ${response.status}`,
          );
        }

        Alert.alert(
          '🔄 OTP mới',
          'OTP mới đã được cấp và tự động điền.',
        );

        await loadPackages(
          true,
        );
      } catch (
        error: any
      ) {
        Alert.alert(
          'Không cấp lại được OTP',
          error?.message ||
            'Có lỗi khi cấp lại OTP.',
        );
      } finally {
        setRefreshingOtpId(
          null,
        );
      }
    };

  const handleOpenLocker =
    async (
      pkg: ResidentPackage,
    ) => {
      if (
        !currentToken ||
        !pkg.pickupOtp
      ) {
        Alert.alert(
          'OTP chưa sẵn sàng',
          'OTP đã hết hạn hoặc chưa tải được. Hãy cấp lại OTP.',
        );

        return;
      }

      setOpeningPackageId(
        pkg.id,
      );

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/packages/${encodeURIComponent(
              pkg.id,
            )}/redeem`,
            {
              method:
                'POST',
              headers: {
                'Content-Type':
                  'application/json',
                Authorization:
                  `Bearer ${currentToken}`,
              },
              body:
                JSON.stringify({
                  otp:
                    pkg.pickupOtp,
                }),
            },
          );

        let data: any =
          null;

        try {
          data =
            await response.json();
        } catch {
          // ignore
        }

        if (
          !response.ok ||
          !data?.ok
        ) {
          if (
            data?.code ===
            'OTP_EXPIRED'
          ) {
            await loadPackages(
              true,
            );
          }

          throw new Error(
            data?.message ||
              `HTTP ${response.status}`,
          );
        }

        Alert.alert(
          '🔓 Mở tủ thành công',
          `${data.message}\n\n` +
            `Tủ: ${data.locker}\n` +
            `Chế độ: ${
              data.hardwareMode
                ? 'PHẦN CỨNG'
                : 'SOFTWARE MODE'
            }`,
        );

        await loadPackages(
          true,
        );
      } catch (
        error: any
      ) {
        console.error(
          '❌ REDEEM OTP ERROR:',
          error,
        );

        Alert.alert(
          'Không mở được tủ',
          error?.message ||
            'Không xác minh được OTP.',
        );
      } finally {
        setOpeningPackageId(
          null,
        );
      }
    };

  const handleLogout =
    () => {
      logoutToHome();

      navigation.reset({
        index: 0,
        routes: [
          {
            name:
              'Home',
          },
        ],
      });
    };

  if (
    !currentUser ||
    currentUser.role !==
      'RESIDENT'
  ) {
    return (
      <SafeAreaView
        style={
          styles.safeArea
        }
      >
        <View
          style={
            styles.centerBox
          }
        >
          <Text
            style={
              styles.lockIcon
            }
          >
            🔒
          </Text>

          <Text
            style={
              styles.centerTitle
            }
          >
            Chưa đăng nhập Cư dân
          </Text>

          <Text
            style={
              styles.centerText
            }
          >
            Vui lòng đăng nhập bằng tài khoản Cư dân để tiếp tục.
          </Text>

          <TouchableOpacity
            style={
              styles.primaryButton
            }
            onPress={() =>
              navigation.reset({
                index: 0,
                routes: [
                  {
                    name:
                      'Home',
                  },
                ],
              })
            }
          >
            <Text
              style={
                styles.primaryButtonText
              }
            >
              VỀ TRANG CHỦ
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={styles.safeArea}
    >
      <ScrollView
        contentContainerStyle={
          styles.container
        }
        refreshControl={
          <RefreshControl
            refreshing={
              isRefreshing
            }
            onRefresh={
              handleRefresh
            }
          />
        }
      >
        <View
          style={
            styles.headerCard
          }
        >
          <View>
            <Text
              style={
                styles.greeting
              }
            >
              Xin chào 👋
            </Text>

            <Text
              style={
                styles.phone
              }
            >
              {currentUser.phone}
            </Text>

            <Text
              style={
                styles.role
              }
            >
              Tài khoản Cư dân
            </Text>
          </View>

          <View
            style={
              styles.avatar
            }
          >
            <Text
              style={
                styles.avatarText
              }
            >
              🏠
            </Text>
          </View>
        </View>

        <View
          style={
            styles.infoCard
          }
        >
          <Text
            style={
              styles.infoTitle
            }
          >
            🔔 Firebase Notification
          </Text>

          <Text
            style={
              styles.infoText
            }
          >
            {fcmStatus}
          </Text>

          {!!fcmTokenPreview && (
            <Text
              style={
                styles.tokenPreview
              }
            >
              Thiết bị: {
                fcmTokenPreview
              }
            </Text>
          )}

          <Text
            style={
              styles.tapHint
            }
          >
            Khi app chạy nền hoặc đã đóng, thông báo vẫn hiện trên thanh trạng thái. Bấm vào thông báo sẽ mở đúng đơn hàng này.
          </Text>
        </View>

        <View
          style={
            styles.sectionHeader
          }
        >
          <Text
            style={
              styles.sectionTitle
            }
          >
            📦 Đơn chờ lấy
          </Text>

          <View
            style={
              styles.countBadge
            }
          >
            <Text
              style={
                styles.countText
              }
            >
              {
                readyPackages.length
              }
            </Text>
          </View>
        </View>

        {isLoadingPackages ? (
          <View
            style={
              styles.loadingCard
            }
          >
            <ActivityIndicator
              size="large"
            />

            <Text
              style={
                styles.loadingText
              }
            >
              Đang tải kiện hàng...
            </Text>
          </View>
        ) : packageError ? (
          <View
            style={
              styles.errorCard
            }
          >
            <Text
              style={
                styles.errorTitle
              }
            >
              ⚠️ Không tải được đơn
            </Text>

            <Text
              style={
                styles.errorText
              }
            >
              {packageError}
            </Text>

            <TouchableOpacity
              style={
                styles.retryButton
              }
              onPress={() =>
                loadPackages()
              }
            >
              <Text
                style={
                  styles.retryButtonText
                }
              >
                THỬ LẠI
              </Text>
            </TouchableOpacity>
          </View>
        ) : readyPackages.length ===
          0 ? (
          <View
            style={
              styles.emptyCard
            }
          >
            <Text
              style={
                styles.emptyIcon
              }
            >
              📭
            </Text>

            <Text
              style={
                styles.emptyTitle
              }
            >
              Chưa có kiện hàng
            </Text>

            <Text
              style={
                styles.emptyText
              }
            >
              Khi Shipper giao hàng, backend tự chọn tủ trống và Firebase sẽ báo về điện thoại.
            </Text>
          </View>
        ) : (
          readyPackages.map(
            pkg => {
              const expiresMs =
                parseBackendDate(
                  pkg.otpExpiresAt,
                );

              const expiredNow =
                pkg.otpExpired ||
                !expiresMs ||
                expiresMs <=
                  nowMs;

              const isOpening =
                openingPackageId ===
                pkg.id;

              const isRefreshingOtp =
                refreshingOtpId ===
                pkg.id;

              const isTarget =
                targetPackageId ===
                pkg.id;

              return (
                <View
                  key={pkg.id}
                  style={[
                    styles.packageCard,
                    isTarget &&
                      styles.targetPackageCard,
                  ]}
                >
                  {isTarget && (
                    <View
                      style={
                        styles.newBadge
                      }
                    >
                      <Text
                        style={
                          styles.newBadgeText
                        }
                      >
                        🔔 ĐƠN VỪA MỞ TỪ THÔNG BÁO
                      </Text>
                    </View>
                  )}

                  <View
                    style={
                      styles.packageTopRow
                    }
                  >
                    <View
                      style={
                        styles.packageIcon
                      }
                    >
                      <Text
                        style={{
                          fontSize:
                            26,
                        }}
                      >
                        📦
                      </Text>
                    </View>

                    <View
                      style={{
                        flex: 1,
                      }}
                    >
                      <Text
                        style={
                          styles.packageLocker
                        }
                      >
                        Tủ {pkg.locker}
                      </Text>

                      <Text
                        style={
                          styles.packageMeta
                        }
                      >
                        {formatCreatedAt(
                          pkg.createdAt,
                        )}
                      </Text>
                    </View>

                    <View
                      style={
                        styles.readyBadge
                      }
                    >
                      <Text
                        style={
                          styles.readyBadgeText
                        }
                      >
                        CHỜ LẤY
                      </Text>
                    </View>
                  </View>

                  <Text
                    style={
                      styles.packageId
                    }
                  >
                    Mã đơn: {pkg.id}
                  </Text>

                  <Text
                    style={
                      styles.otpLabel
                    }
                  >
                    OTP nhận hàng
                  </Text>

                  <OtpBoxes
                    otp={
                      expiredNow
                        ? null
                        : pkg.pickupOtp
                    }
                  />

                  {expiredNow ? (
                    <>
                      <View
                        style={
                          styles.expiredBadge
                        }
                      >
                        <Text
                          style={
                            styles.expiredText
                          }
                        >
                          ⏰ OTP đã hết hạn
                        </Text>
                      </View>

                      <TouchableOpacity
                        style={[
                          styles.refreshOtpButton,
                          isRefreshingOtp &&
                            styles.disabledButton,
                        ]}
                        disabled={
                          isRefreshingOtp
                        }
                        onPress={() =>
                          handleRefreshOtp(
                            pkg,
                          )
                        }
                      >
                        {isRefreshingOtp ? (
                          <ActivityIndicator
                            color="#FFFFFF"
                          />
                        ) : (
                          <Text
                            style={
                              styles.refreshOtpButtonText
                            }
                          >
                            🔄 CẤP LẠI OTP
                          </Text>
                        )}
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <View
                        style={
                          styles.autoFillBadge
                        }
                      >
                        <Text
                          style={
                            styles.autoFillText
                          }
                        >
                          ✅ OTP đã được tự động điền
                        </Text>
                      </View>

                      <Text
                        style={
                          styles.expiryText
                        }
                      >
                        Hết hạn sau:{' '}
                        <Text
                          style={{
                            fontWeight:
                              '900',
                          }}
                        >
                          {formatRemaining(
                            pkg.otpExpiresAt,
                            nowMs,
                          )}
                        </Text>
                      </Text>

                      <TouchableOpacity
                        style={[
                          styles.openButton,
                          (
                            !pkg.pickupOtp ||
                            isOpening
                          ) &&
                            styles.disabledButton,
                        ]}
                        disabled={
                          !pkg.pickupOtp ||
                          isOpening
                        }
                        onPress={() =>
                          handleOpenLocker(
                            pkg,
                          )
                        }
                      >
                        {isOpening ? (
                          <ActivityIndicator
                            color="#FFFFFF"
                          />
                        ) : (
                          <Text
                            style={
                              styles.openButtonText
                            }
                          >
                            🔓 MỞ TỦ {pkg.locker}
                          </Text>
                        )}
                      </TouchableOpacity>
                    </>
                  )}

                  <Text
                    style={
                      styles.oneTimeHint
                    }
                  >
                    OTP chỉ dùng một lần. Sau khi mở tủ thành công, đơn sẽ rời khỏi danh sách chờ lấy.
                  </Text>
                </View>
              );
            },
          )
        )}

        <TouchableOpacity
          style={
            styles.logoutButton
          }
          onPress={
            handleLogout
          }
        >
          <Text
            style={
              styles.logoutButtonText
            }
          >
            ĐĂNG XUẤT
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles =
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor:
        '#F2F2F7',
    },

    container: {
      padding: 18,
      paddingBottom: 40,
    },

    headerCard: {
      backgroundColor:
        '#34C759',
      borderRadius: 20,
      padding: 20,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent:
        'space-between',
      marginBottom: 16,
    },

    greeting: {
      color:
        'rgba(255,255,255,0.85)',
      fontSize: 14,
    },

    phone: {
      color: '#FFFFFF',
      fontSize: 25,
      fontWeight: '900',
      marginTop: 3,
    },

    role: {
      color: '#FFFFFF',
      fontSize: 13,
      fontWeight: '700',
      marginTop: 6,
    },

    avatar: {
      width: 62,
      height: 62,
      borderRadius: 31,
      backgroundColor:
        'rgba(255,255,255,0.20)',
      justifyContent:
        'center',
      alignItems: 'center',
    },

    avatarText: {
      fontSize: 30,
    },

    infoCard: {
      backgroundColor:
        '#EAF4FF',
      borderColor:
        '#B7DAFF',
      borderWidth: 1,
      borderRadius: 14,
      padding: 16,
      marginBottom: 20,
    },

    infoTitle: {
      color: '#0A4A7A',
      fontWeight: '800',
      fontSize: 16,
      marginBottom: 7,
    },

    infoText: {
      color: '#31576F',
      fontSize: 13,
      lineHeight: 19,
    },

    tokenPreview: {
      marginTop: 8,
      fontSize: 11,
      color: '#5F7C8F',
    },

    tapHint: {
      marginTop: 8,
      fontSize: 11,
      lineHeight: 17,
      color: '#5F7C8F',
    },

    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 10,
    },

    sectionTitle: {
      fontSize: 18,
      fontWeight: '900',
      color: '#1C1C1E',
    },

    countBadge: {
      marginLeft: 8,
      minWidth: 25,
      height: 25,
      borderRadius: 13,
      backgroundColor:
        '#1C1C1E',
      alignItems: 'center',
      justifyContent:
        'center',
      paddingHorizontal: 7,
    },

    countText: {
      color: '#FFFFFF',
      fontWeight: '800',
      fontSize: 12,
    },

    loadingCard: {
      backgroundColor:
        '#FFFFFF',
      borderRadius: 16,
      padding: 28,
      alignItems: 'center',
      marginBottom: 16,
    },

    loadingText: {
      marginTop: 10,
      color: '#8E8E93',
    },

    emptyCard: {
      backgroundColor:
        '#FFFFFF',
      borderRadius: 16,
      padding: 24,
      alignItems: 'center',
      marginBottom: 16,
    },

    emptyIcon: {
      fontSize: 45,
      marginBottom: 10,
    },

    emptyTitle: {
      fontSize: 17,
      fontWeight: '900',
      color: '#1C1C1E',
      marginBottom: 6,
    },

    emptyText: {
      fontSize: 13,
      color: '#8E8E93',
      textAlign: 'center',
      lineHeight: 19,
    },

    errorCard: {
      backgroundColor:
        '#FFF4E6',
      borderRadius: 16,
      padding: 18,
      marginBottom: 16,
    },

    errorTitle: {
      fontWeight: '900',
      color: '#C2410C',
      marginBottom: 7,
    },

    errorText: {
      color: '#7C2D12',
      lineHeight: 19,
    },

    retryButton: {
      alignSelf:
        'flex-start',
      backgroundColor:
        '#C2410C',
      paddingHorizontal: 16,
      paddingVertical: 9,
      borderRadius: 8,
      marginTop: 12,
    },

    retryButtonText: {
      color: '#FFFFFF',
      fontWeight: '900',
    },

    packageCard: {
      backgroundColor:
        '#FFFFFF',
      borderRadius: 18,
      padding: 16,
      marginBottom: 14,
      borderWidth: 1,
      borderColor:
        '#E5E5EA',
    },

    targetPackageCard: {
      borderWidth: 2,
      borderColor:
        '#FF9F0A',
      backgroundColor:
        '#FFF9EE',
    },

    newBadge: {
      alignSelf:
        'flex-start',
      backgroundColor:
        '#FFF0D6',
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
      marginBottom: 12,
    },

    newBadgeText: {
      color: '#C45A00',
      fontSize: 10,
      fontWeight: '900',
    },

    packageTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },

    packageIcon: {
      width: 50,
      height: 50,
      borderRadius: 12,
      backgroundColor:
        '#FFF4E6',
      alignItems: 'center',
      justifyContent:
        'center',
      marginRight: 12,
    },

    packageLocker: {
      fontSize: 18,
      fontWeight: '900',
      color: '#1C1C1E',
    },

    packageMeta: {
      color: '#8E8E93',
      marginTop: 3,
      fontSize: 12,
    },

    packageId: {
      marginTop: 12,
      color: '#636366',
      fontSize: 12,
    },

    readyBadge: {
      backgroundColor:
        '#E8F8ED',
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },

    readyBadgeText: {
      color: '#248A3D',
      fontSize: 10,
      fontWeight: '900',
    },

    otpLabel: {
      marginTop: 18,
      textAlign: 'center',
      fontSize: 13,
      color: '#636366',
      fontWeight: '700',
    },

    otpRow: {
      flexDirection: 'row',
      justifyContent:
        'space-between',
      marginTop: 10,
    },

    otpBox: {
      flex: 1,
      maxWidth: 48,
      height: 54,
      borderRadius: 10,
      borderWidth: 1,
      borderColor:
        '#D1D1D6',
      backgroundColor:
        '#F2F2F7',
      alignItems: 'center',
      justifyContent:
        'center',
      marginHorizontal: 3,
    },

    otpBoxFilled: {
      borderColor:
        '#34C759',
      backgroundColor:
        '#ECFAF0',
    },

    otpDigit: {
      color: '#1C1C1E',
      fontSize: 22,
      fontWeight: '900',
    },

    autoFillBadge: {
      alignSelf: 'center',
      marginTop: 10,
      backgroundColor:
        '#E8F8ED',
      paddingHorizontal: 11,
      paddingVertical: 6,
      borderRadius: 999,
    },

    autoFillText: {
      color: '#248A3D',
      fontSize: 11,
      fontWeight: '800',
    },

    expiryText: {
      textAlign: 'center',
      color: '#8E8E93',
      fontSize: 12,
      marginTop: 8,
    },

    expiredBadge: {
      alignSelf: 'center',
      marginTop: 10,
      backgroundColor:
        '#FFE9E7',
      paddingHorizontal: 11,
      paddingVertical: 6,
      borderRadius: 999,
    },

    expiredText: {
      color: '#C62828',
      fontSize: 11,
      fontWeight: '900',
    },

    refreshOtpButton: {
      backgroundColor:
        '#FF9F0A',
      borderRadius: 11,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 15,
    },

    refreshOtpButtonText: {
      color: '#FFFFFF',
      fontWeight: '900',
      fontSize: 14,
    },

    openButton: {
      backgroundColor:
        '#007AFF',
      borderRadius: 11,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 15,
    },

    openButtonText: {
      color: '#FFFFFF',
      fontWeight: '900',
      fontSize: 14,
    },

    disabledButton: {
      opacity: 0.45,
    },

    oneTimeHint: {
      textAlign: 'center',
      color: '#8E8E93',
      fontSize: 11,
      lineHeight: 16,
      marginTop: 9,
    },

    logoutButton: {
      backgroundColor:
        '#1C1C1E',
      borderRadius: 12,
      paddingVertical: 15,
      alignItems: 'center',
      marginTop: 12,
    },

    logoutButtonText: {
      color: '#FFFFFF',
      fontSize: 15,
      fontWeight: '900',
    },

    centerBox: {
      flex: 1,
      padding: 24,
      justifyContent:
        'center',
      alignItems: 'center',
    },

    lockIcon: {
      fontSize: 48,
      marginBottom: 12,
    },

    centerTitle: {
      fontSize: 20,
      fontWeight: '900',
      color: '#1C1C1E',
      marginBottom: 8,
    },

    centerText: {
      textAlign: 'center',
      color: '#8E8E93',
      lineHeight: 20,
      marginBottom: 20,
    },

    primaryButton: {
      backgroundColor:
        '#34C759',
      borderRadius: 10,
      paddingVertical: 14,
      paddingHorizontal: 28,
    },

    primaryButtonText: {
      color: '#FFFFFF',
      fontWeight: '900',
    },
  });
