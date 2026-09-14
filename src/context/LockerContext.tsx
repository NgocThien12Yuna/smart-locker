import React, { createContext, useEffect, useState, useContext } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface PackageItem {
  id: string;
  phone: string;
  size: string;
  locker: string;
  sender: string;
  time: string;
  pickupToken: string;
}

export interface LogItem {
  id: string;
  action: 'GỬI HÀNG' | 'NHẬN HÀNG' | 'MỞ KHẨN CẤP';
  phone: string;
  locker: string;
  time: string;
}

type NewPackageInput = Omit<PackageItem, 'id' | 'time' | 'pickupToken'> & {
  pickupToken?: string;
};

interface LockerContextType {
  packages: PackageItem[];
  logs: LogItem[];
  isReady: boolean;
  addPackage: (pkg: NewPackageInput) => PackageItem;
  removePackage: (id: string, isForce?: boolean) => void;
  findPackageByToken: (token: string) => PackageItem | undefined;
  completePickupByToken: (token: string) => PackageItem | null;
  clearHistory: () => void;
}

const LockerContext = createContext<LockerContextType | undefined>(undefined);

const createPickupToken = () => {
  const randomPart = Array.from({ length: 4 }, () =>
    Math.random().toString(36).slice(2, 10)
  ).join('');

  return `SLK_${Date.now().toString(36).toUpperCase()}_${randomPart.toUpperCase()}`;
};

const normalizeToken = (token: string) => token.trim();

export const LockerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [isReady, setIsReady] = useState(false);

  // 1. Tải dữ liệu đã lưu. Package cũ chưa có QR token sẽ được migrate tự động.
  useEffect(() => {
    const loadData = async () => {
      try {
        const savedPackages = await AsyncStorage.getItem('@locker_packages');
        const savedLogs = await AsyncStorage.getItem('@locker_logs');

        if (savedPackages) {
          const parsed = JSON.parse(savedPackages) as Array<Partial<PackageItem>>;
          const migrated: PackageItem[] = parsed.map(pkg => ({
            id: String(pkg.id ?? Math.random()),
            phone: String(pkg.phone ?? ''),
            size: String(pkg.size ?? 'M'),
            locker: String(pkg.locker ?? 'A01'),
            sender: String(pkg.sender ?? 'Shipper'),
            time: String(pkg.time ?? new Date().toLocaleTimeString()),
            pickupToken:
              typeof pkg.pickupToken === 'string' && pkg.pickupToken.length > 0
                ? pkg.pickupToken
                : createPickupToken(),
          }));

          setPackages(migrated);
        }

        if (savedLogs) {
          setLogs(JSON.parse(savedLogs));
        }
      } catch (error) {
        console.error('Lỗi khi tải dữ liệu:', error);
      } finally {
        setIsReady(true);
      }
    };

    loadData();
  }, []);

  // 2. Tự động lưu package + log xuống máy.
  useEffect(() => {
    const saveData = async () => {
      if (!isReady) {
        return;
      }

      try {
        await AsyncStorage.setItem('@locker_packages', JSON.stringify(packages));
        await AsyncStorage.setItem('@locker_logs', JSON.stringify(logs));
      } catch (error) {
        console.error('Lỗi khi lưu dữ liệu:', error);
      }
    };

    saveData();
  }, [packages, logs, isReady]);

  // 3. Tạo đơn mới + token QR một lần.
  const addPackage = (pkg: NewPackageInput): PackageItem => {
    const timeNow = new Date().toLocaleTimeString();

    const newPackage: PackageItem = {
      ...pkg,
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      time: timeNow,
      pickupToken: pkg.pickupToken?.trim() || createPickupToken(),
    };

    setPackages(prev => [...prev, newPackage]);

    setLogs(prev => [
      {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        action: 'GỬI HÀNG',
        phone: pkg.phone,
        locker: pkg.locker,
        time: timeNow,
      },
      ...prev,
    ]);

    return newPackage;
  };

  // Giữ API cũ để Admin/History hiện tại không bị hỏng.
  const removePackage = (id: string, isForce: boolean = false) => {
    const pkgToRemove = packages.find(p => p.id === id);

    if (pkgToRemove) {
      setLogs(prev => [
        {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          action: isForce ? 'MỞ KHẨN CẤP' : 'NHẬN HÀNG',
          phone: pkgToRemove.phone,
          locker: pkgToRemove.locker,
          time: new Date().toLocaleTimeString(),
        },
        ...prev,
      ]);
    }

    setPackages(prev => prev.filter(p => p.id !== id));
  };

  const findPackageByToken = (token: string) => {
    const normalized = normalizeToken(token);
    return packages.find(pkg => pkg.pickupToken === normalized);
  };

  // Hoàn tất nhận hàng trên phần mềm.
  // Package bị xóa => QR cũ không thể dùng lần thứ hai.
  // Khi tích hợp phần cứng sau này, lệnh mở khóa có thể đặt trước thao tác này.
  const completePickupByToken = (token: string): PackageItem | null => {
    const normalized = normalizeToken(token);
    const pkg = packages.find(item => item.pickupToken === normalized);

    if (!pkg) {
      return null;
    }

    setPackages(prev => prev.filter(item => item.id !== pkg.id));

    setLogs(prev => [
      {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        action: 'NHẬN HÀNG',
        phone: pkg.phone,
        locker: pkg.locker,
        time: new Date().toLocaleTimeString(),
      },
      ...prev,
    ]);

    return pkg;
  };

  const clearHistory = () => {
    setLogs([]);
  };

  return (
    <LockerContext.Provider
      value={{
        packages,
        logs,
        isReady,
        addPackage,
        removePackage,
        findPackageByToken,
        completePickupByToken,
        clearHistory,
      }}
    >
      {isReady ? children : null}
    </LockerContext.Provider>
  );
};

export const useLocker = () => {
  const context = useContext(LockerContext);

  if (!context) {
    throw new Error('useLocker error');
  }

  return context;
};
