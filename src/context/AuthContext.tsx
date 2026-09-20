import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  AuthUser,
  UserRole,
  getCurrentUser,
  loginAccount,
  registerAccount,
} from '../services/authApi';

const REMEMBERED_ACCOUNTS_KEY =
  '@smartlocker_remembered_accounts_v1';

export type RememberedAccount = {
  key: string;
  phone: string;
  role: UserRole;
  userId: number;
  token: string;
  lastUsedAt: string;
};

type LoginInput = {
  phone: string;
  password: string;
  role: UserRole;
};

type RegisterInput = LoginInput & {
  adminCode?: string;
  shipperCode?: string;
};

type ContinueResult =
  | {
      ok: true;
      user: AuthUser;
    }
  | {
      ok: false;
      requiresPassword: true;
    };

type AuthContextType = {
  isReady: boolean;
  currentUser: AuthUser | null;
  currentToken: string | null;
  rememberedAccounts: RememberedAccount[];
  login: (input: LoginInput) => Promise<AuthUser>;
  register: (input: RegisterInput) => Promise<AuthUser>;
  continueWithAccount: (
    account: RememberedAccount,
  ) => Promise<ContinueResult>;
  logoutToHome: () => void;
  forgetAccount: (account: RememberedAccount) => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(
  undefined,
);

const makeAccountKey = (phone: string, role: UserRole) =>
  `${role}:${phone}`;

export const AuthProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [isReady, setIsReady] = useState(false);
  const [currentUser, setCurrentUser] =
    useState<AuthUser | null>(null);
  const [currentToken, setCurrentToken] =
    useState<string | null>(null);
  const [rememberedAccounts, setRememberedAccounts] = useState<
    RememberedAccount[]
  >([]);

  useEffect(() => {
    const loadRememberedAccounts = async () => {
      try {
        const raw = await AsyncStorage.getItem(
          REMEMBERED_ACCOUNTS_KEY,
        );

        if (!raw) {
          setRememberedAccounts([]);
          return;
        }

        const parsed = JSON.parse(raw);

        if (!Array.isArray(parsed)) {
          setRememberedAccounts([]);
          return;
        }

        const safeAccounts = parsed.filter(
          item =>
            item &&
            typeof item.phone === 'string' &&
            (item.role === 'ADMIN' ||
              item.role === 'RESIDENT' ||
              item.role === 'SHIPPER') &&
            typeof item.token === 'string',
        ) as RememberedAccount[];

        setRememberedAccounts(safeAccounts);
      } catch (error) {
        console.error('LOAD REMEMBERED ACCOUNTS ERROR:', error);
        setRememberedAccounts([]);
      } finally {
        setIsReady(true);
      }
    };

    loadRememberedAccounts();
  }, []);

  const persistAccounts = useCallback(
    async (accounts: RememberedAccount[]) => {
      setRememberedAccounts(accounts);

      await AsyncStorage.setItem(
        REMEMBERED_ACCOUNTS_KEY,
        JSON.stringify(accounts),
      );
    },
    [],
  );

  const rememberSession = useCallback(
    async (user: AuthUser, token: string) => {
      const account: RememberedAccount = {
        key: makeAccountKey(user.phone, user.role),
        phone: user.phone,
        role: user.role,
        userId: user.id,
        token,
        lastUsedAt: new Date().toISOString(),
      };

      const next = [
        account,
        ...rememberedAccounts.filter(
          item => item.key !== account.key,
        ),
      ];

      await persistAccounts(next);

      setCurrentUser(user);
      setCurrentToken(token);
    },
    [persistAccounts, rememberedAccounts],
  );

  const login = useCallback(
    async (input: LoginInput) => {
      const result = await loginAccount(input);

      await rememberSession(result.user, result.token);

      return result.user;
    },
    [rememberSession],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const result = await registerAccount(input);

      await rememberSession(result.user, result.token);

      return result.user;
    },
    [rememberSession],
  );

  const continueWithAccount = useCallback(
    async (
      account: RememberedAccount,
    ): Promise<ContinueResult> => {
      try {
        const user = await getCurrentUser(account.token);

        await rememberSession(user, account.token);

        return {
          ok: true,
          user,
        };
      } catch (error) {
        console.warn(
          'CONTINUE ACCOUNT REQUIRES LOGIN:',
          error,
        );

        // Giữ account trong danh sách để người dùng chỉ cần
        // nhập lại mật khẩu nếu token đã hết hạn.
        return {
          ok: false,
          requiresPassword: true,
        };
      }
    },
    [rememberSession],
  );

  const logoutToHome = useCallback(() => {
    // Chỉ thoát phiên đang mở.
    // KHÔNG xóa token đã nhớ vì UX yêu cầu bấm account để vào nhanh.
    setCurrentUser(null);
    setCurrentToken(null);
  }, []);

  const forgetAccount = useCallback(
    async (account: RememberedAccount) => {
      const next = rememberedAccounts.filter(
        item => item.key !== account.key,
      );

      await persistAccounts(next);

      if (
        currentUser &&
        currentUser.phone === account.phone &&
        currentUser.role === account.role
      ) {
        setCurrentUser(null);
        setCurrentToken(null);
      }
    },
    [
      currentUser,
      persistAccounts,
      rememberedAccounts,
    ],
  );

  const value = useMemo<AuthContextType>(
    () => ({
      isReady,
      currentUser,
      currentToken,
      rememberedAccounts,
      login,
      register,
      continueWithAccount,
      logoutToHome,
      forgetAccount,
    }),
    [
      isReady,
      currentUser,
      currentToken,
      rememberedAccounts,
      login,
      register,
      continueWithAccount,
      logoutToHome,
      forgetAccount,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error(
      'useAuth phải được dùng bên trong AuthProvider.',
    );
  }

  return context;
};
