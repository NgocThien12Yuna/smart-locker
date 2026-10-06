import React, { useEffect, useRef, useState } from 'react';

import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  LogBox,
} from 'react-native';

import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';

import { useIsFocused } from '@react-navigation/native';

import ImageResizer from 'react-native-image-resizer';

import { API_BASE_URL } from '../config/api';
import { useAuth } from '../context/AuthContext';

import {
  createSmartLockerOcr,
  SmartLockerOcrEngine,
} from '../ai/smartlockerOcr';

LogBox.ignoreLogs([
  'Camera Component Error',
]);

const WORK_MAX_W = 1024;
const WORK_MAX_H = 1440;

const normalizePath = (path: string) =>
  path.startsWith('file://')
    ? path
    : `file://${path}`;

const getResizer = () => {
  const resizer: any =
    (ImageResizer as any).createResizedImage ||
    (ImageResizer as any).default?.createResizedImage;

  if (typeof resizer !== 'function') {
    throw new Error(
      'Không tìm thấy createResizedImage.',
    );
  }

  return resizer;
};

export const ShipperScreen = ({
  navigation,
}: any) => {
  const {
    currentUser,
    currentToken,
    logoutToHome,
  } = useAuth();

  const isFocused = useIsFocused();

  const {
    hasPermission,
    requestPermission,
  } = useCameraPermission();

  const device = useCameraDevice('back');

  const photoOutput = usePhotoOutput({
    qualityPrioritization: 'quality',
  });

  const engineRef =
    useRef<SmartLockerOcrEngine | null>(
      null,
    );

  const [
    isCameraReady,
    setIsCameraReady,
  ] = useState(false);

  const [
    isModelLoading,
    setIsModelLoading,
  ] = useState(true);

  const [
    modelError,
    setModelError,
  ] = useState('');

  const [
    phoneNumber,
    setPhoneNumber,
  ] = useState('');

  const [
    isScanning,
    setIsScanning,
  ] = useState(false);

  const [
    captureLocked,
    setCaptureLocked,
  ] = useState(false);

  const [
    isCreatingOrder,
    setIsCreatingOrder,
  ] = useState(false);

  const [
    debugInfo,
    setDebugInfo,
  ] = useState('');

  // ==========================================================
  // CAMERA PERMISSION
  // ==========================================================

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [
    hasPermission,
    requestPermission,
  ]);

  // ==========================================================
  // LOAD NEW ONNX MODELS
  // ==========================================================

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        setIsModelLoading(true);
        setModelError('');

        const engine =
          await createSmartLockerOcr();

        if (!mounted) {
          await engine.dispose();
          return;
        }

        engineRef.current = engine;

        console.log(
          '🎉 SHIPPER AI: PP-OCRv6 ONNX READY',
        );
      } catch (error: any) {
        console.error(
          '❌ ONNX AI LOAD ERROR:',
          error,
        );

        const message =
          error?.message ||
          String(error);

        if (mounted) {
          setModelError(message);
        }

        Alert.alert(
          'Lỗi nạp AI ONNX',
          message,
        );
      } finally {
        if (mounted) {
          setIsModelLoading(false);
        }
      }
    };

    load();

    return () => {
      mounted = false;

      const engine =
        engineRef.current;

      engineRef.current = null;

      if (engine) {
        engine.dispose();
      }
    };
  }, []);

  // ==========================================================
  // CAMERA -> MODEL 1 -> MODEL 2 -> RECEIVER SELECTOR
  // ==========================================================

  const handleScanAI = async () => {
    if (!isCameraReady) {
      Alert.alert(
        'Camera chưa sẵn sàng',
        'Vui lòng chờ Camera khởi động.',
      );
      return;
    }

    const engine = engineRef.current;

    if (!engine) {
      Alert.alert(
        'AI chưa sẵn sàng',
        modelError ||
          'Hai model ONNX đang được nạp.',
      );
      return;
    }

    if (isScanning) {
      return;
    }

    setIsScanning(true);
    setCaptureLocked(false);
    setDebugInfo('');

    try {
      const flowStart =
        Date.now();

      console.log(
        '------------------------------------',
      );
      console.log(
        '📷 CAMERA: Chụp full bill...',
      );

      const captureStart =
        Date.now();

      const result =
        await photoOutput.capturePhotoToFile(
          {
            flashMode: 'off',
            enableShutterSound: false,
          },
          {},
        );

      const captureMs =
        Date.now() -
        captureStart;

      if (!result?.filePath) {
        throw new Error(
          'Camera không trả về filePath.',
        );
      }

      const photoPath =
        normalizePath(result.filePath);

      console.log(
        '✅ CAMERA FILE:',
        photoPath,
      );

      setCaptureLocked(true);

      // Keep enough resolution for tiny phone numbers,
      // but avoid feeding a huge camera JPEG to JS.
      const resizer = getResizer();

      const resizeStart =
        Date.now();

      const resized =
        await resizer(
          photoPath,
          WORK_MAX_W,
          WORK_MAX_H,
          'JPEG',
          90,
          0,
          undefined,
          false,
          {
            mode: 'contain',
            onlyScaleDown: true,
          },
        );

      const resizeMs =
        Date.now() -
        resizeStart;

      const workPath =
        normalizePath(
          resized?.path ||
            resized?.uri ||
            photoPath,
        );

      console.log(
        '🧠 PP-OCRv6 pipeline:',
        workPath,
      );

      const aiStart =
        Date.now();

      const ai =
        await engine.scanJpeg(
          workPath,
        );

      const aiMs =
        Date.now() -
        aiStart;

      const flowMs =
        Date.now() -
        flowStart;

      console.log(
        '====================================',
      );
      console.log(
        '📊 SMARTLOCKER APP PROFILE',
      );
      console.log(
        `capture=${captureMs}ms`,
        `resize=${resizeMs}ms`,
        `ai=${aiMs}ms`,
        `flowTotal=${flowMs}ms`,
      );
      console.log(
        '====================================',
      );

      setDebugInfo(
        `APP PROFILE: capture=${captureMs}ms, resize=${resizeMs}ms, ai=${aiMs}ms, total=${flowMs}ms\n` +
          ai.debug +
          '\n' +
          ai.lines
            .slice(0, 16)
            .map(
              l =>
                `${l.confidence.toFixed(2)} | ${l.text}`,
            )
            .join('\n'),
      );

      if (ai.phone) {
        setPhoneNumber(ai.phone);

        Alert.alert(
          '🤖 AI nhận diện thành công',
          `SĐT người nhận: ${ai.phone}\n` +
            `Độ tin cậy: ${ai.confidence}\n` +
            `Phương pháp: ${ai.method}\n` +
            `Góc đại diện: ${ai.orientation}°\n` +
            `OCR lines: ${ai.lines.length}\n` +
            `AI time: ${(aiMs / 1000).toFixed(1)}s\n` +
            `Tổng từ lúc bấm chụp: ${(flowMs / 1000).toFixed(1)}s`,
        );
      } else {
        Alert.alert(
          '⚠️ AI chưa đủ chắc chắn',
          `V4 đã OCR bill nhưng chưa đủ bằng chứng để chọn SĐT người nhận.\n` +
            `Method: ${ai.method}\n` +
            `Confidence: ${ai.confidence}\n\n` +
            'Hãy chụp bill rõ hơn hoặc nhập SĐT bằng tay.',
        );
      }
    } catch (error: any) {
      console.error(
        '❌ FINAL ONNX AI ERROR:',
        error,
      );

      Alert.alert(
        '🚨 Lỗi AI',
        error?.message ||
          String(error),
      );
    } finally {
      setIsScanning(false);
      setCaptureLocked(false);
    }
  };

  // ==========================================================
  // BACKEND + FIREBASE: GIỮ LUỒNG CŨ
  // ==========================================================

  const handleDeposit = async () => {
    if (
      !currentUser ||
      currentUser.role !== 'SHIPPER' ||
      !currentToken
    ) {
      Alert.alert(
        'Chưa đăng nhập Shipper',
        'Vui lòng đăng nhập bằng tài khoản Shipper để tạo đơn.',
      );
      return;
    }

    if (!phoneNumber) {
      Alert.alert(
        'Lỗi',
        'Chưa có SĐT!',
      );
      return;
    }

    if (
      !/^0[35789]\d{8}$/.test(
        phoneNumber,
      )
    ) {
      Alert.alert(
        'Kiểm tra SĐT',
        'Số điện thoại phải là số di động Việt Nam hợp lệ gồm 10 chữ số.',
      );
      return;
    }

    setIsCreatingOrder(true);

    try {
      const response = await fetch(
        `${API_BASE_URL}/packages`,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${currentToken}`,
          },
          body: JSON.stringify({
            receiverPhone:
              phoneNumber,
            size: 'M',
            sender:
              `Shipper ${currentUser.phone}`,
          }),
        },
      );

      let data: any = null;

      try {
        data =
          await response.json();
      } catch {}

      if (
        !response.ok ||
        !data?.ok
      ) {
        throw new Error(
          data?.message ||
            `Không tạo được đơn (HTTP ${response.status}).`,
        );
      }

      const sentCount =
        Number(
          data.notification
            ?.successCount || 0,
        );

      const noDevice =
        !!data.notification
          ?.noDevice;

      if (noDevice) {
        Alert.alert(
          '⚠️ Đã tạo đơn',
          `Đã tạo kiện hàng cho ${phoneNumber} tại tủ ${data.package?.locker || 'tủ được backend cấp'}.\n\n` +
            'Tài khoản cư dân chưa có thiết bị nhận Firebase.',
        );
      } else if (sentCount > 0) {
        Alert.alert(
          '✅ Gửi hàng thành công',
          `Đã tạo đơn cho ${phoneNumber} tại tủ ${data.package?.locker || 'tủ được backend cấp'}.\n\n` +
            `🔔 Đã gửi thông báo tới ${sentCount} thiết bị.`,
        );
      } else {
        Alert.alert(
          '⚠️ Đã tạo đơn',
          `Đơn đã được lưu cho ${phoneNumber}, nhưng Firebase chưa gửi được thông báo.\n\n` +
            `${
              data.notification
                ?.message ||
              'Kiểm tra Firebase Admin ở backend.'
            }`,
        );
      }

      setPhoneNumber('');
    } catch (error: any) {
      console.error(
        '❌ CREATE PACKAGE ERROR:',
        error,
      );

      Alert.alert(
        'Không tạo được đơn',
        error?.message ||
          'Không kết nối được SmartLocker Backend.',
      );
    } finally {
      setIsCreatingOrder(false);
    }
  };

  const handleLogout = () => {
    logoutToHome();

    navigation.reset({
      index: 0,
      routes: [{ name: 'Home' }],
    });
  };

  // ==========================================================
  // AUTH / CAMERA GUARDS
  // ==========================================================

  if (
    !currentUser ||
    currentUser.role !== 'SHIPPER'
  ) {
    return (
      <View
        style={
          styles.authRequired
        }
      >
        <Text
          style={
            styles.authRequiredIcon
          }
        >
          🔒
        </Text>

        <Text
          style={
            styles.authRequiredTitle
          }
        >
          Chưa đăng nhập Shipper
        </Text>

        <Text
          style={
            styles.authRequiredText
          }
        >
          Vui lòng đăng nhập bằng tài khoản Shipper.
        </Text>

        <TouchableOpacity
          style={
            styles.backHomeButton
          }
          onPress={() =>
            navigation.reset({
              index: 0,
              routes: [
                { name: 'Home' },
              ],
            })
          }
        >
          <Text
            style={
              styles.backHomeButtonText
            }
          >
            VỀ TRANG CHỦ
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator
          size="large"
          color="#FF6B00"
        />

        <Text
          style={styles.statusText}
        >
          Đang xin quyền Camera...
        </Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator
          size="large"
          color="#FF6B00"
        />

        <Text
          style={styles.statusText}
        >
          Đang tìm Camera sau...
        </Text>
      </View>
    );
  }

  const aiReady =
    !!engineRef.current &&
    !isModelLoading;

  return (
    <ScrollView
      contentContainerStyle={
        styles.container
      }
    >
      <Text style={styles.title}>
        📦 Giao Hàng Shipper
      </Text>

      <View
        style={
          styles.shipperAccountCard
        }
      >
        <View style={{ flex: 1 }}>
          <Text
            style={
              styles.shipperAccountLabel
            }
          >
            🚚 SHIPPER ĐÃ XÁC THỰC
          </Text>

          <Text
            style={
              styles.shipperAccountPhone
            }
          >
            {currentUser.phone}
          </Text>
        </View>

        <TouchableOpacity
          style={
            styles.shipperLogoutButton
          }
          onPress={handleLogout}
        >
          <Text
            style={
              styles.shipperLogoutText
            }
          >
            Đăng xuất
          </Text>
        </TouchableOpacity>
      </View>

      <View
        style={
          styles.softwareModeCard
        }
      >
        <Text
          style={
            styles.softwareModeTitle
          }
        >
          🧠 PP-OCRv6 ONNX + FIREBASE
        </Text>

        <Text
          style={
            styles.softwareModeText
          }
        >
          Model 1 tìm các vùng chữ, Model 2 chuyển từng box thành text. V4 lọc SĐT Việt Nam, xác định Người nhận / Người gửi, chấm điểm và tổng hợp 4 hướng xoay.
        </Text>
      </View>

      <View
        style={styles.aiStatus}
      >
        {isModelLoading ? (
          <>
            <ActivityIndicator
              size="small"
              color="#FF6B00"
            />

            <Text
              style={
                styles.aiStatusText
              }
            >
              Đang nạp PP-OCRv6 ONNX...
            </Text>
          </>
        ) : aiReady ? (
          <Text
            style={
              styles.aiReadyText
            }
          >
            ✅ AI sẵn sàng - PP-OCRv6 + Receiver Selector V4
          </Text>
        ) : (
          <Text
            style={
              styles.aiErrorText
            }
          >
            ❌ AI chưa sẵn sàng
            {modelError
              ? `: ${modelError}`
              : ''}
          </Text>
        )}
      </View>

      <View
        style={styles.cameraBox}
      >
        <Camera
          style={
            StyleSheet.absoluteFill
          }
          device={device}
          isActive={isFocused}
          outputs={[photoOutput]}
          onConfigured={() => {
            console.log(
              '✅ CAMERA READY',
            );
            setIsCameraReady(true);
          }}
          onError={error => {
            console.error(
              '❌ CAMERA ERROR:',
              error,
            );
            setIsCameraReady(false);
          }}
        />

        <View
          pointerEvents="none"
          style={
            styles.overlayFrame
          }
        >
          <Text
            style={
              styles.overlayText
            }
          >
            Đưa toàn bộ bill vào khung, chữ càng rõ càng tốt
          </Text>
        </View>

        {isScanning && (
          <View
            pointerEvents="none"
            style={
              styles.captureHint
            }
          >
            <Text
              style={
                styles.captureHintText
              }
            >
              {captureLocked
                ? '✅ Đã chụp - AI đang đọc bill'
                : '📷 Giữ yên tới khi hiện ĐÃ CHỤP'}
            </Text>
          </View>
        )}
      </View>

      <TouchableOpacity
        style={[
          styles.btnScan,
          (
            isScanning ||
            !isCameraReady ||
            !aiReady
          ) &&
            styles.btnDisabled,
        ]}
        onPress={handleScanAI}
        disabled={
          isScanning ||
          !isCameraReady ||
          !aiReady
        }
      >
        {isScanning ? (
          <ActivityIndicator
            color="#FFFFFF"
          />
        ) : (
          <Text
            style={
              styles.btnScanText
            }
          >
            📷 Chụp bill & Tìm SĐT người nhận
          </Text>
        )}
      </TouchableOpacity>

      {!!debugInfo && (
        <View
          style={styles.debugBox}
        >
          <Text
            style={
              styles.debugTitle
            }
          >
            PP-OCRv6 + V4 Debug
          </Text>

          <Text
            style={
              styles.debugText
            }
          >
            {debugInfo}
          </Text>
        </View>
      )}

      <View
        style={styles.formGroup}
      >
        <Text
          style={styles.label}
        >
          Số điện thoại nhận diện:
        </Text>

        <TextInput
          style={styles.input}
          value={phoneNumber}
          onChangeText={text =>
            setPhoneNumber(
              text
                .replace(/\D/g, '')
                .slice(0, 10),
            )
          }
          placeholder="Số hiện ở đây..."
          keyboardType="phone-pad"
          maxLength={10}
        />

        <TouchableOpacity
          onPress={() =>
            setPhoneNumber('')
          }
          style={
            styles.clearButton
          }
        >
          <Text
            style={
              styles.clearText
            }
          >
            Xóa tất cả
          </Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[
          styles.btnSubmit,
          isCreatingOrder &&
            styles.btnDisabled,
        ]}
        onPress={handleDeposit}
        disabled={
          isCreatingOrder
        }
      >
        {isCreatingOrder ? (
          <ActivityIndicator
            color="#FFFFFF"
          />
        ) : (
          <Text
            style={
              styles.btnSubmitText
            }
          >
            📲 XÁC NHẬN GỬI HÀNG
          </Text>
        )}
      </TouchableOpacity>

      <Text
        style={styles.zaloHint}
      >
        AI V4 ưu tiên SĐT người nhận và trả UNCERTAIN khi chưa đủ chắc chắn. Bạn vẫn có thể sửa tay trước khi xác nhận. Backend tiếp tục tự cấp tủ và gửi Firebase như trước.
      </Text>
    </ScrollView>
  );
};

const styles =
  StyleSheet.create({
    authRequired: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 28,
      backgroundColor: '#F8F9FA',
    },

    authRequiredIcon: {
      fontSize: 48,
      marginBottom: 12,
    },

    authRequiredTitle: {
      fontSize: 21,
      fontWeight: '900',
      color: '#212529',
      marginBottom: 8,
    },

    authRequiredText: {
      textAlign: 'center',
      color: '#6C757D',
      lineHeight: 20,
      marginBottom: 20,
    },

    backHomeButton: {
      backgroundColor: '#FF6B00',
      paddingHorizontal: 24,
      paddingVertical: 13,
      borderRadius: 10,
    },

    backHomeButtonText: {
      color: '#FFFFFF',
      fontWeight: '900',
    },

    shipperAccountCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#FFF8EC',
      borderWidth: 1,
      borderColor: '#FFD79A',
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
    },

    shipperAccountLabel: {
      color: '#9A5B13',
      fontSize: 11,
      fontWeight: '900',
    },

    shipperAccountPhone: {
      marginTop: 3,
      color: '#212529',
      fontSize: 16,
      fontWeight: '900',
    },

    shipperLogoutButton: {
      backgroundColor: '#DC3545',
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 8,
    },

    shipperLogoutText: {
      color: '#FFFFFF',
      fontSize: 12,
      fontWeight: '900',
    },

    container: {
      padding: 20,
      backgroundColor: '#F8F9FA',
      flexGrow: 1,
    },

    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },

    statusText: {
      marginTop: 10,
      color: '#343A40',
    },

    title: {
      fontSize: 24,
      fontWeight: 'bold',
      color: '#212529',
      marginBottom: 12,
    },

    softwareModeCard: {
      backgroundColor: '#FFF4E6',
      borderWidth: 1,
      borderColor: '#FFB366',
      borderRadius: 10,
      padding: 12,
      marginBottom: 12,
    },

    softwareModeTitle: {
      color: '#D9480F',
      fontWeight: '800',
      marginBottom: 4,
    },

    softwareModeText: {
      color: '#7C2D12',
      lineHeight: 18,
      fontSize: 13,
    },

    aiStatus: {
      minHeight: 35,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 10,
    },

    aiStatusText: {
      marginLeft: 8,
      color: '#555555',
      fontWeight: '600',
    },

    aiReadyText: {
      color: '#2B8A3E',
      fontWeight: '700',
    },

    aiErrorText: {
      color: '#D32F2F',
      fontWeight: '700',
    },

    cameraBox: {
      height: 340,
      borderRadius: 12,
      overflow: 'hidden',
      marginBottom: 15,
      position: 'relative',
      backgroundColor: '#000000',
    },

    overlayFrame: {
      position: 'absolute',
      top: '6%',
      left: '8%',
      width: '84%',
      height: '88%',
      borderWidth: 2,
      borderColor: '#FF6B00',
      borderRadius: 8,
      borderStyle: 'dashed',
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingBottom: 10,
    },

    overlayText: {
      color: '#FFFFFF',
      backgroundColor:
        'rgba(0,0,0,0.55)',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 6,
      fontWeight: '700',
      textAlign: 'center',
    },

    captureHint: {
      position: 'absolute',
      left: 12,
      right: 12,
      top: 12,
      alignItems: 'center',
    },

    captureHintText: {
      color: '#FFFFFF',
      backgroundColor:
        'rgba(0,0,0,0.72)',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      fontWeight: '800',
    },

    btnScan: {
      backgroundColor: '#FF6B00',
      paddingVertical: 14,
      borderRadius: 8,
      alignItems: 'center',
      marginBottom: 20,
    },

    btnScanText: {
      color: '#FFFFFF',
      fontSize: 16,
      fontWeight: 'bold',
    },

    debugBox: {
      backgroundColor: '#FFFFFF',
      borderWidth: 1,
      borderColor: '#CED4DA',
      borderRadius: 8,
      padding: 10,
      marginBottom: 16,
    },

    debugTitle: {
      fontSize: 14,
      fontWeight: '700',
      color: '#343A40',
      marginBottom: 8,
    },

    debugText: {
      fontSize: 12,
      color: '#495057',
      lineHeight: 17,
    },

    formGroup: {
      marginBottom: 16,
    },

    label: {
      fontSize: 15,
      fontWeight: '600',
      color: '#343A40',
      marginBottom: 8,
    },

    input: {
      backgroundColor: '#FFFFFF',
      borderWidth: 1,
      borderColor: '#CED4DA',
      borderRadius: 8,
      paddingHorizontal: 15,
      paddingVertical: 12,
      fontSize: 18,
      color: '#000000',
      fontWeight: 'bold',
    },

    clearButton: {
      marginTop: 5,
      alignSelf: 'flex-end',
    },

    clearText: {
      color: '#007AFF',
      fontWeight: '500',
    },

    btnSubmit: {
      backgroundColor: '#2B8A3E',
      paddingVertical: 16,
      borderRadius: 8,
      alignItems: 'center',
      marginTop: 10,
    },

    btnSubmitText: {
      color: '#FFFFFF',
      fontSize: 16,
      fontWeight: 'bold',
    },

    zaloHint: {
      marginTop: 12,
      textAlign: 'center',
      color: '#6C757D',
      lineHeight: 19,
    },

    btnDisabled: {
      opacity: 0.45,
    },
  });

export default ShipperScreen;
