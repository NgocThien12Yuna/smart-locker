import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useAuth } from '../context/AuthContext';
import {
  UserRole,
  normalizePhone,
} from '../services/authApi';

export default function LoginScreen({
  navigation,
  route,
}: any) {
  const { login } = useAuth();

  const role: UserRole =
    route?.params?.role === 'ADMIN'
      ? 'ADMIN'
      : route?.params?.role === 'SHIPPER'
        ? 'SHIPPER'
        : 'RESIDENT';

  const [phone, setPhone] = useState(
    normalizePhone(route?.params?.prefillPhone || ''),
  );
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const roleMeta = useMemo(() => {
    if (role === 'ADMIN') {
      return {
        icon: '👨‍💼',
        title: 'Đăng nhập Admin',
        description:
          'Truy cập quản trị và giám sát hệ thống tủ.',
        target: 'Admin',
      };
    }

    if (role === 'SHIPPER') {
      return {
        icon: '🚚',
        title: 'Đăng nhập Shipper',
        description:
          'Đăng nhập để sử dụng camera AI và tạo đơn giao hàng.',
        target: 'Shipper',
      };
    }

    return {
      icon: '🏠',
      title: 'Đăng nhập Cư dân',
      description:
        'Xem kiện hàng và nhận thông báo SmartLocker.',
      target: 'Resident',
    };
  }, [role]);

  const handleLogin = async () => {
    if (!/^0\d{9}$/.test(phone)) {
      Alert.alert(
        'Kiểm tra SĐT',
        'Số điện thoại phải gồm 10 chữ số và bắt đầu bằng 0.',
      );
      return;
    }

    if (!password) {
      Alert.alert('Thiếu mật khẩu', 'Vui lòng nhập mật khẩu.');
      return;
    }

    setLoading(true);

    try {
      const user = await login({
        phone,
        password,
        role,
      });

      Alert.alert(
        'Đăng nhập thành công',
        `Xin chào ${user.phone}.`,
        [
          {
            text: 'Tiếp tục',
            onPress: () =>
              navigation.reset({
                index: 0,
                routes: [
                  {
                    name: roleMeta.target,
                  },
                ],
              }),
          },
        ],
      );
    } catch (error: any) {
      Alert.alert(
        'Đăng nhập thất bại',
        error?.message || String(error),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.backText}>‹ Quay lại</Text>
          </TouchableOpacity>

          <View style={styles.header}>
            <View style={styles.iconBox}>
              <Text style={styles.icon}>{roleMeta.icon}</Text>
            </View>

            <Text style={styles.title}>{roleMeta.title}</Text>
            <Text style={styles.description}>
              {roleMeta.description}
            </Text>
          </View>

          <View style={styles.formCard}>
            <Text style={styles.label}>Số điện thoại</Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={value =>
                setPhone(normalizePhone(value))
              }
              placeholder="Ví dụ: 0327622447"
              keyboardType="phone-pad"
              maxLength={10}
              autoCapitalize="none"
            />

            <Text style={styles.label}>Mật khẩu</Text>
            <View style={styles.passwordRow}>
              <TextInput
                style={styles.passwordInput}
                value={password}
                onChangeText={setPassword}
                placeholder="Nhập mật khẩu"
                secureTextEntry={!showPassword}
                autoCapitalize="none"
              />

              <TouchableOpacity
                style={styles.showButton}
                onPress={() => setShowPassword(value => !value)}
              >
                <Text style={styles.showText}>
                  {showPassword ? 'Ẩn' : 'Hiện'}
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[
                styles.submitButton,
                loading && styles.disabled,
              ]}
              disabled={loading}
              onPress={handleLogin}
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.submitText}>
                  ĐĂNG NHẬP
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.switchButton}
              onPress={() =>
                navigation.replace('Register', { role })
              }
            >
              <Text style={styles.switchText}>
                Chưa có tài khoản?{' '}
                <Text style={styles.switchStrong}>Đăng ký</Text>
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.note}>
            Sau khi đăng nhập thành công, tài khoản này sẽ xuất hiện trong mục “Tiếp tục với” ở lần mở app sau. SmartLocker không lưu mật khẩu trên điện thoại.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  container: {
    flexGrow: 1,
    padding: 20,
    paddingBottom: 36,
  },
  backButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
  },
  backText: {
    color: '#007AFF',
    fontWeight: '700',
    fontSize: 15,
  },
  header: {
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 24,
  },
  iconBox: {
    width: 74,
    height: 74,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    marginBottom: 14,
  },
  icon: {
    fontSize: 35,
  },
  title: {
    fontSize: 25,
    fontWeight: '900',
    color: '#1C1C1E',
  },
  description: {
    marginTop: 7,
    color: '#8E8E93',
    textAlign: 'center',
    fontSize: 13,
  },
  formCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 18,
  },
  label: {
    color: '#1C1C1E',
    fontWeight: '700',
    marginBottom: 7,
    marginTop: 4,
  },
  input: {
    height: 50,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    paddingHorizontal: 14,
    fontSize: 16,
    color: '#111111',
    marginBottom: 15,
    backgroundColor: '#FAFAFA',
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 50,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    backgroundColor: '#FAFAFA',
    marginBottom: 20,
  },
  passwordInput: {
    flex: 1,
    height: '100%',
    paddingHorizontal: 14,
    fontSize: 16,
    color: '#111111',
  },
  showButton: {
    paddingHorizontal: 14,
    height: '100%',
    justifyContent: 'center',
  },
  showText: {
    color: '#007AFF',
    fontWeight: '700',
  },
  submitButton: {
    backgroundColor: '#0A84FF',
    height: 50,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  submitText: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 15,
  },
  disabled: {
    opacity: 0.55,
  },
  switchButton: {
    alignItems: 'center',
    paddingTop: 17,
  },
  switchText: {
    color: '#6E6E73',
  },
  switchStrong: {
    color: '#007AFF',
    fontWeight: '800',
  },
  note: {
    marginTop: 16,
    fontSize: 12,
    lineHeight: 18,
    color: '#8E8E93',
    textAlign: 'center',
    paddingHorizontal: 6,
  },
});
