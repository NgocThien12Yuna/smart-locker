import React, {
  useCallback,
  useMemo,
  useState,
} from 'react';

import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  useFocusEffect,
} from '@react-navigation/native';

import {
  API_BASE_URL,
} from '../config/api';

import {
  useAuth,
} from '../context/AuthContext';

type AdminPackage = {
  id: string;
  phone: string;
  size: string;
  sender: string;
  status: string;
  createdAt: string;
};

type LockerItem = {
  id: string;
  name: string;
  size: string;
  occupied: boolean;
  package: AdminPackage | null;
};

type Stats = {
  totalLockers: number;
  occupiedLockers: number;
  emptyLockers: number;
  totalTransactions: number;
};

const EMPTY_STATS: Stats = {
  totalLockers: 0,
  occupiedLockers: 0,
  emptyLockers: 0,
  totalTransactions: 0,
};

export default function AdminScreen({
  navigation,
}: any) {
  const {
    currentUser,
    currentToken,
    logoutToHome,
  } = useAuth();

  const [
    lockers,
    setLockers,
  ] = useState<LockerItem[]>([]);

  const [
    stats,
    setStats,
  ] = useState<Stats>(
    EMPTY_STATS,
  );

  const [
    isLoading,
    setIsLoading,
  ] = useState(true);

  const [
    isRefreshing,
    setIsRefreshing,
  ] = useState(false);

  const [
    openingId,
    setOpeningId,
  ] = useState<string | null>(
    null,
  );

  const [
    errorText,
    setErrorText,
  ] = useState('');

  const isAdmin =
    currentUser?.role === 'ADMIN';

  const loadOverview =
    useCallback(
      async (
        silent = false,
      ) => {
        if (
          !currentToken ||
          !isAdmin
        ) {
          return;
        }

        if (!silent) {
          setIsLoading(true);
        }

        try {
          setErrorText('');

          const response =
            await fetch(
              `${API_BASE_URL}/admin/overview`,
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

          setLockers(
            Array.isArray(
              data.lockers,
            )
              ? data.lockers
              : [],
          );

          setStats(
            data.stats ||
              EMPTY_STATS,
          );
        } catch (
          error: any
        ) {
          console.error(
            'ADMIN OVERVIEW ERROR:',
            error,
          );

          setErrorText(
            error?.message ||
              'Không tải được dữ liệu Admin.',
          );
        } finally {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      },
      [
        currentToken,
        isAdmin,
      ],
    );

  useFocusEffect(
    useCallback(() => {
      loadOverview();
    }, [loadOverview]),
  );

  const handleRefresh =
    () => {
      setIsRefreshing(true);
      loadOverview(true);
    };

  const handleLogout =
    () => {
      Alert.alert(
        'Đăng xuất Admin',
        'Bạn có chắc muốn đăng xuất khỏi phiên Admin hiện tại?',
        [
          {
            text: 'Hủy',
            style: 'cancel',
          },
          {
            text: 'Đăng xuất',
            style: 'destructive',
            onPress: () => {
              logoutToHome();

              navigation.reset({
                index: 0,
                routes: [
                  {
                    name: 'Home',
                  },
                ],
              });
            },
          },
        ],
      );
    };

  const waitForHardwareCommand =
    async (
      commandId: number,
      timeoutMs = 45000,
    ) => {
      if (!currentToken) {
        throw new Error(
          'Không có phiên Admin.',
        );
      }

      const startedAt =
        Date.now();

      while (
        Date.now() -
          startedAt <
        timeoutMs
      ) {
        const response =
          await fetch(
            `${API_BASE_URL}/hardware/commands/${commandId}/status`,
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

        const status =
          data.command
            ?.status;

        if (
          status === 'DONE'
        ) {
          return data.command;
        }

        if (
          status === 'FAILED'
        ) {
          throw new Error(
            data.command
              ?.errorMessage ||
              'ESP32 báo thực thi lệnh phần cứng thất bại.',
          );
        }

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1000,
            ),
        );
      }

      throw new Error(
        'ESP32 chưa phản hồi sau 45 giây.',
      );
    };

  // ==========================================================
  // ADMIN TẮT RELAY SAU KHI BẤM OK
  // ==========================================================

  const requestAdminRelayOff =
    async (
      packageId: string,
      lockerName: string,
    ) => {
      if (!currentToken) {
        Alert.alert(
          'Phiên Admin không hợp lệ',
          'Không thể gửi lệnh tắt relay khi chưa đăng nhập.',
        );
        return;
      }

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/hardware/packages/${encodeURIComponent(
              packageId,
            )}/close`,
            {
              method:
                'POST',
              headers: {
                Authorization:
                  `Bearer ${currentToken}`,
                'Content-Type':
                  'application/json',
              },
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
          throw new Error(
            data?.message ||
              `HTTP ${response.status}`,
          );
        }

        if (
          data.commandId
        ) {
          await waitForHardwareCommand(
            Number(
              data.commandId,
            ),
          );
        }

        await loadOverview(
          true,
        );

        Alert.alert(
          '✅ Đã hoàn tất',
          `Relay ${lockerName} đã TẮT.`,
        );
      } catch (
        error: any
      ) {
        Alert.alert(
          '⚠️ Relay chưa tắt',
          error?.message ||
            `Không tắt được relay ${lockerName}.`,
          [
            {
              text:
                'THỬ LẠI',
              onPress: () => {
                requestAdminRelayOff(
                  packageId,
                  lockerName,
                );
              },
            },
          ],
          {
            cancelable:
              false,
          },
        );
      }
    };

  const forceOpen =
    async (
      locker: LockerItem,
    ) => {
      const pkg =
        locker.package;

      if (!pkg) {
        Alert.alert(
          'Kiểm tra khóa',
          `${locker.name} đang trống.`,
        );
        return;
      }

      Alert.alert(
        'CẢNH BÁO ADMIN ⚠️',
        `Mở khẩn cấp ${locker.name}?\n\n` +
          `SĐT: ${pkg.phone}\n` +
          `Mã đơn: ${pkg.id}`,
        [
          {
            text: 'Hủy',
            style: 'cancel',
          },
          {
            text: 'Xác nhận mở',
            style: 'destructive',
            onPress: async () => {
              if (!currentToken) {
                return;
              }

              setOpeningId(
                pkg.id,
              );

              try {
                const response =
                  await fetch(
                    `${API_BASE_URL}/admin/packages/${encodeURIComponent(
                      pkg.id,
                    )}/force-open`,
                    {
                      method:
                        'POST',
                      headers: {
                        Authorization:
                          `Bearer ${currentToken}`,
                        'Content-Type':
                          'application/json',
                      },
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
                  throw new Error(
                    data?.message ||
                      `HTTP ${response.status}`,
                  );
                }

                if (
                  data.hardwareMode &&
                  data.commandId
                ) {
                  // Chờ ESP bật relay.
                  await waitForHardwareCommand(
                    Number(
                      data.commandId,
                    ),
                  );

                  // Relay vẫn ON cho đến khi Admin bấm OK.
                  Alert.alert(
                    '🔓 ĐÃ MỞ KHẨN CẤP',
                    `ESP32 đã mở ${locker.name}.\n\n` +
                      'Relay hiện đang BẬT.\n' +
                      'Bấm OK khi hoàn tất để tắt relay.',
                    [
                      {
                        text:
                          'OK - TẮT RELAY',
                        onPress:
                          () => {
                            requestAdminRelayOff(
                              pkg.id,
                              locker.name,
                            );
                          },
                      },
                    ],
                    {
                      cancelable:
                        false,
                    },
                  );

                  return;
                }

                // SOFTWARE MODE.
                Alert.alert(
                  'Đã mở khẩn cấp',
                  `${data.message}\n\nChế độ: SOFTWARE MODE`,
                );

                await loadOverview(
                  true,
                );
              } catch (
                error: any
              ) {
                Alert.alert(
                  'Không mở được tủ',
                  error?.message ||
                    'Có lỗi khi mở khẩn cấp hoặc ESP32 chưa phản hồi.',
                );
              } finally {
                setOpeningId(
                  null,
                );
              }
            },
          },
        ],
      );
    };

  const dashboard =
    useMemo(
      () => [
        {
          label:
            'Tổng Ô Tủ',
          value:
            stats.totalLockers,
          color:
            '#1C1C1E',
        },
        {
          label:
            'Đang Dùng',
          value:
            stats.occupiedLockers,
          color:
            '#FF3B30',
        },
        {
          label:
            'Còn Trống',
          value:
            stats.emptyLockers,
          color:
            '#34C759',
        },
        {
          label:
            'Giao Dịch',
          value:
            stats.totalTransactions,
          color:
            '#007AFF',
        },
      ],
      [stats],
    );

  if (
    !currentUser ||
    !isAdmin
  ) {
    return (
      <View
        style={
          styles.centerState
        }
      >
        <Text
          style={
            styles.centerIcon
          }
        >
          🔒
        </Text>

        <Text
          style={
            styles.centerTitle
          }
        >
          Chưa đăng nhập Admin
        </Text>
      </View>
    );
  }

  if (
    isLoading &&
    lockers.length === 0
  ) {
    return (
      <View
        style={
          styles.centerState
        }
      >
        <ActivityIndicator
          size="large"
        />

        <Text
          style={
            styles.centerText
          }
        >
          Đang tải trạng thái tủ từ backend...
        </Text>
      </View>
    );
  }

  return (
    <View
      style={styles.container}
    >
      <View
        style={
          styles.headerContainer
        }
      >
        <View
          style={
            styles.headerTextBox
          }
        >
          <Text
            style={
              styles.header
            }
          >
            Quản Trị Hệ Thống
          </Text>

          <Text
            style={
              styles.backendHint
            }
          >
            Dữ liệu realtime từ backend
          </Text>
        </View>

        <View
          style={
            styles.headerActions
          }
        >
          <TouchableOpacity
            style={
              styles.historyBtn
            }
            onPress={() =>
              navigation.navigate(
                'History',
              )
            }
          >
            <Text
              style={
                styles.historyBtnText
              }
            >
              🕒 Lịch sử
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={
              styles.logoutBtn
            }
            onPress={
              handleLogout
            }
          >
            <Text
              style={
                styles.logoutBtnText
              }
            >
              ↪ Đăng xuất
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View
        style={
          styles.dashboardCard
        }
      >
        {dashboard.map(
          (
            item,
            index,
          ) => (
            <React.Fragment
              key={item.label}
            >
              {index > 0 && (
                <View
                  style={
                    styles.statDivider
                  }
                />
              )}

              <View
                style={
                  styles.statBox
                }
              >
                <Text
                  style={[
                    styles.statValue,
                    {
                      color:
                        item.color,
                    },
                  ]}
                >
                  {item.value}
                </Text>

                <Text
                  style={
                    styles.statLabel
                  }
                >
                  {item.label}
                </Text>
              </View>
            </React.Fragment>
          ),
        )}
      </View>

      {!!errorText && (
        <View
          style={
            styles.errorBox
          }
        >
          <Text
            style={
              styles.errorText
            }
          >
            ⚠️ {errorText}
          </Text>
        </View>
      )}

      <Text
        style={
          styles.subHeader
        }
      >
        📊 Sơ Đồ Trạng Thái Realtime
      </Text>

      <FlatList
        data={lockers}
        keyExtractor={
          item => item.id
        }
        numColumns={2}
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
        renderItem={({
          item,
        }) => {
          const pkg =
            item.package;

          const isOccupied =
            item.occupied;

          const isOpening =
            !!pkg &&
            openingId ===
              pkg.id;

          return (
            <View
              style={[
                styles.lockerCard,
                isOccupied
                  ? styles.occupiedBox
                  : styles.emptyBox,
              ]}
            >
              <View
                style={
                  styles.cardHeader
                }
              >
                <Text
                  style={
                    styles.lockerName
                  }
                >
                  {item.name}
                </Text>

                <Text
                  style={
                    styles.sizeBadge
                  }
                >
                  Size {item.size}
                </Text>
              </View>

              <Text
                style={
                  styles.statusText
                }
              >
                Trạng thái:{' '}
                <Text
                  style={
                    isOccupied
                      ? styles.textRed
                      : styles.textGreen
                  }
                >
                  {isOccupied
                    ? '🔴 CÓ HÀNG'
                    : '🟢 TRỐNG'}
                </Text>
              </Text>

              {pkg && (
                <View
                  style={
                    styles.detailBox
                  }
                >
                  <Text
                    style={
                      styles.detailText
                    }
                  >
                    📱 {pkg.phone}
                  </Text>

                  <Text
                    style={
                      styles.detailText
                    }
                  >
                    📦 {pkg.sender}
                  </Text>

                  <Text
                    style={
                      styles.packageText
                    }
                    numberOfLines={
                      1
                    }
                  >
                    {pkg.id}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[
                  styles.actionBtn,
                  isOccupied
                    ? styles.btnDanger
                    : styles.btnSuccess,
                  isOpening &&
                    styles.btnDisabled,
                ]}
                disabled={
                  isOpening
                }
                onPress={() =>
                  forceOpen(item)
                }
              >
                {isOpening ? (
                  <ActivityIndicator
                    color="#FFFFFF"
                  />
                ) : (
                  <Text
                    style={
                      styles.btnText
                    }
                  >
                    {isOccupied
                      ? '🔓 Mở khẩn cấp'
                      : '⚡ Kiểm tra khóa'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          );
        }}
        ListEmptyComponent={
          <View
            style={
              styles.emptyList
            }
          >
            <Text>
              Không có dữ liệu tủ.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles =
  StyleSheet.create({
    container: {
      flex: 1,
      padding: 12,
      backgroundColor:
        '#F2F2F7',
    },

    headerContainer: {
      flexDirection: 'row',
      justifyContent:
        'space-between',
      alignItems:
        'flex-start',
      marginBottom: 12,
      paddingHorizontal: 4,
      gap: 10,
    },

    headerTextBox: {
      flex: 1,
    },

    header: {
      fontSize: 20,
      fontWeight: 'bold',
      color: '#1C1C1E',
    },

    backendHint: {
      marginTop: 3,
      color: '#8E8E93',
      fontSize: 11,
    },

    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },

    historyBtn: {
      backgroundColor:
        '#1C1C1E',
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 8,
    },

    historyBtnText: {
      color: '#FFFFFF',
      fontWeight: 'bold',
      fontSize: 12,
    },

    logoutBtn: {
      backgroundColor:
        '#FF3B30',
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 8,
    },

    logoutBtnText: {
      color: '#FFFFFF',
      fontWeight: '800',
      fontSize: 12,
    },

    dashboardCard: {
      flexDirection: 'row',
      backgroundColor:
        '#FFFFFF',
      padding: 16,
      borderRadius: 12,
      marginBottom: 16,
      elevation: 2,
      justifyContent:
        'space-between',
      alignItems: 'center',
    },

    statBox: {
      alignItems: 'center',
      flex: 1,
    },

    statValue: {
      fontSize: 20,
      fontWeight: 'bold',
      marginBottom: 4,
    },

    statLabel: {
      fontSize: 10,
      color: '#8E8E93',
      fontWeight: '600',
      textAlign: 'center',
    },

    statDivider: {
      width: 1,
      height: '80%',
      backgroundColor:
        '#E5E5EA',
    },

    errorBox: {
      backgroundColor:
        '#FFF4E6',
      borderRadius: 10,
      padding: 10,
      marginBottom: 12,
    },

    errorText: {
      color: '#C2410C',
    },

    subHeader: {
      fontSize: 16,
      fontWeight: 'bold',
      color: '#1C1C1E',
      marginBottom: 10,
      paddingHorizontal: 4,
    },

    lockerCard: {
      flex: 1,
      margin: 6,
      padding: 14,
      borderRadius: 12,
      borderWidth: 1.5,
      minHeight: 175,
      justifyContent:
        'space-between',
    },

    emptyBox: {
      backgroundColor:
        '#F0FFF4',
      borderColor:
        '#34C759',
    },

    occupiedBox: {
      backgroundColor:
        '#FFF5F5',
      borderColor:
        '#FF3B30',
    },

    cardHeader: {
      flexDirection: 'row',
      justifyContent:
        'space-between',
      alignItems: 'center',
    },

    lockerName: {
      fontSize: 16,
      fontWeight: 'bold',
      color: '#1C1C1E',
    },

    sizeBadge: {
      fontSize: 11,
      fontWeight: 'bold',
      backgroundColor:
        '#E5E5EA',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },

    statusText: {
      fontSize: 13,
      fontWeight: '600',
      marginTop: 8,
    },

    textRed: {
      color: '#FF3B30',
      fontWeight: 'bold',
    },

    textGreen: {
      color: '#34C759',
      fontWeight: 'bold',
    },

    detailBox: {
      marginVertical: 6,
      padding: 7,
      backgroundColor:
        'rgba(255,255,255,0.75)',
      borderRadius: 6,
    },

    detailText: {
      fontSize: 11,
      color: '#333333',
      marginBottom: 3,
    },

    packageText: {
      fontSize: 9,
      color: '#8E8E93',
    },

    actionBtn: {
      paddingVertical: 8,
      borderRadius: 6,
      alignItems: 'center',
      marginTop: 8,
      minHeight: 35,
      justifyContent:
        'center',
    },

    btnDanger: {
      backgroundColor:
        '#FF3B30',
    },

    btnSuccess: {
      backgroundColor:
        '#007AFF',
    },

    btnDisabled: {
      opacity: 0.5,
    },

    btnText: {
      color: '#FFFFFF',
      fontSize: 12,
      fontWeight: 'bold',
    },

    centerState: {
      flex: 1,
      justifyContent:
        'center',
      alignItems: 'center',
      padding: 24,
    },

    centerIcon: {
      fontSize: 48,
    },

    centerTitle: {
      fontSize: 20,
      fontWeight: '900',
      marginTop: 10,
    },

    centerText: {
      color: '#8E8E93',
      marginTop: 10,
    },

    emptyList: {
      padding: 30,
      alignItems: 'center',
    },
  });
