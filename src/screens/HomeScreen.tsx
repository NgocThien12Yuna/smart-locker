import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  RememberedAccount,
  useAuth,
} from '../context/AuthContext';
import { UserRole } from '../services/authApi';

type ActionMode = 'LOGIN' | 'REGISTER' | null;

const roleLabel = (role: UserRole) =>
  role === 'ADMIN' ? 'Admin' : 'Cư dân';

const roleIcon = (role: UserRole) =>
  role === 'ADMIN' ? '👨‍💼' : '🏠';

const maskPhone = (phone: string) => {
  if (phone.length < 7) {
    return phone;
  }

  return `${phone.slice(0, 4)}***${phone.slice(-3)}`;
};

export default function HomeScreen({ navigation }: any) {
  const {
    isReady,
    rememberedAccounts,
    continueWithAccount,
    forgetAccount,
  } = useAuth();

  const [actionMode, setActionMode] =
    useState<ActionMode>(null);
  const [continuingKey, setContinuingKey] =
    useState<string | null>(null);

  const goToRoleScreen = (role: UserRole) => {
    navigation.reset({
      index: 0,
      routes: [
        {
          name: role === 'ADMIN' ? 'Admin' : 'Resident',
        },
      ],
    });
  };

  const handleContinue = async (
    account: RememberedAccount,
  ) => {
    if (continuingKey) {
      return;
    }

    setContinuingKey(account.key);

    try {
      const result = await continueWithAccount(account);

      if (result.ok) {
        goToRoleScreen(result.user.role);
        return;
      }

      Alert.alert(
        'Cần đăng nhập lại',
        'Phiên đăng nhập cũ đã hết hạn. Bạn chỉ cần nhập lại mật khẩu.',
        [
          {
            text: 'Đăng nhập',
            onPress: () =>
              navigation.navigate('Login', {
                role: account.role,
                prefillPhone: account.phone,
              }),
          },
        ],
      );
    } finally {
      setContinuingKey(null);
    }
  };

  const handleForget = (account: RememberedAccount) => {
    Alert.alert(
      'Xóa tài khoản khỏi thiết bị?',
      `${account.phone} (${roleLabel(account.role)}) sẽ không còn xuất hiện trong mục “Tiếp tục với”. Tài khoản trên server không bị xóa.`,
      [
        {
          text: 'Hủy',
          style: 'cancel',
        },
        {
          text: 'Xóa khỏi máy',
          style: 'destructive',
          onPress: () => forgetAccount(account),
        },
      ],
    );
  };

  const chooseRole = (role: UserRole) => {
    const mode = actionMode;
    setActionMode(null);

    if (mode === 'LOGIN') {
      navigation.navigate('Login', { role });
    }

    if (mode === 'REGISTER') {
      navigation.navigate('Register', { role });
    }
  };

  if (!isReady) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#0A84FF" />
        <Text style={styles.loadingText}>
          Đang tải tài khoản đã nhớ...
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <View style={styles.logoContainer}>
            <Text style={styles.logoIcon}>🔐</Text>
          </View>

          <Text style={styles.appName}>SmartLocker</Text>
          <Text style={styles.subText}>
            Giao nhận thông minh • An toàn • Nhanh chóng
          </Text>
        </View>

        <View style={styles.authCard}>
          <Text style={styles.authTitle}>
            Chào mừng đến SmartLocker
          </Text>

          <Text style={styles.authDescription}>
            Admin và Cư dân sử dụng tài khoản. Shipper có thể giao hàng nhanh mà không cần đăng nhập.
          </Text>

          <TouchableOpacity
            style={styles.loginButton}
            onPress={() => setActionMode('LOGIN')}
          >
            <Text style={styles.loginButtonText}>
              ĐĂNG NHẬP
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.registerButton}
            onPress={() => setActionMode('REGISTER')}
          >
            <Text style={styles.registerButtonText}>
              ĐĂNG KÝ
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.dividerRow}>
          <View style={styles.divider} />
          <Text style={styles.dividerText}>SHIPPER</Text>
          <View style={styles.divider} />
        </View>

        <TouchableOpacity
          activeOpacity={0.85}
          style={styles.shipperCard}
          onPress={() => navigation.navigate('Shipper')}
        >
          <View style={styles.shipperIconBox}>
            <Text style={styles.shipperIcon}>🚚</Text>
          </View>

          <View style={styles.shipperInfo}>
            <Text style={styles.shipperTitle}>
              Giao hàng nhanh
            </Text>
            <Text style={styles.shipperDescription}>
              Vào thẳng màn hình Shipper • Không cần tài khoản
            </Text>
          </View>

          <Text style={styles.shipperArrow}>›</Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal
        visible={!!actionMode}
        transparent
        animationType="fade"
        onRequestClose={() => setActionMode(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {actionMode === 'REGISTER'
                ? 'Đăng ký với tư cách'
                : 'Đăng nhập'}
            </Text>

            <Text style={styles.modalSubtitle}>
              {actionMode === 'REGISTER'
                ? 'Chọn loại tài khoản bạn muốn tạo'
                : rememberedAccounts.length > 0
                  ? 'Chọn tài khoản đã dùng trên thiết bị này hoặc đăng nhập tài khoản khác'
                  : 'Chọn loại tài khoản bạn muốn đăng nhập'}
            </Text>

            {actionMode === 'LOGIN' &&
              rememberedAccounts.length > 0 && (
                <View style={styles.modalRememberedSection}>
                  <Text style={styles.modalSectionLabel}>
                    TIẾP TỤC VỚI
                  </Text>

                  {rememberedAccounts.map(account => {
                    const isContinuing =
                      continuingKey === account.key;

                    return (
                      <View
                        key={account.key}
                        style={styles.accountCard}
                      >
                        <TouchableOpacity
                          activeOpacity={0.8}
                          style={styles.accountMain}
                          onPress={() => handleContinue(account)}
                          disabled={!!continuingKey}
                        >
                          <View
                            style={[
                              styles.accountAvatar,
                              account.role === 'ADMIN'
                                ? styles.adminAvatar
                                : styles.residentAvatar,
                            ]}
                          >
                            <Text style={styles.accountAvatarText}>
                              {roleIcon(account.role)}
                            </Text>
                          </View>

                          <View style={styles.accountInfo}>
                            <Text style={styles.accountPhone}>
                              {maskPhone(account.phone)}
                            </Text>
                            <Text style={styles.accountRole}>
                              {roleLabel(account.role)}
                            </Text>
                          </View>

                          {isContinuing ? (
                            <ActivityIndicator color="#0A84FF" />
                          ) : (
                            <Text style={styles.accountArrow}>›</Text>
                          )}
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.forgetButton}
                          onPress={() => handleForget(account)}
                        >
                          <Text style={styles.forgetButtonText}>
                            ×
                          </Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}

                  <View style={styles.modalDividerRow}>
                    <View style={styles.modalDivider} />
                    <Text style={styles.modalDividerText}>
                      HOẶC DÙNG TÀI KHOẢN KHÁC
                    </Text>
                    <View style={styles.modalDivider} />
                  </View>
                </View>
              )}

            <TouchableOpacity
              style={styles.roleCard}
              onPress={() => chooseRole('RESIDENT')}
            >
              <View
                style={[
                  styles.roleIconBox,
                  styles.residentAvatar,
                ]}
              >
                <Text style={styles.roleIcon}>🏠</Text>
              </View>

              <View style={styles.roleInfo}>
                <Text style={styles.roleTitle}>Cư dân</Text>
                <Text style={styles.roleDescription}>
                  {actionMode === 'REGISTER'
                    ? 'Tạo tài khoản để nhận thông báo và quản lý kiện hàng'
                    : 'Đăng nhập bằng số điện thoại và mật khẩu'}
                </Text>
              </View>

              <Text style={styles.roleArrow}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.roleCard}
              onPress={() => chooseRole('ADMIN')}
            >
              <View
                style={[
                  styles.roleIconBox,
                  styles.adminAvatar,
                ]}
              >
                <Text style={styles.roleIcon}>👨‍💼</Text>
              </View>

              <View style={styles.roleInfo}>
                <Text style={styles.roleTitle}>Admin</Text>
                <Text style={styles.roleDescription}>
                  {actionMode === 'REGISTER'
                    ? 'Tạo tài khoản quản trị bằng mã Admin'
                    : 'Đăng nhập để quản lý tủ và lịch sử'}
                </Text>
              </View>

              <Text style={styles.roleArrow}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setActionMode(null)}
            >
              <Text style={styles.cancelButtonText}>Hủy</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  container: {
    flexGrow: 1,
    padding: 20,
    paddingBottom: 36,
  },
  loadingScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F2F2F7',
  },
  loadingText: {
    marginTop: 12,
    color: '#6E6E73',
  },
  header: {
    alignItems: 'center',
    marginTop: 18,
    marginBottom: 28,
  },
  logoContainer: {
    width: 78,
    height: 78,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    marginBottom: 14,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: {
      width: 0,
      height: 3,
    },
  },
  logoIcon: {
    fontSize: 38,
  },
  appName: {
    fontSize: 29,
    fontWeight: '900',
    color: '#111111',
  },
  subText: {
    marginTop: 7,
    fontSize: 13,
    color: '#8E8E93',
    textAlign: 'center',
  },
  section: {
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#8E8E93',
    letterSpacing: 1,
    marginBottom: 10,
    marginLeft: 4,
  },
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    marginBottom: 10,
    overflow: 'hidden',
    elevation: 1,
  },
  accountMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 13,
  },
  accountAvatar: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  residentAvatar: {
    backgroundColor: '#E5F8ED',
  },
  adminAvatar: {
    backgroundColor: '#E5F1FF',
  },
  accountAvatarText: {
    fontSize: 22,
  },
  accountInfo: {
    flex: 1,
  },
  accountPhone: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1C1C1E',
  },
  accountRole: {
    marginTop: 3,
    fontSize: 13,
    color: '#8E8E93',
  },
  accountArrow: {
    fontSize: 30,
    color: '#C7C7CC',
  },
  forgetButton: {
    width: 46,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FAFAFA',
  },
  forgetButtonText: {
    fontSize: 24,
    color: '#8E8E93',
  },
  otherAccountButton: {
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  otherAccountText: {
    color: '#007AFF',
    fontWeight: '700',
  },
  authCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 18,
    marginBottom: 20,
  },
  authTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1C1C1E',
  },
  authDescription: {
    marginTop: 7,
    marginBottom: 18,
    color: '#6E6E73',
    fontSize: 13,
    lineHeight: 19,
  },
  loginButton: {
    backgroundColor: '#0A84FF',
    paddingVertical: 14,
    borderRadius: 11,
    alignItems: 'center',
    marginBottom: 10,
  },
  loginButtonText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 15,
  },
  registerButton: {
    borderWidth: 1.5,
    borderColor: '#0A84FF',
    paddingVertical: 13,
    borderRadius: 11,
    alignItems: 'center',
  },
  registerButtonText: {
    color: '#0A84FF',
    fontWeight: '800',
    fontSize: 15,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
  },
  divider: {
    flex: 1,
    height: 1,
    backgroundColor: '#D1D1D6',
  },
  dividerText: {
    marginHorizontal: 12,
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  shipperCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF8EC',
    borderWidth: 1,
    borderColor: '#FFD79A',
    padding: 16,
    borderRadius: 16,
    marginTop: 8,
  },
  shipperIconBox: {
    width: 50,
    height: 50,
    borderRadius: 14,
    backgroundColor: '#FFF0D1',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 13,
  },
  shipperIcon: {
    fontSize: 25,
  },
  shipperInfo: {
    flex: 1,
  },
  shipperTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1C1C1E',
  },
  shipperDescription: {
    marginTop: 4,
    color: '#8A6A31',
    fontSize: 12,
    lineHeight: 17,
  },
  shipperArrow: {
    fontSize: 30,
    color: '#D69A3C',
  },
  modalRememberedSection: {
    marginBottom: 4,
  },
  modalSectionLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#8E8E93',
    letterSpacing: 1,
    marginBottom: 9,
    marginLeft: 2,
  },
  modalDividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 14,
  },
  modalDivider: {
    flex: 1,
    height: 1,
    backgroundColor: '#E5E5EA',
  },
  modalDividerText: {
    marginHorizontal: 9,
    color: '#8E8E93',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 22,
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
  },
  modalTitle: {
    fontSize: 21,
    fontWeight: '900',
    color: '#1C1C1E',
    textAlign: 'center',
  },
  modalSubtitle: {
    marginTop: 6,
    marginBottom: 18,
    fontSize: 13,
    color: '#8E8E93',
    textAlign: 'center',
  },
  roleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E5EA',
    borderRadius: 14,
    padding: 13,
    marginBottom: 11,
  },
  roleIconBox: {
    width: 46,
    height: 46,
    borderRadius: 13,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  roleIcon: {
    fontSize: 22,
  },
  roleInfo: {
    flex: 1,
  },
  roleTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1C1C1E',
  },
  roleDescription: {
    marginTop: 3,
    fontSize: 12,
    color: '#8E8E93',
  },
  roleArrow: {
    fontSize: 28,
    color: '#C7C7CC',
  },
  cancelButton: {
    marginTop: 5,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#FF3B30',
    fontWeight: '700',
  },
});
