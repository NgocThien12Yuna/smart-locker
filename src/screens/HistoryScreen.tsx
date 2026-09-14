import React, {
  useCallback,
  useState,
} from 'react';

import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
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

type LogItem = {
  id: string;
  action:
    | 'GỬI HÀNG'
    | 'NHẬN HÀNG'
    | 'MỞ KHẨN CẤP';
  packageId:
    | string
    | null;
  phone: string;
  locker: string;
  time: string;
};

const formatTime = (
  value: string,
) => {
  try {
    const normalized =
      value.includes('T')
        ? value
        : `${value.replace(' ', 'T')}Z`;

    return new Date(
      normalized,
    ).toLocaleString('vi-VN');
  } catch {
    return value;
  }
};

const actionMeta = (
  action: LogItem['action'],
) => {
  switch (action) {
    case 'GỬI HÀNG':
      return {
        icon: '📦',
        label:
          'Shipper gửi hàng',
        color:
          '#007AFF',
      };

    case 'NHẬN HÀNG':
      return {
        icon: '✅',
        label:
          'Cư dân nhận hàng',
        color:
          '#34C759',
      };

    case 'MỞ KHẨN CẤP':
      return {
        icon: '⚠️',
        label:
          'Admin mở khẩn cấp',
        color:
          '#FF3B30',
      };
  }
};

export default function HistoryScreen() {
  const {
    currentUser,
    currentToken,
  } = useAuth();

  const [
    logs,
    setLogs,
  ] = useState<LogItem[]>([]);

  const [
    isLoading,
    setIsLoading,
  ] = useState(true);

  const [
    isRefreshing,
    setIsRefreshing,
  ] = useState(false);

  const [
    errorText,
    setErrorText,
  ] = useState('');

  const loadHistory =
    useCallback(
      async (
        silent = false,
      ) => {
        if (
          !currentToken ||
          currentUser?.role !==
            'ADMIN'
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
              `${API_BASE_URL}/admin/history`,
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

          setLogs(
            Array.isArray(
              data.logs,
            )
              ? data.logs
              : [],
          );
        } catch (
          error: any
        ) {
          console.error(
            'ADMIN HISTORY ERROR:',
            error,
          );

          setErrorText(
            error?.message ||
              'Không tải được lịch sử.',
          );
        } finally {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      },
      [
        currentToken,
        currentUser?.role,
      ],
    );

  useFocusEffect(
    useCallback(() => {
      loadHistory();
    }, [loadHistory]),
  );

  if (
    currentUser?.role !==
    'ADMIN'
  ) {
    return (
      <View
        style={
          styles.center
        }
      >
        <Text
          style={
            styles.bigIcon
          }
        >
          🔒
        </Text>

        <Text
          style={
            styles.centerTitle
          }
        >
          Chỉ Admin được xem lịch sử
        </Text>
      </View>
    );
  }

  if (
    isLoading &&
    logs.length === 0
  ) {
    return (
      <View
        style={
          styles.center
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
          Đang tải lịch sử từ backend...
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
          styles.headerCard
        }
      >
        <Text
          style={
            styles.headerTitle
          }
        >
          🕒 Lịch sử giao dịch
        </Text>

        <Text
          style={
            styles.headerSubtitle
          }
        >
          Dữ liệu được lưu trong SQLite backend, không phụ thuộc bộ nhớ của điện thoại.
        </Text>
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

      <FlatList
        data={logs}
        keyExtractor={
          item => item.id
        }
        refreshControl={
          <RefreshControl
            refreshing={
              isRefreshing
            }
            onRefresh={() => {
              setIsRefreshing(
                true,
              );

              loadHistory(
                true,
              );
            }}
          />
        }
        contentContainerStyle={
          logs.length === 0
            ? styles.emptyContainer
            : styles.listContent
        }
        renderItem={({
          item,
        }) => {
          const meta =
            actionMeta(
              item.action,
            );

          return (
            <View
              style={
                styles.logCard
              }
            >
              <View
                style={[
                  styles.iconBox,
                  {
                    borderColor:
                      meta.color,
                  },
                ]}
              >
                <Text
                  style={
                    styles.iconText
                  }
                >
                  {meta.icon}
                </Text>
              </View>

              <View
                style={{
                  flex: 1,
                }}
              >
                <Text
                  style={[
                    styles.actionTitle,
                    {
                      color:
                        meta.color,
                    },
                  ]}
                >
                  {meta.label}
                </Text>

                <Text
                  style={
                    styles.detailText
                  }
                >
                  🗄️ Tủ {item.locker}
                </Text>

                <Text
                  style={
                    styles.detailText
                  }
                >
                  📱 {item.phone}
                </Text>

                {!!item.packageId && (
                  <Text
                    style={
                      styles.packageText
                    }
                  >
                    {item.packageId}
                  </Text>
                )}

                <Text
                  style={
                    styles.timeText
                  }
                >
                  {formatTime(
                    item.time,
                  )}
                </Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View
            style={
              styles.emptyBox
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
              Chưa có giao dịch
            </Text>

            <Text
              style={
                styles.emptyText
              }
            >
              Khi Shipper tạo đơn hoặc Cư dân nhận hàng, lịch sử sẽ xuất hiện tại đây.
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
      backgroundColor:
        '#F2F2F7',
      padding: 14,
    },

    headerCard: {
      backgroundColor:
        '#1C1C1E',
      borderRadius: 14,
      padding: 16,
      marginBottom: 12,
    },

    headerTitle: {
      color: '#FFFFFF',
      fontSize: 19,
      fontWeight: '900',
    },

    headerSubtitle: {
      color: '#C7C7CC',
      fontSize: 12,
      lineHeight: 18,
      marginTop: 6,
    },

    listContent: {
      paddingBottom: 30,
    },

    logCard: {
      backgroundColor:
        '#FFFFFF',
      borderRadius: 14,
      padding: 14,
      marginBottom: 10,
      flexDirection: 'row',
    },

    iconBox: {
      width: 48,
      height: 48,
      borderRadius: 12,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent:
        'center',
      marginRight: 12,
    },

    iconText: {
      fontSize: 23,
    },

    actionTitle: {
      fontSize: 15,
      fontWeight: '900',
      marginBottom: 5,
    },

    detailText: {
      color: '#3A3A3C',
      fontSize: 13,
      marginBottom: 3,
    },

    packageText: {
      color: '#8E8E93',
      fontSize: 10,
      marginTop: 3,
    },

    timeText: {
      color: '#8E8E93',
      fontSize: 11,
      marginTop: 7,
    },

    errorBox: {
      backgroundColor:
        '#FFF4E6',
      padding: 10,
      borderRadius: 10,
      marginBottom: 10,
    },

    errorText: {
      color: '#C2410C',
    },

    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent:
        'center',
      padding: 24,
    },

    bigIcon: {
      fontSize: 48,
    },

    centerTitle: {
      fontSize: 18,
      fontWeight: '900',
      marginTop: 10,
    },

    loadingText: {
      marginTop: 10,
      color: '#8E8E93',
    },

    emptyContainer: {
      flexGrow: 1,
      justifyContent:
        'center',
    },

    emptyBox: {
      alignItems: 'center',
      padding: 30,
    },

    emptyIcon: {
      fontSize: 45,
    },

    emptyTitle: {
      fontSize: 18,
      fontWeight: '900',
      marginTop: 10,
    },

    emptyText: {
      textAlign: 'center',
      color: '#8E8E93',
      lineHeight: 19,
      marginTop: 6,
    },
  });
