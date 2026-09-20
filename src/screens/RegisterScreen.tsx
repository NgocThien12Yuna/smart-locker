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

export default function RegisterScreen({
  navigation,
  route,
}: any) {
  const { register } = useAuth();

  const role: UserRole =
    route?.params?.role === 'ADMIN'
      ? 'ADMIN'
      : route?.params?.role === 'SHIPPER'
        ? 'SHIPPER'
        : 'RESIDENT';

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [adminCode, setAdminCode] = useState('');
  const [shipperCode, setShipperCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const roleMeta = useMemo(() => {
    if (role === 'ADMIN') {
      return {
        icon: '👨‍💼',
        title: 'Đăng ký Admin',
        description:
          'Admin cần mã đăng ký do hệ thống SmartLocker cấp.',
        target: 'Admin',
      };
    }

    if (role === 'SHIPPER') {
      return {
        icon: '🚚',
        title: 'Đăng ký Shipper',
        description:
          'Shipper cần mã giới thiệu để được phép tạo đơn giao hàng.',
        target: 'Shipper',
      };
    }

    return {
      icon: '🏠',
      title: 'Đăng ký Cư dân',
      description:
        'Tạo tài khoản bằng số điện thoại để nhận kiện hàng và thông báo.',
      target: 'Resident',
    };
  }, [role]);

  const handleRegister = async () => {
    if (!/^0\d{9}$/.test(phone)) {
      Alert.alert(
        'Kiểm tra SĐT',
        'Số điện thoại phải gồm 10 chữ số và bắt đầu bằng 0.',
      );
      return;
    }

    if (password.length < 6) {
      Alert.alert(
        'Mật khẩu quá ngắn',
        'Mật khẩu phải có ít nhất 6 ký tự.',
      );
      return;
    }

    if (password !== confirmPassword) {
      Alert.alert(
        'Mật khẩu không khớp',
        'Hai lần nhập mật khẩu phải giống nhau.',
      );
      return;
    }

    if (role === 'ADMIN' && !adminCode.trim()) {
      Alert.alert(
        'Thiếu mã Admin',
        'Vui lòng nhập mã đăng ký Admin.',
      );
      return;
    }

    if (role === 'SHIPPER' && !shipperCode.trim()) {
      Alert.alert(
        'Thiếu mã giới thiệu',
        'Vui lòng nhập mã giới thiệu Shipper.',
      );
      return;
    }

    setLoading(true);

    try {
      const user = await register({
        phone,
        password,
        role,
        adminCode: role === 'ADMIN' ? adminCode.trim() : undefined,
        shipperCode:
          role === 'SHIPPER' ? shipperCode.trim() : undefined,
      });

      Alert.alert(
        'Đăng ký thành công',
        `Tài khoản ${user.phone} đã được tạo và ghi nhớ trên thiết bị này.`,
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
        'Đăng ký thất bại',
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
            />

            <Text style={styles.label}>Mật khẩu</Text>
            <View style={styles.passwordRow}>
              <TextInput
                style={styles.passwordInput}
                value={password}
                onChangeText={setPassword}
                placeholder="Tối thiểu 6 ký tự"
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

            <Text style={styles.label}>Nhập lại mật khẩu</Text>
            <TextInput
              style={styles.input}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Nhập lại mật khẩu"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
            />

            {role === 'ADMIN' && (
              <>
                <Text style={styles.label}>
                  Mã đăng ký Admin
                </Text>
                <TextInput
                  style={styles.input}
                  value={adminCode}
                  onChangeText={setAdminCode}
                  placeholder="Mã do SmartLocker cấp"
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                <View style={styles.adminNotice}>
                  <Text style={styles.adminNoticeText}>
                    🔐 Mã Admin sẽ được backend kiểm tra. Không lưu mã này trong tài khoản sau khi đăng ký.
                  </Text>
                </View>
              </>
            )}

            {role === 'SHIPPER' && (
              <>
                <Text style={styles.label}>
                  Mã giới thiệu Shipper
                </Text>
                <TextInput
                  style={styles.input}
                  value={shipperCode}
                  onChangeText={setShipperCode}
                  placeholder="Nhập mã giới thiệu"
                  keyboardType="number-pad"
                  maxLength={6}
                  secureTextEntry
                />

                <View style={styles.shipperNotice}>
                  <Text style={styles.shipperNoticeText}>
                    🚚 Chỉ Shipper có mã hợp lệ mới được tạo tài khoản và sử dụng chức năng giao hàng.
                  </Text>
                </View>
              </>
            )}

            <TouchableOpacity
              style={[
                styles.submitButton,
                loading && styles.disabled,
              ]}
              disabled={loading}
              onPress={handleRegister}
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.submitText}>
                  TẠO TÀI KHOẢN
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.switchButton}
              onPress={() =>
                navigation.replace('Login', { role })
              }
            >
              <Text style={styles.switchText}>
                Đã có tài khoản?{' '}
                <Text style={styles.switchStrong}>Đăng nhập</Text>
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.note}>
            Mật khẩu được gửi tới backend để kiểm tra/hash và không được SmartLocker lưu dạng chữ thường trên điện thoại.
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
    marginTop: 15,
    marginBottom: 22,
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
    lineHeight: 18,
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
    marginBottom: 15,
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
  adminNotice: {
    backgroundColor: '#FFF8E6',
    borderRadius: 10,
    padding: 11,
    marginTop: -5,
    marginBottom: 16,
  },
  adminNoticeText: {
    color: '#8A6723',
    fontSize: 12,
    lineHeight: 17,
  },
  shipperNotice: {
    backgroundColor: '#FFF4E6',
    borderRadius: 10,
    padding: 11,
    marginTop: -5,
    marginBottom: 16,
  },
  shipperNoticeText: {
    color: '#9A5B13',
    fontSize: 12,
    lineHeight: 17,
  },
  submitButton: {
    backgroundColor: '#34C759',
    height: 50,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 3,
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
