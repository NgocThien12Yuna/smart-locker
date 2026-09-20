import { API_BASE_URL } from '../config/api';

export type UserRole = 'ADMIN' | 'RESIDENT' | 'SHIPPER';

export type AuthUser = {
  id: number;
  phone: string;
  role: UserRole;
  created_at?: string;
};

export type AuthResponse = {
  ok: boolean;
  message?: string;
  token: string;
  user: AuthUser;
};

export class ApiError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const parseJsonSafe = async (response: Response) => {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(
      `Backend trả dữ liệu không hợp lệ (HTTP ${response.status}).`,
      response.status,
    );
  }
};

const request = async (
  path: string,
  options: RequestInit = {},
) => {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    console.error('AUTH NETWORK ERROR:', error);

    throw new ApiError(
      'Không kết nối được SmartLocker Backend. Kiểm tra Internet và backend Railway.',
      0,
    );
  }

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    throw new ApiError(
      data?.message || `Backend lỗi HTTP ${response.status}.`,
      response.status,
    );
  }

  return data;
};

export const normalizePhone = (value: string) =>
  String(value || '').replace(/\D/g, '').slice(0, 10);

export const registerAccount = async (payload: {
  phone: string;
  password: string;
  role: UserRole;
  adminCode?: string;
  shipperCode?: string;
}): Promise<AuthResponse> => {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      phone: normalizePhone(payload.phone),
      password: payload.password,
      role: payload.role,
      ...(payload.role === 'ADMIN'
        ? { adminCode: payload.adminCode || '' }
        : {}),
      ...(payload.role === 'SHIPPER'
        ? { shipperCode: payload.shipperCode || '' }
        : {}),
    }),
  });
};

export const loginAccount = async (input: {
  phone: string;
  password: string;
  role: UserRole;
}) => {
  const url = `${API_BASE_URL}/auth/login`;

  console.log('==============================');
  console.log('🌐 API_BASE_URL =', API_BASE_URL);
  console.log('🔐 LOGIN URL =', url);
  console.log('🔐 LOGIN INPUT =', {
    phone: input.phone,
    role: input.role,
  });
  console.log('==============================');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    console.log(
      '🔐 LOGIN HTTP STATUS =',
      response.status,
    );

    const data = await response.json();

    console.log(
      '🔐 LOGIN RESPONSE =',
      data,
    );

    if (!response.ok || !data?.ok) {
      throw new Error(
        data?.message ||
          `Đăng nhập thất bại HTTP ${response.status}`,
      );
    }

    return {
      user: data.user,
      token: data.token,
    };
  } catch (error) {
    console.log(
      '❌ AUTH REAL ERROR =',
      error,
    );

    throw error;
  }
};

export const getCurrentUser = async (
  token: string,
): Promise<AuthUser> => {
  const data = await request('/auth/me', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return data.user as AuthUser;
};
