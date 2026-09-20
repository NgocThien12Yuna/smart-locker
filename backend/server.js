require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const {
  initializeApp,
  cert,
  getApps,
} = require('firebase-admin/app');

const {
  getMessaging,
} = require('firebase-admin/messaging');

const db = require('./database');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const SHIPPER_REGISTER_CODE = process.env.SHIPPER_REGISTER_CODE;

if (!JWT_SECRET) {
  throw new Error('Thiếu JWT_SECRET trong file .env');
}

// ======================================================
// LOCKER MASTER
// ======================================================
//
// Size package hiện từ Shipper vẫn là M.
// Backend sẽ tự chọn tủ trống:
// - ưu tiên đúng size;
// - nếu hết đúng size thì dùng tủ lớn hơn;
// - không bao giờ dùng tủ nhỏ hơn package.

const ALL_LOCKERS = [
  { id: 'A01', name: 'Tủ A01', size: 'M' },
  { id: 'A02', name: 'Tủ A02', size: 'M' },
  { id: 'B01', name: 'Tủ B01', size: 'S' },
  { id: 'B05', name: 'Tủ B05', size: 'M' },
  { id: 'C01', name: 'Tủ C01', size: 'L' },
  { id: 'C02', name: 'Tủ C02', size: 'L' },
];

const SIZE_RANK = {
  S: 1,
  M: 2,
  L: 3,
};

const OTP_TTL_MINUTES = Number(
  process.env.OTP_TTL_MINUTES || 15,
);

// ======================================================
// FIREBASE ADMIN
// ======================================================
//
// LOCAL DEV:
//   FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
//
// RAILWAY:
//   Khuyên dùng FIREBASE_SERVICE_ACCOUNT_JSON.
//   Paste nguyên nội dung JSON private key vào Railway Variables.
//
// Ngoài ra hỗ trợ FIREBASE_SERVICE_ACCOUNT_BASE64 nếu muốn base64.

let firebaseReady = false;
let firebaseInitError = '';

const loadFirebaseServiceAccount = () => {
  // 1) Railway / Cloud: raw JSON env
  if (
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ) {
    return JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    );
  }

  // 2) Railway / Cloud: base64 env
  if (
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
  ) {
    const decoded = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      'base64',
    ).toString('utf8');

    return JSON.parse(decoded);
  }

  // 3) Local fallback: JSON file
  const firebaseCredentialPathRaw =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    './firebase-service-account.json';

  const firebaseCredentialPath =
    path.isAbsolute(
      firebaseCredentialPathRaw,
    )
      ? firebaseCredentialPathRaw
      : path.resolve(
          __dirname,
          firebaseCredentialPathRaw,
        );

  if (
    !fs.existsSync(
      firebaseCredentialPath,
    )
  ) {
    throw new Error(
      `Không thấy Firebase credentials. ` +
        `Hãy cấu hình FIREBASE_SERVICE_ACCOUNT_JSON trên cloud ` +
        `hoặc file local tại ${firebaseCredentialPath}`,
    );
  }

  return JSON.parse(
    fs.readFileSync(
      firebaseCredentialPath,
      'utf8',
    ),
  );
};

try {
  const serviceAccount =
    loadFirebaseServiceAccount();

  if (getApps().length === 0) {
    initializeApp({
      credential:
        cert(serviceAccount),
    });
  }

  firebaseReady = true;

  console.log(
    '✅ Firebase Admin ready',
  );

  console.log(
    '🔐 Firebase credentials source:',
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? 'ENV JSON'
      : process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
        ? 'ENV BASE64'
        : 'LOCAL FILE',
  );
} catch (error) {
  firebaseInitError =
    error?.message ||
    String(error);

  console.error(
    '❌ FIREBASE ADMIN INIT ERROR:',
    error,
  );
}

// ======================================================
// HELPERS
// ======================================================

const normalizePhone = value => {
  return String(value || '')
    .replace(/\D/g, '');
};

const isValidVietnamPhone = phone => {
  return /^0\d{9}$/.test(phone);
};

const normalizeSize = value => {
  const size = String(value || 'M')
    .trim()
    .toUpperCase();

  return SIZE_RANK[size]
    ? size
    : 'M';
};

const createToken = user => {
  return jwt.sign(
    {
      userId: user.id,
      phone: user.phone,
      role: user.role,
    },
    JWT_SECRET,
    {
      expiresIn: '30d',
    },
  );
};

const createPackagePublicId = () => {
  return (
    'PKG_' +
    crypto
      .randomUUID()
      .replace(/-/g, '')
      .slice(0, 16)
      .toUpperCase()
  );
};

// Giữ cho tương thích DB cũ.
const createLegacyPickupToken = () => {
  return (
    'SLK_' +
    crypto
      .randomBytes(32)
      .toString('hex')
  );
};

const createPickupOtp = () => {
  return String(
    crypto.randomInt(0, 1000000),
  ).padStart(6, '0');
};

const formatSqliteUtc = date => {
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
};

const otpEncryptionKey = crypto
  .createHash('sha256')
  .update(
    `${JWT_SECRET}:SMARTLOCKER_OTP_ENCRYPTION_V1`,
  )
  .digest();

const hashOtp = otp => {
  return crypto
    .createHmac(
      'sha256',
      otpEncryptionKey,
    )
    .update(otp)
    .digest('hex');
};

const encryptOtp = otp => {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    otpEncryptionKey,
    iv,
  );

  const encrypted = Buffer.concat([
    cipher.update(
      otp,
      'utf8',
    ),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    enc: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
};

const decryptOtp = row => {
  if (
    !row.pickup_otp_enc ||
    !row.pickup_otp_iv ||
    !row.pickup_otp_tag
  ) {
    return null;
  }

  try {
    const decipher =
      crypto.createDecipheriv(
        'aes-256-gcm',
        otpEncryptionKey,
        Buffer.from(
          row.pickup_otp_iv,
          'base64',
        ),
      );

    decipher.setAuthTag(
      Buffer.from(
        row.pickup_otp_tag,
        'base64',
      ),
    );

    const decrypted = Buffer.concat([
      decipher.update(
        Buffer.from(
          row.pickup_otp_enc,
          'base64',
        ),
      ),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    console.error(
      'OTP DECRYPT ERROR:',
      error,
    );

    return null;
  }
};

const createOtpBundle = () => {
  const otp = createPickupOtp();

  const expiresAt = formatSqliteUtc(
    new Date(
      Date.now() +
        OTP_TTL_MINUTES *
          60 *
          1000,
    ),
  );

  const encrypted =
    encryptOtp(otp);

  return {
    otp,
    hash: hashOtp(otp),
    enc: encrypted.enc,
    iv: encrypted.iv,
    tag: encrypted.tag,
    expiresAt,
  };
};

const isOtpExpired = row => {
  if (!row.otp_expires_at) {
    return true;
  }

  const expiresAt = Date.parse(
    row.otp_expires_at.includes('T')
      ? row.otp_expires_at
      : `${row.otp_expires_at.replace(' ', 'T')}Z`,
  );

  if (!Number.isFinite(expiresAt)) {
    return true;
  }

  return expiresAt <= Date.now();
};

const safeOtpCompare = (
  receivedOtp,
  expectedHash,
) => {
  if (!expectedHash) {
    return false;
  }

  const receivedHash =
    hashOtp(receivedOtp);

  const a = Buffer.from(
    receivedHash,
    'hex',
  );

  const b = Buffer.from(
    expectedHash,
    'hex',
  );

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    a,
    b,
  );
};

const writeOtpBundle = (
  packageId,
  bundle,
) => {
  db.prepare(`
    UPDATE packages
    SET
      pickup_otp = NULL,
      pickup_otp_hash = ?,
      pickup_otp_enc = ?,
      pickup_otp_iv = ?,
      pickup_otp_tag = ?,
      otp_expires_at = ?
    WHERE id = ?
  `).run(
    bundle.hash,
    bundle.enc,
    bundle.iv,
    bundle.tag,
    bundle.expiresAt,
    packageId,
  );
};

const chooseAvailableLocker =
  packageSize => {
    const normalizedSize =
      normalizeSize(packageSize);

    const occupiedRows = db
      .prepare(`
        SELECT DISTINCT locker
        FROM packages
        WHERE status = 'READY'
      `)
      .all();

    const occupied =
      new Set(
        occupiedRows.map(
          row => row.locker,
        ),
      );

    return (
      ALL_LOCKERS
        .filter(
          locker =>
            !occupied.has(
              locker.id,
            ) &&
            SIZE_RANK[
              locker.size
            ] >=
              SIZE_RANK[
                normalizedSize
              ],
        )
        .sort((a, b) => {
          // Ưu tiên tủ vừa size trước.
          const sizeDiffA =
            SIZE_RANK[a.size] -
            SIZE_RANK[
              normalizedSize
            ];

          const sizeDiffB =
            SIZE_RANK[b.size] -
            SIZE_RANK[
              normalizedSize
            ];

          if (
            sizeDiffA !==
            sizeDiffB
          ) {
            return (
              sizeDiffA -
              sizeDiffB
            );
          }

          return a.id.localeCompare(
            b.id,
          );
        })[0] || null
    );
  };

const authMiddleware = (
  req,
  res,
  next,
) => {
  const header =
    req.headers.authorization;

  if (
    !header ||
    !header.startsWith(
      'Bearer ',
    )
  ) {
    return res
      .status(401)
      .json({
        ok: false,
        message:
          'Chưa đăng nhập.',
      });
  }

  const token =
    header
      .substring(7)
      .trim();

  if (!token) {
    return res
      .status(401)
      .json({
        ok: false,
        message:
          'Chưa đăng nhập.',
      });
  }

  try {
    const payload =
      jwt.verify(
        token,
        JWT_SECRET,
      );

    req.user = payload;
    next();
  } catch {
    return res
      .status(401)
      .json({
        ok: false,
        message:
          'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.',
      });
  }
};

const requireAdmin = (
  req,
  res,
) => {
  if (
    req.user?.role !==
    'ADMIN'
  ) {
    res.status(403).json({
      ok: false,
      message:
        'Chỉ Admin mới có quyền sử dụng chức năng này.',
    });

    return false;
  }

  return true;
};

const addActivityLog = ({
  eventKey,
  action,
  packageId,
  phone,
  locker,
  createdAt,
}) => {
  db.prepare(`
    INSERT OR IGNORE INTO activity_logs (
      event_key,
      action,
      package_public_id,
      phone,
      locker,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).run(
    eventKey,
    action,
    packageId || null,
    phone,
    locker,
    createdAt || null,
  );
};

const ensureLegacyOtpMigrated =
  row => {
    if (
      row.status !==
      'READY'
    ) {
      return row;
    }

    if (
      row.pickup_otp_hash &&
      row.pickup_otp_enc &&
      row.pickup_otp_iv &&
      row.pickup_otp_tag &&
      row.otp_expires_at
    ) {
      return row;
    }

    // Nếu còn plaintext từ patch cũ, mã hóa lại chính OTP đó.
    if (
      row.pickup_otp &&
      /^\d{6}$/.test(
        row.pickup_otp,
      )
    ) {
      const encrypted =
        encryptOtp(
          row.pickup_otp,
        );

      const expiresAt =
        formatSqliteUtc(
          new Date(
            Date.now() +
              OTP_TTL_MINUTES *
                60 *
                1000,
          ),
        );

      db.prepare(`
        UPDATE packages
        SET
          pickup_otp = NULL,
          pickup_otp_hash = ?,
          pickup_otp_enc = ?,
          pickup_otp_iv = ?,
          pickup_otp_tag = ?,
          otp_expires_at = ?
        WHERE id = ?
      `).run(
        hashOtp(
          row.pickup_otp,
        ),
        encrypted.enc,
        encrypted.iv,
        encrypted.tag,
        expiresAt,
        row.id,
      );
    } else {
      const bundle =
        createOtpBundle();

      writeOtpBundle(
        row.id,
        bundle,
      );
    }

    return db
      .prepare(`
        SELECT *
        FROM packages
        WHERE id = ?
      `)
      .get(row.id);
  };

const mapPackageForResident =
  rawRow => {
    const row =
      ensureLegacyOtpMigrated(
        rawRow,
      );

    const expired =
      row.status ===
        'READY' &&
      isOtpExpired(row);

    const otp =
      row.status ===
        'READY' &&
      !expired
        ? decryptOtp(row)
        : null;

    return {
      id: row.public_id,
      phone:
        row.receiver_phone,
      locker: row.locker,
      size: row.size,
      sender: row.sender,
      pickupOtp: otp,
      otpExpiresAt:
        row.otp_expires_at,
      otpExpired: expired,
      status: row.status,
      createdAt:
        row.created_at,
      pickedUpAt:
        row.picked_up_at,
    };
  };

const sendPackageNotification =
  async ({
    userId,
    phone,
    packagePublicId,
    locker,
  }) => {
    const devices = db
      .prepare(`
        SELECT
          id,
          fcm_token,
          platform
        FROM devices
        WHERE user_id = ?
      `)
      .all(userId);

    if (
      devices.length === 0
    ) {
      return {
        ok: true,
        noDevice: true,
        successCount: 0,
        failureCount: 0,
        message:
          'Cư dân chưa liên kết thiết bị nhận thông báo.',
      };
    }

    if (!firebaseReady) {
      return {
        ok: false,
        noDevice: false,
        successCount: 0,
        failureCount:
          devices.length,
        message:
          firebaseInitError ||
          'Firebase Admin chưa được cấu hình.',
      };
    }

    const tokens =
      devices.map(
        device =>
          device.fcm_token,
      );

    const result =
      await getMessaging()
        .sendEachForMulticast({
          tokens,

          notification: {
            title:
              '📦 SmartLocker',
            body:
              `Bạn có kiện hàng mới tại tủ ${locker}. ` +
              'Bấm thông báo để mở đơn nhận hàng.',
          },

          data: {
            type:
              'NEW_PACKAGE',
            screen:
              'Resident',
            packageId:
              packagePublicId,
            receiverPhone:
              phone,
            locker,
          },

          android: {
            priority: 'high',
            notification: {
              sound: 'default',
            },
          },
        });

    const invalidTokenCodes =
      new Set([
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
      ]);

    result.responses.forEach(
      (
        response,
        index,
      ) => {
        if (
          response.success
        ) {
          return;
        }

        const errorCode =
          response.error?.code;

        console.warn(
          '⚠️ FCM SEND ERROR:',
          tokens[index]
            ?.slice(0, 18),
          errorCode,
          response.error
            ?.message,
        );

        if (
          errorCode &&
          invalidTokenCodes.has(
            errorCode,
          )
        ) {
          db.prepare(`
            DELETE FROM devices
            WHERE user_id = ?
              AND fcm_token = ?
          `).run(
            userId,
            tokens[index],
          );
        }
      },
    );

    return {
      ok:
        result.successCount >
        0,
      noDevice: false,
      successCount:
        result.successCount,
      failureCount:
        result.failureCount,
      message:
        result.successCount >
        0
          ? 'Đã gửi Firebase notification.'
          : 'Không gửi được Firebase notification.',
    };
  };

// ======================================================
// HEALTH
// ======================================================

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      service:
        'smartlocker-backend',
      environment:
        process.env.RAILWAY_ENVIRONMENT_NAME ||
        process.env.NODE_ENV ||
        'local',
      cloud:
        !!process.env.RAILWAY_PROJECT_ID,
      persistentVolume:
        !!process.env.RAILWAY_VOLUME_MOUNT_PATH,
      firebaseAdmin:
        firebaseReady,
      firebaseError:
        firebaseReady
          ? null
          : firebaseInitError,
      otpTtlMinutes:
        OTP_TTL_MINUTES,
      lockers:
        ALL_LOCKERS.length,
    });
  },
);

// ======================================================
// AUTH REGISTER
// ======================================================

app.post(
  '/auth/register',
  async (req, res) => {
    try {
      const phone =
        normalizePhone(
          req.body.phone,
        );

      const password =
        String(
          req.body.password ||
            '',
        );

      const role =
        String(
          req.body.role ||
            '',
        ).toUpperCase();

      const adminCode =
        String(
          req.body
            .adminCode ||
            '',
        );

      const shipperCode =
        String(
          req.body
            .shipperCode ||
            '',
        );

      if (
        !isValidVietnamPhone(
          phone,
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            message:
              'Số điện thoại phải gồm 10 số và bắt đầu bằng 0.',
          });
      }

      if (
        password.length <
        6
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            message:
              'Mật khẩu phải có ít nhất 6 ký tự.',
          });
      }

      if (
        ![
          'ADMIN',
          'RESIDENT',
          'SHIPPER',
        ].includes(role)
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            message:
              'Vai trò không hợp lệ.',
          });
      }

      if (
        role === 'ADMIN'
      ) {
        if (
          !process.env
            .ADMIN_REGISTER_CODE ||
          adminCode !==
            process.env
              .ADMIN_REGISTER_CODE
        ) {
          return res
            .status(403)
            .json({
              ok: false,
              message:
                'Mã đăng ký Admin không đúng.',
            });
        }
      }

      if (
        role === 'SHIPPER'
      ) {
        if (
          !SHIPPER_REGISTER_CODE ||
          shipperCode !== SHIPPER_REGISTER_CODE
        ) {
          return res
            .status(403)
            .json({
              ok: false,
              message:
                'Mã giới thiệu Shipper không đúng.',
            });
        }
      }

      const existing =
        db.prepare(`
          SELECT id
          FROM users
          WHERE phone = ?
            AND role = ?
        `).get(
          phone,
          role,
        );

      if (existing) {
        return res
          .status(409)
          .json({
            ok: false,
            message:
              'Tài khoản này đã tồn tại.',
          });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          10,
        );

      const result =
        db.prepare(`
          INSERT INTO users (
            phone,
            password_hash,
            role
          )
          VALUES (?, ?, ?)
        `).run(
          phone,
          passwordHash,
          role,
        );

      const user = {
        id: Number(
          result.lastInsertRowid,
        ),
        phone,
        role,
      };

      const token =
        createToken(user);

      return res
        .status(201)
        .json({
          ok: true,
          message:
            'Đăng ký thành công.',
          token,
          user,
        });
    } catch (error) {
      console.error(
        'REGISTER ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi đăng ký.',
        });
    }
  },
);

// ======================================================
// AUTH LOGIN
// ======================================================

app.post(
  '/auth/login',
  async (req, res) => {
    try {
      const phone =
        normalizePhone(
          req.body.phone,
        );

      const password =
        String(
          req.body.password ||
            '',
        );

      const role =
        String(
          req.body.role ||
            '',
        ).toUpperCase();

      if (
        !phone ||
        !password ||
        !role
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            message:
              'Thiếu thông tin đăng nhập.',
          });
      }

      const userRow =
        db.prepare(`
          SELECT *
          FROM users
          WHERE phone = ?
            AND role = ?
        `).get(
          phone,
          role,
        );

      if (!userRow) {
        return res
          .status(401)
          .json({
            ok: false,
            message:
              'Không tìm thấy tài khoản.',
          });
      }

      const passwordOk =
        await bcrypt.compare(
          password,
          userRow
            .password_hash,
        );

      if (!passwordOk) {
        return res
          .status(401)
          .json({
            ok: false,
            message:
              'Mật khẩu không đúng.',
          });
      }

      const user = {
        id: userRow.id,
        phone:
          userRow.phone,
        role:
          userRow.role,
      };

      const token =
        createToken(user);

      return res.json({
        ok: true,
        message:
          'Đăng nhập thành công.',
        token,
        user,
      });
    } catch (error) {
      console.error(
        'LOGIN ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi đăng nhập.',
        });
    }
  },
);

// ======================================================
// CURRENT USER
// ======================================================

app.get(
  '/auth/me',
  authMiddleware,
  (req, res) => {
    const user =
      db.prepare(`
        SELECT
          id,
          phone,
          role,
          created_at
        FROM users
        WHERE id = ?
      `).get(
        req.user.userId,
      );

    if (!user) {
      return res
        .status(404)
        .json({
          ok: false,
          message:
            'Tài khoản không còn tồn tại.',
        });
    }

    return res.json({
      ok: true,
      user,
    });
  },
);

// ======================================================
// REGISTER / UPDATE FCM DEVICE
// ======================================================

app.post(
  '/devices/register',
  authMiddleware,
  (req, res) => {
    try {
      if (
        req.user.role !==
        'RESIDENT'
      ) {
        return res
          .status(403)
          .json({
            ok: false,
            message:
              'Chỉ tài khoản Cư dân mới đăng ký thiết bị nhận hàng.',
          });
      }

      const fcmToken =
        String(
          req.body
            .fcmToken ||
            '',
        ).trim();

      const platform =
        String(
          req.body
            .platform ||
            'android',
        )
          .trim()
          .toLowerCase();

      if (!fcmToken) {
        return res
          .status(400)
          .json({
            ok: false,
            message:
              'Thiếu FCM token.',
          });
      }

      if (
        ![
          'android',
          'ios',
        ].includes(platform)
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            message:
              'Platform không hợp lệ.',
          });
      }

      const user =
        db.prepare(`
          SELECT
            id,
            phone,
            role
          FROM users
          WHERE id = ?
        `).get(
          req.user.userId,
        );

      if (!user) {
        return res
          .status(404)
          .json({
            ok: false,
            message:
              'Tài khoản không còn tồn tại.',
          });
      }

      db.prepare(`
        INSERT INTO devices (
          user_id,
          fcm_token,
          platform,
          updated_at
        )
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)

        ON CONFLICT(
          user_id,
          fcm_token
        )
        DO UPDATE SET
          platform =
            excluded.platform,
          updated_at =
            CURRENT_TIMESTAMP
      `).run(
        user.id,
        fcmToken,
        platform,
      );

      console.log(
        `📱 DEVICE REGISTERED: ${user.phone} | ${platform} | ${fcmToken.slice(0, 18)}...`,
      );

      return res.json({
        ok: true,
        message:
          'Đã liên kết thiết bị nhận thông báo.',
        device: {
          phone:
            user.phone,
          platform,
        },
      });
    } catch (error) {
      console.error(
        'DEVICE REGISTER ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi đăng ký thiết bị.',
        });
    }
  },
);

// ======================================================
// GET CURRENT USER DEVICES
// ======================================================

app.get(
  '/devices/me',
  authMiddleware,
  (req, res) => {
    try {
      const devices =
        db.prepare(`
          SELECT
            id,
            platform,
            updated_at,
            substr(
              fcm_token,
              1,
              12
            ) || '...' ||
            substr(
              fcm_token,
              -8
            )
              AS token_preview
          FROM devices
          WHERE user_id = ?
          ORDER BY
            updated_at DESC
        `).all(
          req.user.userId,
        );

      return res.json({
        ok: true,
        count:
          devices.length,
        devices,
      });
    } catch (error) {
      console.error(
        'GET DEVICES ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi đọc thiết bị.',
        });
    }
  },
);

// ======================================================
// CREATE PACKAGE - CHỈ SHIPPER ĐÃ ĐĂNG NHẬP
// ======================================================
//
// Backend bắt JWT và role SHIPPER, nên không thể bypass chỉ bằng URL.

app.post(
  '/packages',
  authMiddleware,
  async (req, res) => {
    if (
      req.user?.role !== 'SHIPPER'
    ) {
      return res
        .status(403)
        .json({
          ok: false,
          message:
            'Chỉ tài khoản Shipper mới được tạo đơn giao hàng.',
        });
    }
    try {
      const receiverPhone =
        normalizePhone(
          req.body
            .receiverPhone,
        );

      const size =
        normalizeSize(
          req.body.size,
        );

      const sender =
        `Shipper ${req.user.phone}`;

      if (
        !isValidVietnamPhone(
          receiverPhone,
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            message:
              'SĐT người nhận không hợp lệ.',
          });
      }

      const resident =
        db.prepare(`
          SELECT
            id,
            phone
          FROM users
          WHERE phone = ?
            AND role = 'RESIDENT'
        `).get(
          receiverPhone,
        );

      if (!resident) {
        return res
          .status(404)
          .json({
            ok: false,
            message:
              `SĐT ${receiverPhone} chưa có tài khoản Cư dân SmartLocker.`,
          });
      }

      const selectedLocker =
        chooseAvailableLocker(
          size,
        );

      if (!selectedLocker) {
        return res
          .status(409)
          .json({
            ok: false,
            message:
              `Hiện không còn tủ đủ kích thước cho kiện size ${size}.`,
          });
      }

      const publicId =
        createPackagePublicId();

      const legacyPickupToken =
        createLegacyPickupToken();

      const otpBundle =
        createOtpBundle();

      db.prepare(`
        INSERT INTO packages (
          public_id,
          receiver_user_id,
          receiver_phone,
          locker,
          size,
          sender,
          pickup_token,
          pickup_otp,
          pickup_otp_hash,
          pickup_otp_enc,
          pickup_otp_iv,
          pickup_otp_tag,
          otp_expires_at,
          status
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'READY'
        )
      `).run(
        publicId,
        resident.id,
        resident.phone,
        selectedLocker.id,
        size,
        sender,
        legacyPickupToken,
        otpBundle.hash,
        otpBundle.enc,
        otpBundle.iv,
        otpBundle.tag,
        otpBundle.expiresAt,
      );

      const packageRow =
        db.prepare(`
          SELECT *
          FROM packages
          WHERE public_id = ?
        `).get(
          publicId,
        );

      addActivityLog({
        eventKey:
          `PACKAGE_CREATED:${publicId}`,
        action:
          'GỬI HÀNG',
        packageId:
          publicId,
        phone:
          resident.phone,
        locker:
          selectedLocker.id,
        createdAt:
          packageRow
            .created_at,
      });

      const notification =
        await sendPackageNotification({
          userId:
            resident.id,
          phone:
            resident.phone,
          packagePublicId:
            publicId,
          locker:
            selectedLocker.id,
        });

      console.log(
        `📦 PACKAGE CREATED: ${publicId} -> ${receiverPhone} -> ${selectedLocker.id}`,
      );

      console.log(
        `🔐 OTP GENERATED: ****** | expires ${otpBundle.expiresAt}`,
      );

      console.log(
        '🔔 NOTIFICATION RESULT:',
        notification,
      );

      // Không trả OTP cho Shipper.
      return res
        .status(201)
        .json({
          ok: true,
          message:
            'Đã tạo kiện hàng.',
          package: {
            id:
              packageRow
                .public_id,
            phone:
              packageRow
                .receiver_phone,
            locker:
              packageRow
                .locker,
            size:
              packageRow.size,
            sender:
              packageRow
                .sender,
            status:
              packageRow
                .status,
            createdAt:
              packageRow
                .created_at,
          },
          notification,
        });
    } catch (error) {
      console.error(
        'CREATE PACKAGE ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi tạo kiện hàng.',
        });
    }
  },
);

// ======================================================
// RESIDENT - GET MY PACKAGES
// ======================================================

app.get(
  '/packages/my',
  authMiddleware,
  (req, res) => {
    try {
      if (
        req.user.role !==
        'RESIDENT'
      ) {
        return res
          .status(403)
          .json({
            ok: false,
            message:
              'Chỉ tài khoản Cư dân mới xem đơn nhận hàng.',
          });
      }

      const rows =
        db.prepare(`
          SELECT *
          FROM packages
          WHERE receiver_user_id = ?
          ORDER BY
            CASE status
              WHEN 'READY' THEN 0
              WHEN 'PICKED_UP' THEN 1
              ELSE 2
            END,
            created_at DESC
        `).all(
          req.user.userId,
        );

      return res.json({
        ok: true,
        packages:
          rows.map(
            mapPackageForResident,
          ),
      });
    } catch (error) {
      console.error(
        'GET MY PACKAGES ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi đọc kiện hàng.',
        });
    }
  },
);

// ======================================================
// RESIDENT - REFRESH EXPIRED OTP
// ======================================================

app.post(
  '/packages/:packageId/otp/refresh',
  authMiddleware,
  (req, res) => {
    try {
      if (
        req.user.role !==
        'RESIDENT'
      ) {
        return res
          .status(403)
          .json({
            ok: false,
            message:
              'Chỉ tài khoản Cư dân mới được cấp lại OTP.',
          });
      }

      const packageId =
        String(
          req.params
            .packageId ||
            '',
        ).trim();

      const packageRow =
        db.prepare(`
          SELECT *
          FROM packages
          WHERE public_id = ?
            AND receiver_user_id = ?
        `).get(
          packageId,
          req.user.userId,
        );

      if (!packageRow) {
        return res
          .status(404)
          .json({
            ok: false,
            message:
              'Không tìm thấy kiện hàng thuộc tài khoản này.',
          });
      }

      if (
        packageRow.status !==
        'READY'
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            message:
              'Kiện hàng không còn ở trạng thái chờ lấy.',
          });
      }

      const bundle =
        createOtpBundle();

      writeOtpBundle(
        packageRow.id,
        bundle,
      );

      console.log(
        `🔄 OTP REFRESHED: ${packageRow.public_id} | expires ${bundle.expiresAt}`,
      );

      return res.json({
        ok: true,
        message:
          'Đã cấp OTP mới.',
        otp:
          bundle.otp,
        otpExpiresAt:
          bundle.expiresAt,
      });
    } catch (error) {
      console.error(
        'REFRESH OTP ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi cấp lại OTP.',
        });
    }
  },
);

// ======================================================
// RESIDENT - REDEEM OTP / OPEN LOCKER
// ======================================================
//
// HIỆN TẠI: SOFTWARE MODE.
// Sau này thay block mở tủ bằng HTTP/MQTT tới ESP32.
// Chỉ khi ESP32 phản hồi thành công mới UPDATE PICKED_UP.

app.post(
  '/packages/:packageId/redeem',
  authMiddleware,
  (req, res) => {
    try {
      if (
        req.user.role !==
        'RESIDENT'
      ) {
        return res
          .status(403)
          .json({
            ok: false,
            message:
              'Chỉ tài khoản Cư dân mới được mở tủ nhận hàng.',
          });
      }

      const packageId =
        String(
          req.params
            .packageId ||
            '',
        ).trim();

      const otp =
        String(
          req.body.otp ||
            '',
        )
          .replace(/\D/g, '')
          .slice(0, 6);

      if (
        !/^\d{6}$/.test(
          otp,
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            message:
              'OTP phải gồm đúng 6 chữ số.',
          });
      }

      let packageRow =
        db.prepare(`
          SELECT *
          FROM packages
          WHERE public_id = ?
            AND receiver_user_id = ?
        `).get(
          packageId,
          req.user.userId,
        );

      if (!packageRow) {
        return res
          .status(404)
          .json({
            ok: false,
            message:
              'Không tìm thấy kiện hàng thuộc tài khoản này.',
          });
      }

      packageRow =
        ensureLegacyOtpMigrated(
          packageRow,
        );

      if (
        packageRow.status !==
        'READY'
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            message:
              packageRow.status ===
              'PICKED_UP'
                ? 'Kiện hàng này đã được nhận trước đó. OTP không còn hiệu lực.'
                : 'Kiện hàng hiện không ở trạng thái có thể nhận.',
          });
      }

      if (
        isOtpExpired(
          packageRow,
        )
      ) {
        return res
          .status(410)
          .json({
            ok: false,
            code:
              'OTP_EXPIRED',
            message:
              'OTP đã hết hạn. Hãy bấm Cấp lại OTP trong ứng dụng.',
          });
      }

      if (
        !safeOtpCompare(
          otp,
          packageRow
            .pickup_otp_hash,
        )
      ) {
        return res
          .status(401)
          .json({
            ok: false,
            message:
              'OTP không đúng.',
          });
      }

      // SOFTWARE MODE:
      // Sau này: gửi lệnh ESP32 trước, thành công rồi mới update.
      const updateResult =
        db.prepare(`
          UPDATE packages
          SET
            status = 'PICKED_UP',
            picked_up_at = CURRENT_TIMESTAMP,

            pickup_otp = NULL,
            pickup_otp_hash = NULL,
            pickup_otp_enc = NULL,
            pickup_otp_iv = NULL,
            pickup_otp_tag = NULL,
            otp_expires_at = NULL

          WHERE id = ?
            AND status = 'READY'
        `).run(
          packageRow.id,
        );

      if (
        updateResult.changes !==
        1
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            message:
              'OTP vừa được sử dụng hoặc trạng thái đơn đã thay đổi.',
          });
      }

      addActivityLog({
        eventKey:
          `PACKAGE_PICKED_UP:${packageRow.public_id}`,
        action:
          'NHẬN HÀNG',
        packageId:
          packageRow.public_id,
        phone:
          packageRow.receiver_phone,
        locker:
          packageRow.locker,
      });

      console.log(
        `🔓 SOFTWARE OPEN: ${packageRow.locker} | ${packageRow.public_id} | user=${req.user.userId}`,
      );

      return res.json({
        ok: true,
        hardwareMode: false,
        mode:
          'SOFTWARE',
        locker:
          packageRow.locker,
        packageId:
          packageRow
            .public_id,
        status:
          'PICKED_UP',
        message:
          `OTP hợp lệ. Mô phỏng mở tủ ${packageRow.locker} thành công.`,
      });
    } catch (error) {
      console.error(
        'REDEEM OTP ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi xác minh OTP.',
        });
    }
  },
);

// ======================================================
// ADMIN - REALTIME OVERVIEW
// ======================================================

app.get(
  '/admin/overview',
  authMiddleware,
  (req, res) => {
    try {
      if (
        !requireAdmin(
          req,
          res,
        )
      ) {
        return;
      }

      const activePackages =
        db.prepare(`
          SELECT
            public_id,
            receiver_phone,
            locker,
            size,
            sender,
            status,
            created_at
          FROM packages
          WHERE status = 'READY'
          ORDER BY created_at DESC
        `).all();

      const activeByLocker =
        new Map();

      for (
        const pkg of
          activePackages
      ) {
        if (
          !activeByLocker.has(
            pkg.locker,
          )
        ) {
          activeByLocker.set(
            pkg.locker,
            pkg,
          );
        }
      }

      const lockers =
        ALL_LOCKERS.map(
          locker => {
            const pkg =
              activeByLocker.get(
                locker.id,
              ) || null;

            return {
              ...locker,
              occupied:
                !!pkg,
              package: pkg
                ? {
                    id:
                      pkg.public_id,
                    phone:
                      pkg.receiver_phone,
                    size:
                      pkg.size,
                    sender:
                      pkg.sender,
                    status:
                      pkg.status,
                    createdAt:
                      pkg.created_at,
                  }
                : null,
            };
          },
        );

      const occupiedLockers =
        lockers.filter(
          item =>
            item.occupied,
        ).length;

      const totalTransactions =
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM activity_logs
        `).get().count;

      return res.json({
        ok: true,
        stats: {
          totalLockers:
            lockers.length,
          occupiedLockers,
          emptyLockers:
            lockers.length -
            occupiedLockers,
          totalTransactions,
        },
        lockers,
      });
    } catch (error) {
      console.error(
        'ADMIN OVERVIEW ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi tải trạng thái tủ.',
        });
    }
  },
);

// ======================================================
// ADMIN - PERSISTENT HISTORY
// ======================================================

app.get(
  '/admin/history',
  authMiddleware,
  (req, res) => {
    try {
      if (
        !requireAdmin(
          req,
          res,
        )
      ) {
        return;
      }

      const logs =
        db.prepare(`
          SELECT
            id,
            action,
            package_public_id,
            phone,
            locker,
            created_at
          FROM activity_logs
          ORDER BY
            datetime(created_at) DESC,
            id DESC
          LIMIT 500
        `).all();

      return res.json({
        ok: true,
        logs:
          logs.map(
            item => ({
              id:
                String(
                  item.id,
                ),
              action:
                item.action,
              packageId:
                item.package_public_id,
              phone:
                item.phone,
              locker:
                item.locker,
              time:
                item.created_at,
            }),
          ),
      });
    } catch (error) {
      console.error(
        'ADMIN HISTORY ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi tải lịch sử.',
        });
    }
  },
);

// ======================================================
// ADMIN - FORCE OPEN (SOFTWARE MODE)
// ======================================================

app.post(
  '/admin/packages/:packageId/force-open',
  authMiddleware,
  (req, res) => {
    try {
      if (
        !requireAdmin(
          req,
          res,
        )
      ) {
        return;
      }

      const packageId =
        String(
          req.params
            .packageId ||
            '',
        ).trim();

      const packageRow =
        db.prepare(`
          SELECT *
          FROM packages
          WHERE public_id = ?
        `).get(
          packageId,
        );

      if (!packageRow) {
        return res
          .status(404)
          .json({
            ok: false,
            message:
              'Không tìm thấy kiện hàng.',
          });
      }

      if (
        packageRow.status !==
        'READY'
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            message:
              'Kiện hàng không còn ở trạng thái chờ lấy.',
          });
      }

      const result =
        db.prepare(`
          UPDATE packages
          SET
            status = 'PICKED_UP',
            picked_up_at = CURRENT_TIMESTAMP,

            pickup_otp = NULL,
            pickup_otp_hash = NULL,
            pickup_otp_enc = NULL,
            pickup_otp_iv = NULL,
            pickup_otp_tag = NULL,
            otp_expires_at = NULL

          WHERE id = ?
            AND status = 'READY'
        `).run(
          packageRow.id,
        );

      if (
        result.changes !==
        1
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            message:
              'Trạng thái kiện hàng vừa thay đổi.',
          });
      }

      addActivityLog({
        eventKey:
          `FORCE_OPEN:${packageRow.public_id}`,
        action:
          'MỞ KHẨN CẤP',
        packageId:
          packageRow.public_id,
        phone:
          packageRow.receiver_phone,
        locker:
          packageRow.locker,
      });

      console.log(
        `⚠️ ADMIN SOFTWARE FORCE OPEN: ${packageRow.locker} | ${packageRow.public_id}`,
      );

      return res.json({
        ok: true,
        hardwareMode: false,
        mode:
          'SOFTWARE',
        locker:
          packageRow.locker,
        message:
          `Mô phỏng mở khẩn cấp tủ ${packageRow.locker} thành công.`,
      });
    } catch (error) {
      console.error(
        'ADMIN FORCE OPEN ERROR:',
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Lỗi server khi mở khẩn cấp.',
        });
    }
  },
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      '====================================',
    );

    console.log(
      '🚀 SmartLocker Backend',
    );

    console.log(
      `✅ http://0.0.0.0:${PORT}`,
    );

    console.log(
      `🔥 Firebase Admin: ${
        firebaseReady
          ? 'READY'
          : 'NOT READY'
      }`,
    );

    console.log(
      `⏱️ OTP TTL: ${OTP_TTL_MINUTES} phút`,
    );

    console.log(
      `☁️ Environment: ${
        process.env.RAILWAY_ENVIRONMENT_NAME ||
        process.env.NODE_ENV ||
        'local'
      }`,
    );

    console.log(
      `💾 Volume: ${
        process.env.RAILWAY_VOLUME_MOUNT_PATH ||
        'LOCAL'
      }`,
    );

    console.log(
      `🚚 Shipper register code: ${
        SHIPPER_REGISTER_CODE
          ? 'READY'
          : 'MISSING'
      }`,
    );

    console.log(
      '✅ Auth + Auto Locker + Secure OTP + Admin + Shipper Auth ready',
    );

    console.log(
      '====================================',
    );
  },
);
